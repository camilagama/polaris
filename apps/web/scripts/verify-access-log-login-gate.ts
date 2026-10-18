// biome-ignore-all lint/performance/noAwaitInLoops: a gate runs its probes strictly one at a time, for a clear failure
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "@polaris/db/client";
import { configureLogging } from "@polaris/observability/logger";
import type { BetterAuthPlugin } from "better-auth";
import { testUtils } from "better-auth/plugins";
import {
  disposableHostPattern,
  gateBranchPattern,
  journalMigrationCount,
  poolerPattern,
  redactedFailure,
  requiredEnvironment,
  temporaryRuntimeUrl,
} from "../../../packages/db/scripts/sales-gate-support";
import { type AuthEmailDelivery, createBetterAuth } from "../src/server/auth";

/**
 * The login does not depend on the access log (POL-80, ADR 0092), on a real PostgreSQL 18 with the real Better Auth and
 * the authentication runtime's own role: with the function granted, a login, a failed login and a logout each leave
 * their row with the IP of `cf-connecting-ip`, the user and the request ID; with EXECUTE on `record_auth_access`
 * revoked, the same login answers 200 with its session, writes no row and logs `auth_access_log_write_failed` (request
 * ID, SQLSTATE and class, never the IP or the user); and with the log table locked by another transaction, the login
 * waits at most about 300 ms for the record, answers 200 and logs a timeout.
 */
const expectedDatabase =
  process.env.POLARIS_GATE_DATABASE ??
  process.env.POLARIS_SALES_GATE_DATABASE ??
  "neondb";

const baseURL = "http://localhost";
const secret = randomBytes(32).toString("hex");
const RECORD = "public.record_auth_access(text,text,inet,text)";
const PASSWORD = "Long passphrase for the access log gate 2026!";
const SESSION_COOKIE = /better-auth\.session_token=/;

interface LockClient {
  query: (text: string) => Promise<unknown>;
  release: () => void;
}

interface Captured {
  fields: Record<string, unknown>;
  text: string;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof Request ? input.url : input.href;
}

function captureLogs() {
  const captured: Captured[] = [];
  const originals = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  const wrap =
    (original: (...data: unknown[]) => void) =>
    (...data: unknown[]) => {
      const text = data
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        .join(" ");
      let fields: Record<string, unknown> = {};
      for (const item of data) {
        if (typeof item === "object" && item !== null) {
          fields = item as Record<string, unknown>;
        } else if (typeof item === "string" && item.startsWith("{")) {
          try {
            fields = JSON.parse(item) as Record<string, unknown>;
          } catch {
            // not JSON
          }
        }
      }
      captured.push({ fields, text });
      original(...data);
    };
  console.error = wrap(originals.error);
  console.log = wrap(originals.log);
  console.warn = wrap(originals.warn);
  return {
    captured,
    restore: () => {
      console.error = originals.error;
      console.log = originals.log;
      console.warn = originals.warn;
    },
  };
}

