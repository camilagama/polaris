import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../environment";
import {
  currentAuthRequestState,
  currentRequestId,
  runInRequestBackground,
} from "./request-database";

interface FakeDatabase {
  name: string;
}

interface CapturedOptions {
  database: FakeDatabase;
  emailDelivery?: unknown;
  googleProvider?: { clientId: string };
  requestId: () => string;
  requestState?: unknown;
  runInBackground: (task: Promise<unknown>) => void;
}

const fake = vi.hoisted(() => ({
  /** How many times a route read the session through `api.getSession` before its own handler. */
  apiReads: 0,
  /** What each request's Better Auth call saw through the shared instance. */
  calls: [] as { database: string; requestId: string }[],
  databases: 0,
  /**
   * What the one session read of `/get-session` answers: the handler makes it (the absolute limit is applied by a hook
   * on that read, so no `api.getSession` runs before it).
   */
  getSession: (() => Promise.resolve(null)) as () => Promise<unknown>,
  /** Whether the next instance fails to start (its `$context` rejects, as Better Auth's does). */
  startFails: false,
  /** The background task the next request leaves, and what it saw when it ran. */
  holdBackground: undefined as Promise<void> | undefined,
  ranInBackground: [] as { database: string; requestId: string }[],
}));

vi.mock("@polaris/db/client", () => ({
  createDatabase: () => {
    fake.databases += 1;
    return {
      db: { name: `database-${fake.databases}` },
      pool: { end: () => Promise.resolve() },
    };
  },
}));

const createBetterAuth = vi.hoisted(() =>
  vi.fn((options: CapturedOptions) => ({
    $context: fake.startFails
      ? Promise.reject(new Error("the start failed"))
      : Promise.resolve({}),
    api: {
      getSession: () => {
        fake.apiReads += 1;
        return fake.getSession();
      },
    },
    handler: async () => {
      await fake.getSession();
      // read through the instance at the time of the call, as Better Auth's adapter and hooks do
      fake.calls.push({
        database: options.database.name,
        requestId: options.requestId(),
      });
      const hold = fake.holdBackground;
      if (hold) {
        options.runInBackground(
          hold.then(() => {
            fake.ranInBackground.push({
              database: options.database.name,
              requestId: options.requestId(),
            });
          })
        );
      }
      return Response.json(null);
    },
  }))
);

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  createBetterAuth,
}));

const { handleBetterAuthRequest } = await import("./handler");

const bindings: WorkerBindings = {
  AUTH_HYPERDRIVE: { connectionString: "postgresql://auth.invalid/neondb" },
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://tenant.invalid/neondb" },
};

function getSession(
  requestId: string,
  waitUntil: (task: Promise<unknown>) => void,
  withBindings: WorkerBindings = bindings
) {
  return handleBetterAuthRequest(
    new Request("https://polaris.example.invalid/api/auth/get-session"),
    withBindings,
    requestId,
    waitUntil
  );
}

