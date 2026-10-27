import { authSchema } from "@polaris/db/auth-schema";
import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { testUtils } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSecurityAuditEvent } from "../auth";
import { createBetterAuth } from "../auth";
import type { AccessLogEntry } from "./access-log";
import { requestIp, requestIpForSessionRow } from "./access-log";
import { SIGN_UP_LEGAL_ACCEPTANCE } from "./legal-acceptance-test-support";

/**
 * What the Polaris relies on from inside Better Auth, written on 1.6.23 before the upgrade to 1.7 and kept as is
 * after it (t435): the schema the Drizzle adapter maps to our tables, the 30-day session and its revocation on
 * sign-out, the IP of the access log (`getIp`), a failing audit write, the order of the `before` and `after` hooks
 * (`runAfterHooks`), `internalAdapter.updateSession` and the fixed `baseURL`. A change of any of them in a new
 * version fails here before it reaches a deploy.
 */

const testSecret = "test-only-better-auth-secret-32-bytes";
const baseURL = "http://localhost";
const hostileOrigin = "https://evil.example.invalid";
const dayMilliseconds = 24 * 60 * 60 * 1000;
const absoluteLifetimeMilliseconds = 30 * dayMilliseconds;
const EXPIRED_COOKIE = /;\s*max-age=0/i;

interface MemoryDatabase extends Record<string, Record<string, unknown>[]> {
  account: Record<string, unknown>[];
  session: Record<string, unknown>[];
  user: Record<string, unknown>[];
  verification: Record<string, unknown>[];
}

interface TestHelpers {
  createUser: (overrides?: Record<string, unknown>) => { id: string };
  login: (options: { userId: string }) => Promise<{
    headers: Headers;
    token: string;
  }>;
  saveUser: (user: { id: string }) => Promise<{ id: string }>;
}

interface HarnessOptions {
  accessLog?: AccessLogEntry[];
  auditEventWriter?: (event: AuthSecurityAuditEvent) => Promise<void>;
}

function createHarness(options: HarnessOptions = {}) {
  const database: MemoryDatabase = {
    account: [],
    session: [],
    user: [],
    verification: [],
  };
  const auditEvents: AuthSecurityAuditEvent[] = [];
  const verificationLinks: string[] = [];
  const { accessLog } = options;
  const auth = createBetterAuth({
    ...(accessLog
      ? {
          accessLogWriter: (entry: AccessLogEntry) => {
            accessLog.push(entry);
            return Promise.resolve(true);
          },
        }
      : {}),
    auditEventWriter:
      options.auditEventWriter ??
      ((event) => {
        auditEvents.push(event);
        return Promise.resolve();
      }),
    baseURL,
    databaseAdapter: memoryAdapter(database),
    emailDelivery: {
      sendPasswordReset: () => Promise.resolve(),
      sendVerificationEmail: ({ url }) => {
        verificationLinks.push(url);
        return Promise.resolve();
      },
    },
    plugins: [testUtils() as unknown as BetterAuthPlugin],
    requestId: "t435-characterization",
    secret: testSecret,
  });

  async function login(email: string) {
    const helpers = ((await auth.$context) as unknown as { test: TestHelpers })
      .test;
    const user = await helpers.saveUser(
      helpers.createUser({ email, emailVerified: true })
    );
    const session = await helpers.login({ userId: user.id });
    return {
      cookie: session.headers.get("cookie") ?? "",
      token: session.token,
      userId: user.id,
    };
  }

  function getSession(cookie: string, headers: Record<string, string> = {}) {
    return auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie, origin: baseURL, ...headers },
      })
    );
  }

  function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ) {
    return auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          origin: baseURL,
          ...headers,
        },
        method: "POST",
      })
    );
  }

  return {
    auditEvents,
    auth,
    database,
    getSession,
    login,
    post,
    verificationLinks,
  };
}

async function sessionTokenOf(response: Response): Promise<string | null> {
  const body = (await response.json()) as {
    session?: { token?: string };
  } | null;
  return body?.session?.token ?? null;
}

