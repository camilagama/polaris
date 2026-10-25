import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { testUtils } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createBetterAuth as CreateBetterAuth } from "../auth";
import type { WorkerBindings } from "../environment";
import type { AccessLogEntry } from "./access-log";
import {
  currentAuthRequestState,
  currentRequestId,
  runWithRequestScope,
} from "./request-database";

const dayMilliseconds = 24 * 60 * 60 * 1000;
const baseURL = "http://localhost";
const CLEARED_COOKIE = /max-age=0/i;
const SQL_TABLE = /from "(session|user)"/;
const SQL_SELECT_LIST = /^select (.*?) from /;
const SQL_QUOTED_NAME = /"(\w+)"/g;

function bindingsWith(secret: string): WorkerBindings {
  return {
    AUTH_HYPERDRIVE: { connectionString: "postgresql://auth.invalid/neondb" },
    BETTER_AUTH_BASE_URL: baseURL,
    BETTER_AUTH_SECRET: secret,
    HYPERDRIVE: { connectionString: "postgresql://tenant.invalid/neondb" },
  } as WorkerBindings;
}

const shared = vi.hoisted(() => ({
  /** The instance each secret gets from `createBetterAuth`, as the handler builds it once per isolate. */
  bySecret: new Map<string, unknown>(),
  /** The statements the request's pool ran, in order (the pool of a request is the one of the test). */
  statements: [] as string[],
}));

// the real handler and the real Better Auth: only the pool of the request is a stand-in
vi.mock("@polaris/db/client", () => ({
  createDatabase: () => ({
    db: {},
    pool: { end: () => Promise.resolve() },
  }),
}));
vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  createBetterAuth: (options: { secret: string }) =>
    shared.bySecret.get(options.secret),
}));

const { enforceAbsoluteSessionLifetime, handleBetterAuthRequest } =
  await import("./handler");
const { createBetterAuth } = await vi.importActual<{
  createBetterAuth: typeof CreateBetterAuth;
}>("../auth");

interface TestAuthHelpers {
  createUser: (overrides?: Record<string, unknown>) => { id: string };
  login: (options: { userId: string }) => Promise<{
    headers: Headers;
    token: string;
  }>;
  saveUser: (user: { id: string }) => Promise<{ id: string }>;
}

function newMemoryAuth(secret: string, accessEntries: AccessLogEntry[]) {
  const auth = createBetterAuth({
    accessLogWriter: (entry) => {
      accessEntries.push(entry);
      return Promise.resolve(true);
    },
    auditEventWriter: () => Promise.resolve(),
    baseURL,
    databaseAdapter: memoryAdapter({
      account: [],
      session: [],
      user: [],
      verification: [],
    }),
    plugins: [testUtils() as unknown as BetterAuthPlugin],
    requestId: currentRequestId,
    requestState: currentAuthRequestState,
    secret,
  });
  shared.bySecret.set(secret, auth);
  return auth;
}

/** A user and a session made outside any request (the memory adapter holds the rows: the scope's database is never read). */
function signedIn(auth: ReturnType<typeof newMemoryAuth>, email: string) {
  return runWithRequestScope(
    { database: {} as never, requestId: "signed-in" },
    async () => {
      const helpers = (
        (await auth.$context) as unknown as { test: TestAuthHelpers }
      ).test;
      const user = await helpers.saveUser(
        helpers.createUser({ email, emailVerified: true })
      );
      const login = await helpers.login({ userId: user.id });
      return { headers: login.headers, token: login.token, user };
    }
  );
}

function getSession(secret: string, headers: Headers, ip?: string) {
  const request = new Headers(headers);
  if (ip) {
    request.set("cf-connecting-ip", ip);
  }
  return handleBetterAuthRequest(
    new Request(`${baseURL}/api/auth/get-session`, { headers: request }),
    bindingsWith(secret),
    "single-read",
    vi.fn()
  );
}

function clearedSessionCookie(response: Response): boolean {
  // the last word on the cookie is the one that counts
  const last = response.headers
    .getSetCookie()
    .filter((cookie) => cookie.includes("session_token="))
    .at(-1);
  return last !== undefined && CLEARED_COOKIE.test(last);
}

