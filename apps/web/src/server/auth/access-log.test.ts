import { logger } from "@polaris/observability/logger";
import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { testUtils } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import { type AuthEmailDelivery, createBetterAuth } from "../auth";
import type { WorkerBindings } from "../environment";
import {
  type AccessLogEntry,
  type AccessLogQueryable,
  createDatabaseAccessLogWriter,
  requestIp,
  requestIpForSessionRow,
} from "./access-log";

const testSecret = "test-only-better-auth-secret-32-bytes";
const testBaseURL = "http://localhost";
const dayMilliseconds = 24 * 60 * 60 * 1000;
const testBindings = {
  BETTER_AUTH_BASE_URL: testBaseURL,
  BETTER_AUTH_SECRET: testSecret,
  HYPERDRIVE: { connectionString: "" },
} as WorkerBindings;

const entry: AccessLogEntry = {
  event: "login_succeeded",
  ip: "203.0.113.7",
  requestId: "req-1",
  userId: "user-1",
};

function loggerSpies() {
  return {
    error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
    warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
  };
}

describe("requestIp", () => {
  it("reads only cf-connecting-ip, whole, and refuses anything that is not an address", () => {
    expect(requestIp(new Headers({ "cf-connecting-ip": "203.0.113.7" }))).toBe(
      "203.0.113.7"
    );
    expect(
      requestIp(new Headers({ "x-forwarded-for": "198.51.100.1" }))
    ).toBeNull();
    expect(
      requestIp(new Headers({ "cf-connecting-ip": "not-an-ip" }))
    ).toBeNull();
    expect(
      requestIp(new Headers({ "cf-connecting-ip": "fe80::1%eth0" }))
    ).toBeNull();
    expect(requestIp(new Headers())).toBeNull();
    expect(requestIp(undefined)).toBeNull();
  });

  it("keeps an IPv6 address whole, while the session row keeps only its /64 network", () => {
    const headers = new Headers({ "cf-connecting-ip": "2001:db8:1:2:3:4:5:6" });
    expect(requestIp(headers)).toBe("2001:0db8:0001:0002:0003:0004:0005:0006");
    expect(requestIpForSessionRow(headers)).toBe(
      "2001:0db8:0001:0002:0000:0000:0000:0000"
    );
  });
});