function clearsSessionCookie(response: Response): boolean {
  return response.headers
    .getSetCookie()
    .some(
      (value) =>
        value.startsWith("better-auth.session_token=") &&
        EXPIRED_COOKIE.test(value)
    );
}

/** The SQL columns of one of our tables, by the name the Drizzle adapter looks them up with. */
function tableColumns(table: object): Map<
  string,
  {
    hasDefault: boolean;
    name: string;
    notNull: boolean;
  }
> {
  const columns = (table as Record<symbol, unknown>)[
    Symbol.for("drizzle:Columns")
  ] as Record<string, { hasDefault: boolean; name: string; notNull: boolean }>;
  return new Map(Object.entries(columns));
}

describe("Better Auth as the Polaris uses it (characterization, t435)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("schema the Drizzle adapter maps to our tables", () => {
    it("finds a column of ours for every field Better Auth reads or writes, and Better Auth writes every required column", async () => {
      const { auth } = createHarness();
      const { tables } = (await auth.$context) as unknown as {
        tables: Record<
          string,
          {
            fields: Record<string, { fieldName?: string; required?: boolean }>;
            modelName: string;
          }
        >;
      };
      const ours = authSchema as unknown as Record<string, object>;

      expect(Object.keys(tables).sort()).toEqual(
        ["account", "session", "user", "verification"].sort()
      );
      for (const [model, table] of Object.entries(tables)) {
        const columns = tableColumns(ours[table.modelName] ?? {});
        const fieldNames = new Set(
          Object.entries(table.fields).map(
            ([key, field]) => field.fieldName ?? key
          )
        );
        for (const name of fieldNames) {
          expect(columns.has(name), `${model}.${name}`).toBe(true);
        }
        // a NOT NULL column without a default that Better Auth does not write would refuse every insert
        for (const [name, column] of columns) {
          if (column.notNull && !column.hasDefault && name !== "id") {
            expect(fieldNames.has(name), `${model}.${name}`).toBe(true);
          }
        }
      }
    });

    // Since 1.7 the Drizzle adapter checks the schema when an instance starts and logs a mismatch as an error
    // (here, `better_auth_internal_error` on every isolate). The check reads only the Drizzle schema, no connection.
    it("passes the schema check of the Drizzle adapter with the production configuration", async () => {
      const auth = createBetterAuth({
        auditEventWriter: () => Promise.resolve(),
        baseURL,
        database: {} as never,
        secret: testSecret,
      });
      const context = (await auth.$context) as unknown as {
        explicitSchemaCheck?: () => Promise<void>;
      };

      expect(context.explicitSchemaCheck).toBeTypeOf("function");
      await expect(context.explicitSchemaCheck?.()).resolves.toBeUndefined();
    });

    it("keys an account by provider and account ID, the columns account_id and provider_id, with no issuer", async () => {
      const { auth } = createHarness();
      const { tables } = (await auth.$context) as unknown as {
        tables: { account: { fields: Record<string, unknown> } };
      };
      const columns = tableColumns(authSchema.account);

      expect(Object.keys(tables.account.fields)).toEqual(
        expect.arrayContaining(["accountId", "providerId", "userId"])
      );
      expect(Object.keys(tables.account.fields)).not.toContain("issuer");
      expect(Object.keys(tables.account.fields)).not.toContain(
        "providerAccountId"
      );
      expect(columns.get("accountId")?.name).toBe("account_id");
      expect(columns.get("providerId")?.name).toBe("provider_id");
    });
  });

  describe("session of 30 days (ADR 0017) and sign-out", () => {
    it("keeps a session used every day until 30 days, then answers null, deletes the row and clears the cookie", async () => {
      const start = new Date("2026-03-01T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(start);
      const harness = createHarness();
      const { cookie, token } = await harness.login("thirty@example.invalid");

      for (let day = 1; day < 30; day += 1) {
        vi.setSystemTime(new Date(start.getTime() + day * dayMilliseconds));
        // biome-ignore lint/performance/noAwaitInLoops: one day after the other
        expect(await sessionTokenOf(await harness.getSession(cookie))).toBe(
          token
        );
      }
      vi.setSystemTime(
        new Date(start.getTime() + absoluteLifetimeMilliseconds + 1000)
      );
      const past = await harness.getSession(cookie);

      expect(past.status).toBe(200);
      expect(await past.json()).toBeNull();
      expect(clearsSessionCookie(past)).toBe(true);
      expect(harness.database.session.some((row) => row.token === token)).toBe(
        false
      );
    });

    it("revokes the session at once on sign-out and audits the logout with its actor", async () => {
      const harness = createHarness();
      const { cookie, token, userId } = await harness.login(
        "sign-out@example.invalid"
      );
      expect(await sessionTokenOf(await harness.getSession(cookie))).toBe(
        token
      );

      const signOut = await harness.post("/sign-out", {}, { cookie });

      expect(signOut.status).toBe(200);
      expect(clearsSessionCookie(signOut)).toBe(true);
      expect(harness.database.session).toEqual([]);
      expect(await (await harness.getSession(cookie)).json()).toBeNull();
      expect(harness.auditEvents).toContainEqual(
        expect.objectContaining({
          actorId: userId,
          eventType: "logout_succeeded",
        })
      );
    });
  });

  describe("IP of the access log (getIp)", () => {
    const headers = (ip: string) => new Headers({ "cf-connecting-ip": ip });

    it.each([
      ["203.0.113.7", "203.0.113.7", "203.0.113.7"],
      [
        "2001:db8:abcd:12:3456:789a:bcde:f012",
        "2001:0db8:abcd:0012:3456:789a:bcde:f012",
        "2001:0db8:abcd:0012:0000:0000:0000:0000",
      ],
      [
        "2001:DB8::1",
        "2001:0db8:0000:0000:0000:0000:0000:0001",
        "2001:0db8:0000:0000:0000:0000:0000:0000",
      ],
      ["::ffff:203.0.113.7", "203.0.113.7", "203.0.113.7"],
    ])(
      "reads %s whole for the log (%s) and by its network for the session row (%s)",
      (raw, logged, row) => {
        expect(requestIp(headers(raw))).toBe(logged);
        expect(requestIpForSessionRow(headers(raw))).toBe(row);
      }
    );

    it.each([
      "fe80::1%eth0",
      "203.0.113.7, 198.51.100.1",
      "not an address",
      "",
    ])("records no IP for %j", (raw) => {
      expect(requestIp(headers(raw))).toBeNull();
      expect(requestIpForSessionRow(headers(raw))).toBeNull();
    });

    it("never reads X-Forwarded-For", () => {
      const spoofed = new Headers({ "x-forwarded-for": "198.51.100.1" });
      expect(requestIp(spoofed)).toBeNull();
      expect(requestIpForSessionRow(spoofed)).toBeNull();
    });
  });

  describe("hooks: before, after (runAfterHooks) and updateSession", () => {
    it("answers 500 when the audit write of the after hook fails, after the endpoint did its work", async () => {
      const harness = createHarness({
        auditEventWriter: () => Promise.reject(new Error("audit down")),
      });
      const { cookie } = await harness.login("audit-down@example.invalid");

      const signOut = await harness.post("/sign-out", {}, { cookie });

      // a plain Error from an after hook is thrown again by runAfterHooks: the sign-out is done, the answer is an error
      expect(signOut.status).toBe(500);
      expect(harness.database.session).toEqual([]);
    });

    it("runs the before hook ahead of the endpoint: a refused request leaves nothing behind", async () => {
      const harness = createHarness();

      const refused = await harness.post("/sign-up/email", {
        email: "no-acceptance@example.invalid",
        name: "Sem aceite",
        password: "Uma senha longa e segura para o Polaris 2026",
      });

      expect(refused.status).toBe(400);
      expect(harness.database.user).toEqual([]);
      expect(harness.verificationLinks).toEqual([]);
    });

    it("replaces the answer when the after hook returns one, and keeps it when the hook returns nothing", async () => {
      const harness = createHarness();
      const { cookie, token } = await harness.login("after@example.invalid");

      const kept = await harness.getSession(cookie);
      expect(kept.status).toBe(200);
      expect(await sessionTokenOf(kept)).toBe(token);

      const row = harness.database.session.find((item) => item.token === token);
      if (!row) {
        throw new Error("the session of the test was not created");
      }
      row.createdAt = new Date(
        Date.now() - absoluteLifetimeMilliseconds - 1000
      );
      const replaced = await harness.getSession(cookie);

      expect(replaced.status).toBe(200);
      expect(await replaced.json()).toBeNull();
    });

    it("updates the session row by its token through internalAdapter.updateSession", async () => {
      const harness = createHarness();
      const { token } = await harness.login("update-session@example.invalid");
      const context = (await harness.auth.$context) as unknown as {
        internalAdapter: {
          updateSession: (
            sessionToken: string,
            data: { ipAddress: string }
          ) => Promise<{ ipAddress?: string | null } | null>;
        };
      };

      const updated = await context.internalAdapter.updateSession(token, {
        ipAddress: "203.0.113.50",
      });

      expect(updated?.ipAddress).toBe("203.0.113.50");
      expect(
        harness.database.session.find((row) => row.token === token)?.ipAddress
      ).toBe("203.0.113.50");
    });

    it("records a session read from a new IP and moves the row to it", async () => {
      const accessLog: AccessLogEntry[] = [];
      const harness = createHarness({ accessLog });
      const { cookie, token, userId } = await harness.login(
        "new-ip@example.invalid"
      );

      const read = await harness.getSession(cookie, {
        "cf-connecting-ip": "2001:db8:1:2:3:4:5:6",
      });

      expect(await sessionTokenOf(read)).toBe(token);
      expect(accessLog).toContainEqual(
        expect.objectContaining({
          event: "session_refreshed",
          ip: "2001:0db8:0001:0002:0003:0004:0005:0006",
          userId,
        })
      );
      expect(
        harness.database.session.find((row) => row.token === token)?.ipAddress
      ).toBe("2001:0db8:0001:0002:0000:0000:0000:0000");
    });
  });

  describe("fixed baseURL", () => {
    it("keeps the base URL of the configuration whatever Host and X-Forwarded-Host say", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response(`${"0".repeat(35)}:0\r\n`))
      );
      const harness = createHarness();

      const signUp = await harness.post(
        "/sign-up/email",
        {
          email: "host@example.invalid",
          legalAcceptance: SIGN_UP_LEGAL_ACCEPTANCE,
          name: "Host",
          password: "Uma senha longa e segura para o Polaris 2026",
        },
        {
          host: "evil.example.invalid",
          "x-forwarded-host": "evil.example.invalid",
          "x-forwarded-proto": "https",
        }
      );

      expect(signUp.status).toBe(200);
      expect((await harness.auth.$context).baseURL).toBe(`${baseURL}/api/auth`);
      expect(harness.verificationLinks).toHaveLength(1);
      expect(
        harness.verificationLinks[0]?.startsWith(`${baseURL}/api/auth/`)
      ).toBe(true);
    });

    // Better Auth skips its origin check under a test runner (`skipOriginCheck`), so what is pinned here is the
    // list it checks against: the origin of the base URL alone, not the origin a request names.
    it("trusts only the origin of the base URL", async () => {
      const context = (await createHarness().auth.$context) as unknown as {
        isTrustedOrigin: (url: string) => boolean;
        trustedOrigins: string[];
      };

      expect([...new Set(context.trustedOrigins)]).toEqual([baseURL]);
      expect(context.isTrustedOrigin(`${baseURL}/sales`)).toBe(true);
      expect(context.isTrustedOrigin(`${hostileOrigin}/sales`)).toBe(false);
    });
  });
});