describe("the 30-day limit is applied to the one read of GET /api/auth/get-session", () => {
  const secret = "single-read-memory-secret-32-bytes!!";
  const accessEntries: AccessLogEntry[] = [];
  const auth = newMemoryAuth(secret, accessEntries);

  afterEach(() => {
    vi.useRealTimers();
    accessEntries.length = 0;
  });

  it("keeps the session at 30 days less a second and revokes it past 30, answering null with the cookie cleared", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const login = await signedIn(auth, "limit@example.invalid");

    // a refresh every 6 days keeps the idle window open: only the absolute limit is left to end the session
    for (const day of [6, 12, 18, 24]) {
      vi.setSystemTime(new Date(start.getTime() + day * dayMilliseconds));
      // biome-ignore lint/performance/noAwaitInLoops: the clock moves one step at a time
      const active = await getSession(secret, login.headers);
      expect(await active.json()).toMatchObject({
        session: { token: login.token },
      });
    }
    vi.setSystemTime(new Date(start.getTime() + 30 * dayMilliseconds - 1000));
    const stillActive = await getSession(secret, login.headers);
    expect(await stillActive.json()).toMatchObject({
      session: { token: login.token },
    });
    expect(clearedSessionCookie(stillActive)).toBe(false);

    vi.setSystemTime(new Date(start.getTime() + 30 * dayMilliseconds + 1000));
    const expired = await getSession(secret, login.headers);
    expect(expired.status).toBe(200);
    expect(await expired.json()).toBeNull();
    expect(clearedSessionCookie(expired)).toBe(true);

    // revoked, not only hidden: the same cookie finds nothing a minute later
    vi.setSystemTime(new Date(start.getTime() + 30 * dayMilliseconds + 60_000));
    expect(await (await getSession(secret, login.headers)).json()).toBeNull();
  });

  it("records no refresh for a session that the limit revokes in the same request", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const login = await signedIn(auth, "limit-refresh@example.invalid");
    for (const day of [6, 12, 18, 24, 29]) {
      vi.setSystemTime(new Date(start.getTime() + day * dayMilliseconds));
      // biome-ignore lint/performance/noAwaitInLoops: the clock moves one step at a time
      await getSession(secret, login.headers);
    }
    accessEntries.length = 0;

    // 31 days: the daily refresh is due as well, and would extend a session that is about to end
    vi.setSystemTime(new Date(start.getTime() + 31 * dayMilliseconds));
    const expired = await getSession(secret, login.headers, "198.51.100.9");

    expect(await expired.json()).toBeNull();
    expect(accessEntries).toEqual([]);
  });

  it("leaves the daily refresh and the record of the IP as they were inside the limit", async () => {
    const start = new Date("2026-03-01T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const login = await signedIn(auth, "inside-limit@example.invalid");
    await getSession(secret, login.headers, "203.0.113.20");
    accessEntries.length = 0;

    vi.setSystemTime(new Date(start.getTime() + dayMilliseconds + 1000));
    const refreshed = await getSession(secret, login.headers, "203.0.113.20");
    await getSession(secret, login.headers, "203.0.113.20");

    expect(await refreshed.json()).toMatchObject({
      session: { token: login.token },
    });
    expect(accessEntries).toHaveLength(1);
    expect(accessEntries[0]).toMatchObject({
      event: "session_refreshed",
      ip: "203.0.113.20",
    });
  });
});

describe("what a get-session costs the database", () => {
  const secret = "single-read-sql-secret-32-bytes-long!";

  /**
   * A signed cookie from a memory instance with the same secret, and then the same Better Auth on the real Drizzle
   * adapter, over a pool that only records the statements and answers with the one session and user of the test:
   * what counts is how many statements one request sends.
   */
  async function sqlSession() {
    const signer = newMemoryAuth(secret, []);
    const signed = await signedIn(signer, "signer@example.invalid");
    const { createDatabase } =
      await vi.importActual<typeof import("@polaris/db/client")>(
        "@polaris/db/client"
      );
    const { db, pool } = createDatabase("postgresql://sql.invalid/neondb");
    const now = new Date();
    const records: Record<string, Record<string, unknown>> = {
      session: {
        created_at: now,
        expires_at: new Date(now.getTime() + 7 * dayMilliseconds),
        id: "session-1",
        ip_address: null,
        token: signed.token,
        updated_at: now,
        user_agent: null,
        user_id: "user-1",
      },
      user: {
        created_at: now,
        email: "sql@example.invalid",
        email_verified: true,
        id: "user-1",
        image: null,
        name: "Sql",
        updated_at: now,
        verification_link_expires_at: null,
      },
    };
    (pool as unknown as { query: unknown }).query = (config: {
      rowMode?: string;
      text: string;
    }) => {
      shared.statements.push(config.text);
      const table = SQL_TABLE.exec(config.text)?.[1];
      const record = table ? records[table] : undefined;
      const columns = [
        ...(SQL_SELECT_LIST.exec(config.text)?.[1] ?? "").matchAll(
          SQL_QUOTED_NAME
        ),
      ].map((match) => match[1] as string);
      const rows = record ? [columns.map((name) => record[name])] : [];
      return Promise.resolve({ fields: [], rowCount: rows.length, rows });
    };
    shared.bySecret.set(
      secret,
      createBetterAuth({
        accessLogWriter: () => Promise.resolve(true),
        auditEventWriter: () => Promise.resolve(),
        baseURL,
        database: db,
        requestId: currentRequestId,
        requestState: currentAuthRequestState,
        secret,
      })
    );
    return { headers: signed.headers, token: signed.token };
  }

  afterEach(() => {
    shared.statements.length = 0;
  });

  it("is 2 statements, the session and then its user", async () => {
    const { headers } = await sqlSession();
    shared.statements.length = 0;

    const response = await getSession(secret, headers);

    expect(await response.json()).toMatchObject({ user: { id: "user-1" } });
    expect(shared.statements).toHaveLength(2);
  });

  it("was 4 with the read before the route, which is how the other routes still go", async () => {
    const { headers } = await sqlSession();
    const request = () =>
      new Request(`${baseURL}/api/auth/get-session`, { headers });
    const instance = shared.bySecret.get(secret) as ReturnType<
      typeof CreateBetterAuth
    >;
    shared.statements.length = 0;

    await runWithRequestScope(
      { database: {} as never, requestId: "former" },
      async () => {
        await enforceAbsoluteSessionLifetime(instance, request());
        await instance.handler(request());
      }
    );

    expect(shared.statements).toHaveLength(4);
  });
});