describe("the database writer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("calls record_auth_access with the entry and says whether it was recorded", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ result: "recorded" }] });
    const write = createDatabaseAccessLogWriter({
      query,
    } as AccessLogQueryable);

    expect(await write(entry)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const config = query.mock.calls[0]?.[0] as {
      query_timeout: number;
      text: string;
      values: unknown[];
    };
    expect(config.text).toContain("public.record_auth_access");
    expect(config.values).toEqual([
      "login_succeeded",
      "user-1",
      "203.0.113.7",
      "req-1",
    ]);
    expect(config.query_timeout).toBe(300);
  });

  it("takes a repeated or throttled session record as handled, without an error", async () => {
    const spies = loggerSpies();
    const answers = await Promise.all(
      ["duplicate", "rate_limited"].map((result) =>
        createDatabaseAccessLogWriter({
          query: vi.fn().mockResolvedValue({ rows: [{ result }] }),
        } as AccessLogQueryable)({ ...entry, event: "session_refreshed" })
      )
    );
    expect(answers).toEqual([true, true]);
    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledWith(
      "auth_access_log_throttled",
      expect.objectContaining({
        accessEvent: "session_refreshed",
        requestId: "req-1",
      })
    );
  });

  it("logs a refused entry by its result code, without the IP or the user, and does not throw", async () => {
    const spies = loggerSpies();
    const write = createDatabaseAccessLogWriter({
      query: vi.fn().mockResolvedValue({ rows: [{ result: "invalid_ip" }] }),
    } as AccessLogQueryable);

    expect(await write(entry)).toBe(false);
    expect(spies.error).toHaveBeenCalledWith(
      "auth_access_log_write_failed",
      expect.objectContaining({
        accessEvent: "login_succeeded",
        reason: "invalid_ip",
        requestId: "req-1",
      })
    );
    const logged = JSON.stringify(spies.error.mock.calls);
    expect(logged).not.toContain("203.0.113.7");
    expect(logged).not.toContain("user-1");
  });

  it("logs a database failure by class and SQLSTATE only, and does not throw", async () => {
    const spies = loggerSpies();
    const failure = Object.assign(
      new Error(
        "permission denied for function record_auth_access (203.0.113.7)"
      ),
      { code: "42501", name: "DatabaseError" }
    );
    const write = createDatabaseAccessLogWriter({
      query: vi.fn().mockRejectedValue(failure),
    } as AccessLogQueryable);

    expect(await write(entry)).toBe(false);
    expect(spies.error).toHaveBeenCalledWith(
      "auth_access_log_write_failed",
      expect.objectContaining({
        errorClass: "DatabaseError",
        reason: "error",
        sqlState: "42501",
      })
    );
    const logged = JSON.stringify(spies.error.mock.calls);
    expect(logged).not.toContain("203.0.113.7");
    expect(logged).not.toContain("permission denied");
  });

  it("gives up after 300 ms when the database does not answer", async () => {
    vi.useFakeTimers();
    const spies = loggerSpies();
    const write = createDatabaseAccessLogWriter({
      query: vi.fn().mockReturnValue(new Promise(() => undefined)),
    } as AccessLogQueryable);

    const pending = write(entry);
    await vi.advanceTimersByTimeAsync(299);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toBe(false);
    expect(spies.error).toHaveBeenCalledWith(
      "auth_access_log_write_failed",
      expect.objectContaining({ reason: "timeout" })
    );
  });

  it("writes nothing and says why when the request has no IP", async () => {
    const spies = loggerSpies();
    const query = vi.fn();
    const write = createDatabaseAccessLogWriter({
      query,
    } as unknown as AccessLogQueryable);

    expect(await write({ ...entry, ip: null })).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledWith(
      "auth_access_log_skipped",
      expect.objectContaining({ reason: "ip_missing", requestId: "req-1" })
    );
    expect(spies.error).not.toHaveBeenCalled();
  });
});

function createAccessLogTestApp(
  options: {
    failWrites?: boolean;
    rejectWrites?: boolean;
    requestId?: string;
  } = {}
) {
  let failuresLeft = 0;
  const entries: AccessLogEntry[] = [];
  const verificationEmails: { token: string; url: string }[] = [];
  const emailDelivery: AuthEmailDelivery = {
    sendPasswordReset: () => Promise.resolve(),
    sendVerificationEmail: ({ token, url }) => {
      verificationEmails.push({ token, url });
      return Promise.resolve();
    },
  };
  const auth = createBetterAuth({
    accessLogWriter: (written) => {
      entries.push(written);
      if (options.rejectWrites) {
        return Promise.reject(new Error("the writer broke"));
      }
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return Promise.resolve(false);
      }
      return Promise.resolve(options.failWrites !== true);
    },
    auditEventWriter: () => Promise.resolve(),
    baseURL: testBaseURL,
    databaseAdapter: memoryAdapter({
      account: [],
      session: [],
      user: [],
      verification: [],
    }),
    emailDelivery,
    plugins: [testUtils() as unknown as BetterAuthPlugin],
    requestId: options.requestId ?? "access-log-test",
    secret: testSecret,
  });
  const app = createServerApp({
    authAbuseProtector: async () => undefined,
    authHandler: (request) => auth.handler(request),
  });
  return {
    app,
    auth,
    entries,
    failNext: (count: number) => {
      failuresLeft = count;
    },
    verificationEmails,
  };
}

type TestApp = ReturnType<typeof createAccessLogTestApp>;

function stubPwnedPasswordRange() {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response(`${"0".repeat(35)}:0\r\n`))
  );
}

function post(app: TestApp["app"], path: string, body: unknown, ip?: string) {
  return app.request(
    path,
    {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        origin: testBaseURL,
        ...(ip ? { "cf-connecting-ip": ip } : {}),
      },
      method: "POST",
    },
    testBindings
  );
}

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

