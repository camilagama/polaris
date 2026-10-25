import type {
  createDatabase as createHyperdriveDatabase,
  DatabaseOptions,
} from "@polaris/db/client";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  type AuthenticatedRequestContextDependencies,
  createAuthenticatedRequestContext,
} from "./authenticated-request-context";
import type { ServerEnv, WorkerBindings } from "./environment";
import { requestIdMiddleware } from "./middleware/request-id";

const baseBindings = {
  AUTH_HYPERDRIVE: { connectionString: "postgresql://auth.invalid/neondb" },
  BETTER_AUTH_BASE_URL: "https://polaris.example.invalid",
  BETTER_AUTH_SECRET: "a".repeat(32),
  HYPERDRIVE: { connectionString: "postgresql://test.invalid/neondb" },
} satisfies WorkerBindings;

function contextWithDatabaseSpy(
  session: unknown = {
    session: { createdAt: new Date(), id: "session-1" },
    user: { id: "test-user" },
  }
) {
  const db = {} as ReturnType<typeof createHyperdriveDatabase>["db"];
  const endPool = vi.fn(async () => undefined);
  const createDatabase = vi.fn(
    (_connectionString: string, _options?: DatabaseOptions) => ({
      db,
      pool: { end: endPool } as unknown as ReturnType<
        typeof createHyperdriveDatabase
      >["pool"],
    })
  );
  const createAuth = vi.fn(() => ({
    api: {
      getSession: vi.fn(async () => session),
    },
  }));
  const run = createAuthenticatedRequestContext({
    createAuth:
      createAuth as unknown as AuthenticatedRequestContextDependencies["createAuth"],
    createDatabase:
      createDatabase as unknown as AuthenticatedRequestContextDependencies["createDatabase"],
  });

  return { createDatabase, endPool, run };
}

describe("Better Auth once per isolate", () => {
  function isolateWithTwoPools() {
    const databases: { db: object; pool: { end: () => Promise<void> } }[] = [];
    const createDatabase = vi.fn(() => {
      const created = {
        db: { id: databases.length },
        pool: { end: vi.fn(() => Promise.resolve()) },
      };
      databases.push(created);
      return created;
    });
    const seen: { database: unknown; id: unknown; requestId: string }[] = [];
    const createAuth = vi.fn(
      (
        options: Parameters<
          AuthenticatedRequestContextDependencies["createAuth"]
        >[0]
      ) => ({
        api: {
          getSession: vi.fn(() => {
            seen.push({
              database: options.database,
              id: (options.database as unknown as { id: unknown }).id,
              requestId: options.requestId(),
            });
            return Promise.resolve({
              session: { createdAt: new Date(), id: "session-1" },
              user: { id: "test-user" },
            });
          }),
        },
      })
    );
    const run = createAuthenticatedRequestContext({
      createAuth:
        createAuth as unknown as AuthenticatedRequestContextDependencies["createAuth"],
      createDatabase:
        createDatabase as unknown as AuthenticatedRequestContextDependencies["createDatabase"],
    });
    const request = (bindings: WorkerBindings = baseBindings) =>
      run({
        bindings,
        operation: async (database) => database,
        request: new Request("https://polaris.example.invalid/rpc"),
      });
    return { createAuth, databases, request, seen };
  }

  it("builds the instance once for many requests", async () => {
    const { createAuth, request } = isolateWithTwoPools();

    await request();
    await request();
    await request();

    expect(createAuth).toHaveBeenCalledTimes(1);
  });

  it("gives each request its own pool and database, and keeps none of them afterwards", async () => {
    const { databases, request, seen } = isolateWithTwoPools();

    const first = await request();
    const second = await request();

    // two pools per request (authentication and tenant), none shared between requests
    expect(databases).toHaveLength(4);
    expect(new Set(databases.map(({ pool }) => pool)).size).toBe(4);
    expect(new Set(databases.map(({ db }) => db)).size).toBe(4);
    expect(first).not.toBe(second);
    // the instance read the authentication database of each request, not the first one
    expect(seen.map(({ id }) => id)).toEqual([0, 2]);
    expect(new Set(seen.map(({ requestId }) => requestId)).size).toBe(2);
    // what the instance holds is a forwarder with no database of its own outside a request
    expect(seen[0]?.database).toBe(seen[1]?.database);
    expect(
      () => (seen[0]?.database as { id: unknown } | undefined)?.id
    ).toThrow("request_database_unavailable");
  });

  it("reads the session with the identifier of the request, so its record of access points at it", async () => {
    const { request, seen } = isolateWithTwoPools();
    const app = new Hono<ServerEnv>();
    app.use("*", requestIdMiddleware);
    app.post("/rpc", async (context) => {
      await request();
      return context.body(null, 204);
    });

    const response = await app.request("/rpc", { method: "POST" });

    expect(seen[0]?.requestId).toBe(response.headers.get("X-Request-Id"));
  });

  it("runs the real Better Auth through the forwarder: no cookie is a missing session, with no connection opened", async () => {
    const run = createAuthenticatedRequestContext();
    const attempt = () =>
      run({
        bindings: baseBindings,
        operation: async () => "unreachable",
        request: new Request("https://polaris.example.invalid/rpc"),
      });

    await expect(attempt()).rejects.toMatchObject({ code: "session_required" });
    await expect(attempt()).rejects.toMatchObject({ code: "session_required" });
  });

  it("builds another instance when the configuration changes", async () => {
    const { createAuth, request } = isolateWithTwoPools();

    await request();
    await request({ ...baseBindings, BETTER_AUTH_SECRET: "b".repeat(32) });

    expect(createAuth).toHaveBeenCalledTimes(2);
  });
});

