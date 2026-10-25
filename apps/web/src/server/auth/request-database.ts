import { AsyncLocalStorage } from "node:async_hooks";
import type { createDatabase } from "@polaris/db/client";

type Database = ReturnType<typeof createDatabase>["db"];

interface RequestScope {
  database: Database;
  requestId: string;
}

/**
 * The Better Auth instance of the RPC context is built once per isolate (ADR 0017, emenda de 24/10/2026), so it
 * cannot hold the `db` of any request: a `Pool` is an I/O object of the request that opened it, and the
 * runtime refuses to reuse it from another one. What the instance holds is `requestScopedDatabase`, which
 * resolves the `db` of the running request from this storage at each call, and nothing else. Outside
 * `runWithRequestScope` it has no `db` and throws, so a call that escapes the request fails closed.
 */
const storage = new AsyncLocalStorage<RequestScope>();

export function runWithRequestScope<T>(
  scope: RequestScope,
  run: () => Promise<T>
): Promise<T> {
  return storage.run(scope, run);
}

function currentRequestScope(): RequestScope {
  const scope = storage.getStore();
  if (!scope) {
    throw new Error("request_database_unavailable");
  }
  return scope;
}

export function currentRequestId(): string {
  return currentRequestScope().requestId;
}

/** A `db` that forwards every access to the one of the running request; it keeps no connection of its own. */
export function requestScopedDatabase(): Database {
  return new Proxy({} as Database, {
    get(_target, property) {
      const { database } = currentRequestScope();
      const value: unknown = Reflect.get(database, property, database);
      return typeof value === "function" ? value.bind(database) : value;
    },
    has(_target, property) {
      return Reflect.has(currentRequestScope().database, property);
    },
  });
}