/** A verified user with a password, created through the real routes. */
async function registerUser(test: TestApp, email: string, password: string) {
  stubPwnedPasswordRange();
  const signUp = await post(test.app, "/api/auth/sign-up/email", {
    email,
    name: "Access Log User",
    password,
  });
  expect(signUp.status).toBe(200);
  const verification = test.verificationEmails.at(-1);
  const verify = await test.app.request(
    `${new URL(verification?.url as string).pathname}?token=${encodeURIComponent(verification?.token as string)}`,
    { headers: { origin: testBaseURL } },
    testBindings
  );
  expect(verify.status).toBe(200);
}

describe("the access log in the server of authentication", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const password = "Long passphrase for the access log tests 2026!";

  it("records a login with the IP of cf-connecting-ip and the request ID, then the logout", async () => {
    const test = createAccessLogTestApp({ requestId: "req-login" });
    await registerUser(test, "login@example.invalid", password);
    test.entries.length = 0;

    const login = await post(
      test.app,
      "/api/auth/sign-in/email",
      { email: "login@example.invalid", password },
      "203.0.113.9"
    );
    expect(login.status).toBe(200);
    const body = (await login.json()) as { user: { id: string } };
    expect(test.entries).toEqual([
      {
        event: "login_succeeded",
        ip: "203.0.113.9",
        requestId: "req-login",
        userId: body.user.id,
      },
    ]);

    const logout = await test.app.request(
      "/api/auth/sign-out",
      {
        headers: {
          "cf-connecting-ip": "203.0.113.10",
          cookie: cookiesOf(login),
          origin: testBaseURL,
        },
        method: "POST",
      },
      testBindings
    );
    expect(logout.status).toBe(200);
    expect(test.entries.at(-1)).toEqual({
      event: "logout",
      ip: "203.0.113.10",
      requestId: "req-login",
      userId: body.user.id,
    });
  });

  it("records a failed login without a user, and never the e-mail or the password", async () => {
    const test = createAccessLogTestApp({ requestId: "req-failed" });
    stubPwnedPasswordRange();

    const failed = await post(
      test.app,
      "/api/auth/sign-in/email",
      { email: "nobody@example.invalid", password },
      "198.51.100.4"
    );
    expect(failed.status).not.toBe(200);
    expect(test.entries).toEqual([
      {
        event: "login_failed",
        ip: "198.51.100.4",
        requestId: "req-failed",
        userId: null,
      },
    ]);
    expect(JSON.stringify(test.entries)).not.toContain(
      "nobody@example.invalid"
    );
    expect(JSON.stringify(test.entries)).not.toContain(password);
  });

  it("does not stop a login when the record cannot be written", async () => {
    const test = createAccessLogTestApp({ failWrites: true });
    await registerUser(test, "resilient@example.invalid", password);

    const login = await post(
      test.app,
      "/api/auth/sign-in/email",
      { email: "resilient@example.invalid", password },
      "203.0.113.11"
    );
    expect(login.status).toBe(200);
    expect(cookiesOf(login)).toContain("session_token");
    expect(test.entries.some((item) => item.event === "login_succeeded")).toBe(
      true
    );
  });

  describe("sessions in use", () => {
    async function loggedIn(test: TestApp, ip: string) {
      await registerUser(test, "session@example.invalid", password);
      const login = await post(
        test.app,
        "/api/auth/sign-in/email",
        { email: "session@example.invalid", password },
        ip
      );
      test.entries.length = 0;
      return cookiesOf(login);
    }

    const getSession = (test: TestApp, cookie: string, ip?: string) =>
      test.app.request(
        "/api/auth/get-session?disableCookieCache=true",
        {
          headers: { cookie, ...(ip ? { "cf-connecting-ip": ip } : {}) },
        },
        testBindings
      );

    it("records a refresh once a day, with the IP of that request, and not on every request", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
      const test = createAccessLogTestApp();
      const cookie = await loggedIn(test, "203.0.113.20");

      await getSession(test, cookie, "203.0.113.20");
      await getSession(test, cookie, "203.0.113.20");
      expect(test.entries).toEqual([]);

      vi.setSystemTime(new Date(Date.now() + dayMilliseconds + 1000));
      await getSession(test, cookie, "203.0.113.20");
      await getSession(test, cookie, "203.0.113.20");

      expect(test.entries).toHaveLength(1);
      expect(test.entries[0]).toMatchObject({
        event: "session_refreshed",
        ip: "203.0.113.20",
      });
    });

    it("records a change of IP when it happens, once per new IP, even without a refresh", async () => {
      const test = createAccessLogTestApp();
      const cookie = await loggedIn(test, "203.0.113.20");

      await getSession(test, cookie, "203.0.113.20");
      expect(test.entries).toEqual([]);

      await getSession(test, cookie, "198.51.100.77");
      expect(test.entries).toHaveLength(1);
      expect(test.entries[0]).toMatchObject({
        event: "session_refreshed",
        ip: "198.51.100.77",
      });

      // the session row took the new IP: the same IP again costs nothing
      await getSession(test, cookie, "198.51.100.77");
      expect(test.entries).toHaveLength(1);

      // and going back is a change as well
      await getSession(test, cookie, "203.0.113.20");
      expect(test.entries).toHaveLength(2);
      expect(test.entries[1]).toMatchObject({ ip: "203.0.113.20" });
    });

    it("records a change of IP on the day of a refresh only once", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
      const test = createAccessLogTestApp();
      const cookie = await loggedIn(test, "203.0.113.20");

      vi.setSystemTime(new Date(Date.now() + dayMilliseconds + 1000));
      await getSession(test, cookie, "198.51.100.77");
      await getSession(test, cookie, "198.51.100.77");

      expect(test.entries).toHaveLength(1);
      expect(test.entries[0]).toMatchObject({ ip: "198.51.100.77" });
    });

    it("leaves the session row as it was when the record failed, so the next request tries again", async () => {
      const test = createAccessLogTestApp();
      const cookie = await loggedIn(test, "203.0.113.20");
      const failing = createAccessLogTestApp({ failWrites: true });
      const failingCookie = await loggedIn(failing, "203.0.113.20");

      await getSession(failing, failingCookie, "198.51.100.77");
      await getSession(failing, failingCookie, "198.51.100.77");
      expect(failing.entries).toHaveLength(2);

      await getSession(test, cookie, "198.51.100.77");
      await getSession(test, cookie, "198.51.100.77");
      expect(test.entries).toHaveLength(1);
    });

    it("tries again on the next request when the record of the daily refresh failed", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
      const test = createAccessLogTestApp();
      const cookie = await loggedIn(test, "203.0.113.20");
      const flaky = createAccessLogTestApp();
      const flakyCookie = await loggedIn(flaky, "203.0.113.20");
      flaky.failNext(1);

      vi.setSystemTime(new Date(Date.now() + dayMilliseconds + 1000));
      // the refresh writes (and fails once); the same request finds the row still on the old IP and tries again
      await getSession(flaky, flakyCookie, "198.51.100.77");
      const attempts = flaky.entries.filter(
        (item) => item.ip === "198.51.100.77"
      );
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      // once recorded, the row has the new IP and the next request is quiet
      const before = flaky.entries.length;
      await getSession(flaky, flakyCookie, "198.51.100.77");
      expect(flaky.entries).toHaveLength(before);

      await getSession(test, cookie, "198.51.100.77");
      expect(test.entries).toHaveLength(1);
    });

    it("does not stop a login, a logout or a session read when the writer itself throws", async () => {
      const test = createAccessLogTestApp({ rejectWrites: true });
      await registerUser(test, "throws@example.invalid", password);
      const login = await post(
        test.app,
        "/api/auth/sign-in/email",
        { email: "throws@example.invalid", password },
        "203.0.113.30"
      );
      expect(login.status).toBe(200);
      const cookie = cookiesOf(login);
      const session = await getSession(test, cookie, "198.51.100.31");
      expect(session.status).toBe(200);
      expect(((await session.json()) as { user?: unknown }).user).toBeTruthy();
      const logout = await test.app.request(
        "/api/auth/sign-out",
        {
          headers: {
            "cf-connecting-ip": "203.0.113.30",
            cookie,
            origin: testBaseURL,
          },
          method: "POST",
        },
        testBindings
      );
      expect(logout.status).toBe(200);
    });

    it("records nothing for a request without an IP", async () => {
      const test = createAccessLogTestApp();
      const cookie = await loggedIn(test, "203.0.113.20");

      const response = await getSession(test, cookie);
      expect(response.status).toBe(200);
      expect(test.entries).toEqual([]);
    });
  });
});