describe("authenticated request database connection", () => {
  it("allows a longer local Hyperdrive-emulation timeout when configured", async () => {
    const {
      createDatabase: createDatabaseSpy,
      endPool,
      run,
    } = contextWithDatabaseSpy();
    const bindings = {
      ...baseBindings,
      AUTH_DATABASE_CONNECT_TIMEOUT_MS: "30000",
    };

    await expect(
      run({
        bindings,
        operation: async () => "ok",
        request: new Request("https://polaris.example.invalid/rpc"),
      })
    ).resolves.toBe("ok");

    expect(createDatabaseSpy).toHaveBeenCalledWith(
      baseBindings.HYPERDRIVE.connectionString,
      { connectionTimeoutMillis: 30_000, maxConnections: 1 }
    );
    expect(createDatabaseSpy).toHaveBeenNthCalledWith(
      1,
      baseBindings.AUTH_HYPERDRIVE.connectionString,
      { connectionTimeoutMillis: 30_000, maxConnections: 1 }
    );
    expect(endPool).toHaveBeenCalledTimes(2);
  });

  it("leaves the database helper default unchanged when unset", async () => {
    const { createDatabase: createDatabaseSpy, run } = contextWithDatabaseSpy();

    await run({
      bindings: baseBindings,
      operation: async () => "ok",
      request: new Request("https://polaris.example.invalid/rpc"),
    });

    expect(createDatabaseSpy).toHaveBeenCalledWith(
      baseBindings.HYPERDRIVE.connectionString,
      { maxConnections: 1 }
    );
  });

  it("rejects a session without an id, running no operation", async () => {
    const { run } = contextWithDatabaseSpy({
      session: { createdAt: new Date() },
      user: { id: "test-user" },
    });
    const operation = vi.fn(async () => "ok");

    await expect(
      run({
        bindings: baseBindings,
        operation,
        request: new Request("https://polaris.example.invalid/rpc"),
      })
    ).rejects.toMatchObject({ code: "session_required" });
    expect(operation).not.toHaveBeenCalled();
  });
});