async function run() {
  const branch = requiredEnvironment("POLARIS_SALES_GATE_BRANCH");
  assert.match(branch, gateBranchPattern);
  const adminUrl = requiredEnvironment("POLARIS_SALES_GATE_DATABASE_URL");
  const parsedAdminUrl = new URL(adminUrl);
  assert.match(parsedAdminUrl.hostname, disposableHostPattern);
  assert.doesNotMatch(parsedAdminUrl.hostname, poolerPattern);

  configureLogging({ service: "polaris-access-log-login-gate" });
  const owner = createDatabase(adminUrl, { maxConnections: 2 });
  const logins: [string, string][] = [];
  const tests: string[] = [];
  const closers: (() => Promise<unknown>)[] = [];
  const cleanupFailures: string[] = [];
  const userIds: string[] = [];
  const realFetch = globalThis.fetch;
  let revoked = false;
  let lockClient: LockClient | undefined;
  let primaryFailure = false;
  const logs = captureLogs();

  try {
    const server = await owner.pool.query<{
      database_name: string;
      server_version: string;
      server_version_num: string;
    }>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num"
    );
    const [serverRow] = server.rows;
    assert.ok(serverRow);
    assert.equal(serverRow.database_name, expectedDatabase);
    assert.ok(Number(serverRow.server_version_num) >= 180_000);
    const migrations = await owner.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations"
    );
    assert.equal(Number(migrations.rows[0]?.count), journalMigrationCount());
    tests.push(
      "disposable direct connection is PostgreSQL 18 with every migration replayed from scratch"
    );

    const role = `polaris_alogin_auth_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(24).toString("hex");
    await owner.pool.query(
      `CREATE ROLE "${role}" WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`
    );
    await owner.pool.query(`GRANT polaris_auth_runtime TO "${role}"`);
    logins.push([role, "polaris_auth_runtime"]);
    const authUrl = temporaryRuntimeUrl(adminUrl, role, password);

    // the HIBP range lookup of the password policy is the only outbound call: answered locally
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith("https://api.pwnedpasswords.com/range/")) {
        return Promise.resolve(new Response(`${"0".repeat(35)}:0\r\n`));
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const verificationEmails: { token: string; url: string }[] = [];
    const emailDelivery: AuthEmailDelivery = {
      sendPasswordReset: () => Promise.resolve(),
      sendVerificationEmail: ({ token, url }) => {
        verificationEmails.push({ token, url });
        return Promise.resolve();
      },
    };
    // one Better Auth, as the handler builds one per request: its own pool of one connection, the authentication role
    const newAuth = (requestId: string) => {
      const database = createDatabase(authUrl, { maxConnections: 1 });
      const auth = createBetterAuth({
        baseURL,
        database: database.db,
        emailDelivery,
        plugins: [testUtils() as unknown as BetterAuthPlugin],
        requestId,
        secret,
      });
      return { auth, close: () => database.pool.end() };
    };
    const call = async (
      requestId: string,
      path: string,
      init: RequestInit & { ip?: string }
    ) => {
      const { auth, close } = newAuth(requestId);
      try {
        const { ip, ...requestInit } = init;
        const headers = new Headers(requestInit.headers);
        headers.set("origin", baseURL);
        if (ip) {
          headers.set("cf-connecting-ip", ip);
        }
        return await auth.handler(
          new Request(`${baseURL}${path}`, { ...requestInit, headers })
        );
      } finally {
        await close();
      }
    };
    const json = (body: unknown): RequestInit => ({
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const suffix = randomUUID().slice(0, 8);
    const email = `access-log-${suffix}@example.invalid`;
    // four hex digits, the first never zero: PostgreSQL prints the address without leading zeros
    const block = (
      0x10_00 +
      (randomBytes(2).readUInt16BE() % 0xf0_00)
    ).toString(16);
    const ipOf = (n: number) => `2001:db8:${block}::${n}`;
    const requestOf = (n: number) => `alogin-${suffix}-${n}`;

    // a verified user with a password, through the real routes (no access log involved: no IP header)
    const signUp = await call(
      requestOf(0),
      "/api/auth/sign-up/email",
      json({ email, name: "Access Log Gate", password: PASSWORD })
    );
    assert.equal(signUp.status, 200);
    const userId = (
      await owner.pool.query<{ id: string }>(
        'SELECT id FROM public."user" WHERE email = $1',
        [email]
      )
    ).rows[0]?.id;
    assert.ok(userId);
    userIds.push(userId);
    const verification = verificationEmails.at(-1);
    assert.ok(verification);
    const verify = await call(
      requestOf(0),
      `${new URL(verification.url).pathname}?token=${encodeURIComponent(verification.token)}`,
      { method: "GET" }
    );
    assert.equal(verify.status, 200);

    const rowsOf = async (requestId: string) =>
      (
        await owner.pool.query<{
          event: string;
          ip: string;
          user_id: string | null;
        }>(
          "SELECT event, host(ip) AS ip, user_id FROM public.auth_access_log WHERE request_id = $1 ORDER BY id",
          [requestId]
        )
      ).rows;

    // ------------------------------------------------- the function granted
    const login = await call(requestOf(1), "/api/auth/sign-in/email", {
      ...json({ email, password: PASSWORD }),
      ip: ipOf(1),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.match(cookie, SESSION_COOKIE);
    assert.deepEqual(await rowsOf(requestOf(1)), [
      {
        event: "login_succeeded",
        ip: ipOf(1),
        user_id: userId,
      },
    ]);
    const failed = await call(requestOf(2), "/api/auth/sign-in/email", {
      ...json({ email, password: `${PASSWORD} wrong` }),
      ip: ipOf(2),
    });
    assert.notEqual(failed.status, 200);
    assert.deepEqual(await rowsOf(requestOf(2)), [
      {
        event: "login_failed",
        ip: ipOf(2),
        user_id: null,
      },
    ]);
    const logout = await call(requestOf(3), "/api/auth/sign-out", {
      headers: { cookie },
      ip: ipOf(3),
      method: "POST",
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await rowsOf(requestOf(3)), [
      {
        event: "logout",
        ip: ipOf(3),
        user_id: userId,
      },
    ]);
    const stored = (
      await owner.pool.query<{ text: string }>(
        "SELECT row_to_json(log)::text AS text FROM public.auth_access_log log WHERE request_id LIKE $1",
        [`alogin-${suffix}-%`]
      )
    ).rows
      .map((row) => row.text)
      .join("\n");
    for (const secretValue of [PASSWORD, email, "wrong", secret]) {
      assert.equal(stored.includes(secretValue), false, "no secret in a row");
    }
    tests.push(
      "with the function granted, a real login, a failed login (no user, no e-mail, no password) and a logout each leave one row with the IP of cf-connecting-ip (the whole IPv6 address), the user and the request ID, through the authentication role alone"
    );

    // ------------------------------------------------- EXECUTE revoked: the login goes on
    await owner.pool.query(
      `REVOKE EXECUTE ON FUNCTION ${RECORD} FROM polaris_auth_runtime`
    );
    revoked = true;
    const sizeBefore = logs.captured.length;
    const resilient = await call(requestOf(4), "/api/auth/sign-in/email", {
      ...json({ email, password: PASSWORD }),
      ip: ipOf(4),
    });
    assert.equal(resilient.status, 200, "the login answers 200");
    const resilientCookie = resilient.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.match(resilientCookie, SESSION_COOKIE, "and gives its session");
    // the session is real: another request reads it
    const session = await call(requestOf(5), "/api/auth/get-session", {
      headers: { cookie: resilientCookie },
      method: "GET",
    });
    assert.equal(session.status, 200);
    assert.equal(
      ((await session.json()) as { user?: { id?: string } } | null)?.user?.id,
      userId
    );
    assert.deepEqual(await rowsOf(requestOf(4)), [], "no row was written");
    const failures = logs.captured
      .slice(sizeBefore)
      .filter((entry) => entry.text.includes("auth_access_log_write_failed"));
    assert.ok(failures.length >= 1, "the failure is logged");
    const [failure] = failures;
    assert.equal(failure?.fields.requestId, requestOf(4));
    assert.equal(failure?.fields.sqlState, "42501");
    assert.equal(failure?.fields.reason, "error");
    assert.equal(failure?.fields.accessEvent, "login_succeeded");
    for (const entry of failures) {
      assert.equal(
        entry.text.includes(`2001:db8:${block}`),
        false,
        "no IP in the log"
      );
      assert.equal(entry.text.includes(userId), false, "no user in the log");
      assert.equal(entry.text.includes(email), false, "no e-mail in the log");
    }
    // a logout and a failed login go on as well
    const logoutRevoked = await call(requestOf(6), "/api/auth/sign-out", {
      headers: { cookie: resilientCookie },
      ip: ipOf(6),
      method: "POST",
    });
    assert.equal(logoutRevoked.status, 200);
    const failedRevoked = await call(requestOf(7), "/api/auth/sign-in/email", {
      ...json({ email, password: `${PASSWORD} wrong` }),
      ip: ipOf(7),
    });
    assert.equal(failedRevoked.status, 401);
    await owner.pool.query(
      `GRANT EXECUTE ON FUNCTION ${RECORD} TO polaris_auth_runtime`
    );
    revoked = false;
    tests.push(
      "with EXECUTE on record_auth_access revoked from the authentication role, the same login answers 200 and gives a session another request reads, writes no row and logs auth_access_log_write_failed with the request ID, SQLSTATE 42501 and the event, with no IP, user or e-mail in the log; the logout and the failed login answer as they did"
    );

    // ------------------------------------------------- the table locked: the login waits 300 ms at most
    lockClient = await owner.pool.connect();
    await lockClient.query("BEGIN");
    await lockClient.query(
      "LOCK TABLE public.auth_access_log IN ACCESS EXCLUSIVE MODE"
    );
    const slowBefore = logs.captured.length;
    const started = Date.now();
    const slow = await call(requestOf(8), "/api/auth/sign-in/email", {
      ...json({ email, password: PASSWORD }),
      ip: ipOf(8),
    });
    const elapsed = Date.now() - started;
    assert.equal(
      slow.status,
      200,
      "the login answers 200 with the table locked"
    );
    assert.match(
      slow.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
      SESSION_COOKIE
    );
    const waited = logs.captured
      .slice(slowBefore)
      .filter((entry) => entry.text.includes("auth_access_log_write_failed"));
    assert.ok(waited.length >= 1);
    assert.equal(waited[0]?.fields.reason, "timeout");
    assert.equal(waited[0]?.fields.requestId, requestOf(8));
    // the login's own cost (hashing, the database) plus 300 ms: far from a lock that never ends
    assert.ok(elapsed < 5000, `the login waited ${elapsed} ms`);
    await lockClient.query("ROLLBACK");
    lockClient.release();
    lockClient = undefined;
    // the statement was already on the server, waiting for the lock: it may still land once the lock is gone (a late
    // record is better than none), and never twice
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(
      (await rowsOf(requestOf(8))).length <= 1,
      "a timed-out write lands at most once"
    );
    assert.equal(
      (await rowsOf(requestOf(8)))[0]?.event ?? "login_succeeded",
      "login_succeeded"
    );
    tests.push(
      "with the log table locked by another transaction, the login answers 200 with its session, gives up on the record after 300 ms and logs auth_access_log_write_failed with the reason timeout (the login took well under the 5 s of a lock that never ends); the statement was already on the server, so it may still land when the lock goes, once and never twice"
    );

    console.log(
      JSON.stringify(
        {
          branch,
          database: serverRow.database_name,
          serverVersion: serverRow.server_version,
          status: "passed",
          tests,
        },
        null,
        2
      )
    );
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    logs.restore();
    globalThis.fetch = realFetch;
    if (lockClient) {
      await lockClient.query("ROLLBACK").catch(() => undefined);
      lockClient.release();
    }
    for (const close of closers.reverse()) {
      await close().catch(() => undefined);
    }
    const cleanup = async (
      label: string,
      text: string,
      values: unknown[] = []
    ) => {
      try {
        await owner.pool.query(text, values);
      } catch (error) {
        cleanupFailures.push(`${label} (${redactedFailure(error)})`);
      }
    };
    if (revoked) {
      await cleanup(
        "restore execute",
        `GRANT EXECUTE ON FUNCTION ${RECORD} TO polaris_auth_runtime`
      );
    }
    // test teardown (owner): the throwaway user, its account and sessions; the access log rows stay (append-only)
    for (const id of userIds) {
      await cleanup("user", 'DELETE FROM public."user" WHERE id = $1', [id]);
    }
    for (const [role, group] of logins) {
      await cleanup("revoke", `REVOKE "${group}" FROM "${role}"`);
      await cleanup("role", `DROP ROLE IF EXISTS "${role}"`);
    }
    await owner.pool.end();
    if (cleanupFailures.length > 0) {
      console.error(
        `Access log login gate cleanup failed: ${cleanupFailures.join("; ")}`
      );
      if (!primaryFailure) {
        process.exitCode = 1;
      }
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `Access log login PostgreSQL gate failed (${redactedFailure(error)})`
  );
  process.exitCode = 1;
});
