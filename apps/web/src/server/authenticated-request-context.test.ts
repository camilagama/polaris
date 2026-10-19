import type {
  createDatabase as createHyperdriveDatabase,
  DatabaseOptions,
} from "@polaris/db/client";
import { describe, expect, it, vi } from "vitest";
import {
  type AuthenticatedRequestContextDependencies,
  createAuthenticatedRequestContext,
} from "./authenticated-request-context";
import type { WorkerBindings } from "./environment";

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
