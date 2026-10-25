import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../environment";

interface FakeDatabase {
  name: string;
}

interface CapturedOptions {
  database: FakeDatabase;
  requestId: () => string;
  runInBackground: (task: Promise<unknown>) => void;
}

const fake = vi.hoisted(() => ({
  /** What each request's Better Auth call saw through the shared instance. */
  calls: [] as { database: string; requestId: string }[],
  databases: 0,
  /** What the request's own `getSession` answers; a throw stands for a failed start of the instance. */
  getSession: (() => Promise.resolve(null)) as () => Promise<unknown>,
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
    api: {
      getSession: () => fake.getSession(),
    },
    handler: () => {
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
      return Promise.resolve(Response.json(null));
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
    fake.calls.length = 0;
    fake.ranInBackground.length = 0;
    fake.holdBackground = undefined;
    fake.getSession = () => Promise.resolve(null);
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

  it("is built again after a failure, so a failed start is not kept for the life of the isolate", async () => {
    await getSession("warm", vi.fn());
    const built = createBetterAuth.mock.calls.length;
    fake.getSession = () => Promise.reject(new Error("the start failed"));

    await expect(getSession("failed", vi.fn())).rejects.toThrow(
      "the start failed"
    );
    fake.getSession = () => Promise.resolve(null);
    await getSession("after", vi.fn());

    expect(createBetterAuth.mock.calls.length).toBe(built + 1);
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