describe("the /api/auth/* routes share one Better Auth per isolate", () => {
  afterEach(() => {
    fake.apiReads = 0;
    fake.calls.length = 0;
    fake.ranInBackground.length = 0;
    fake.holdBackground = undefined;
    fake.getSession = () => Promise.resolve(null);
    fake.startFails = false;
  });

  const lastOptions = () =>
    createBetterAuth.mock.calls.at(-1)?.[0] as CapturedOptions;

  it("reads the identifier, the background and the state of the hooks from the request scope", async () => {
    await getSession("wired", vi.fn(), {
      ...bindings,
      BETTER_AUTH_SECRET: "w".repeat(32),
    });

    const options = lastOptions();
    expect(options.requestId).toBe(currentRequestId);
    expect(options.requestState).toBe(currentAuthRequestState);
    expect(options.runInBackground).toBe(runInRequestBackground);
  });

  it("builds it once and gives each request its own database and its own waitUntil", async () => {
    let releaseFirst = () => undefined as unknown;
    fake.holdBackground = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const waitUntilOne = vi.fn();
    const waitUntilTwo = vi.fn();

    await getSession("request-one", waitUntilOne);
    const built = createBetterAuth.mock.calls.length;
    fake.holdBackground = undefined;
    await getSession("request-two", waitUntilTwo);

    expect(createBetterAuth.mock.calls.length).toBe(built);
    const [first, second] = fake.calls;
    expect(first?.requestId).toBe("request-one");
    expect(second?.requestId).toBe("request-two");
    expect(first?.database).not.toBe(second?.database);
    // the task of the first request, and the end of its pool after it, went to the first request's waitUntil only
    expect(waitUntilOne).toHaveBeenCalled();
    expect(waitUntilTwo).not.toHaveBeenCalled();

    // the first request's task runs after the second request: it still writes with the first request
    releaseFirst();
    await Promise.all(waitUntilOne.mock.calls.map(([task]) => task));
    expect(fake.ranInBackground).toEqual([
      { database: first?.database, requestId: "request-one" },
    ]);
  });

  it("reads the session once for /get-session, and once before any other route", async () => {
    await getSession("get-session", vi.fn());
    expect(fake.apiReads).toBe(0);
    expect(fake.calls).toHaveLength(1);

    await handleBetterAuthRequest(
      new Request("https://polaris.example.invalid/api/auth/list-sessions"),
      bindings,
      "list-sessions",
      vi.fn()
    );
    expect(fake.apiReads).toBe(1);
    expect(fake.calls).toHaveLength(2);

    // only the GET of /get-session is the read itself: a POST of it keeps the read before
    await handleBetterAuthRequest(
      new Request("https://polaris.example.invalid/api/auth/get-session", {
        method: "POST",
      }),
      bindings,
      "post-get-session",
      vi.fn()
    );
    expect(fake.apiReads).toBe(2);
  });

  it("is the same instance for the next request, and a new one when the secret changes", async () => {
    await getSession("warm", vi.fn());
    const built = createBetterAuth.mock.calls.length;

    await getSession("same", vi.fn());
    expect(createBetterAuth.mock.calls.length).toBe(built);

    await getSession("rotated", vi.fn(), {
      ...bindings,
      BETTER_AUTH_SECRET: "b".repeat(32),
    });
    expect(createBetterAuth.mock.calls.length).toBe(built + 1);
  });

  it("is built again after a failed start, and kept after any other failure", async () => {
    fake.startFails = true;
    fake.getSession = () => Promise.reject(new Error("the start failed"));
    const rotated = { ...bindings, BETTER_AUTH_SECRET: "f".repeat(32) };
    await expect(getSession("failed-start", vi.fn(), rotated)).rejects.toThrow(
      "the start failed"
    );
    const built = createBetterAuth.mock.calls.length;
    fake.startFails = false;
    fake.getSession = () => Promise.resolve(null);

    await getSession("after-start", vi.fn(), rotated);
    expect(createBetterAuth.mock.calls.length).toBe(built + 1);

    // the database went down: the instance started fine, so it stays
    fake.getSession = () => Promise.reject(new Error("the database is down"));
    await expect(getSession("outage", vi.fn(), rotated)).rejects.toThrow(
      "the database is down"
    );
    fake.getSession = () => Promise.resolve(null);
    await getSession("after-outage", vi.fn(), rotated);
    expect(createBetterAuth.mock.calls.length).toBe(built + 1);
  });

  it.each([
    ["the base URL", { BETTER_AUTH_BASE_URL: "https://other.example.invalid" }],
    ["the Google client", { GOOGLE_CLIENT_ID: "other-client" }],
    ["the Google secret", { GOOGLE_CLIENT_SECRET: "other-secret" }],
    [
      "the password switch",
      {
        AUTH_EMAIL_FROM: "Polaris <no-reply@example.invalid>",
        EMAIL_PASSWORD_AUTH_ENABLED: "true",
        RESEND_API_KEY: "re_test_only",
      },
    ],
  ])("is built again when %s changes", async (_name, change) => {
    const google = {
      ...bindings,
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
    };
    await getSession("before-change", vi.fn(), google);
    const built = createBetterAuth.mock.calls.length;

    await getSession("after-change", vi.fn(), { ...google, ...change });

    expect(createBetterAuth.mock.calls.length).toBe(built + 1);
  });

  it("gives the instance the e-mails and Google only when the environment has them", async () => {
    await getSession("plain", vi.fn(), {
      ...bindings,
      BETTER_AUTH_SECRET: "p".repeat(32),
    });
    expect(lastOptions().emailDelivery).toBeUndefined();
    expect(lastOptions().googleProvider).toBeUndefined();

    await getSession("full", vi.fn(), {
      ...bindings,
      AUTH_EMAIL_FROM: "Polaris <no-reply@example.invalid>",
      BETTER_AUTH_SECRET: "p".repeat(32),
      EMAIL_PASSWORD_AUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
      RESEND_API_KEY: "re_test_only",
    });
    expect(lastOptions().emailDelivery).toBeDefined();
    expect(lastOptions().googleProvider?.clientId).toBe("client");
  });

  it("keys the instance on the environment, never on the request", async () => {
    await getSession("warm", vi.fn());
    const built = createBetterAuth.mock.calls.length;

    await handleBetterAuthRequest(
      new Request("https://polaris.example.invalid/api/auth/get-session", {
        headers: {
          cookie: "better-auth.session_token=other",
          host: "attacker.example.invalid",
          origin: "https://attacker.example.invalid",
        },
      }),
      bindings,
      "other-request",
      vi.fn()
    );

    expect(createBetterAuth.mock.calls.length).toBe(built);
  });
});
