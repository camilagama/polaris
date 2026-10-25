import { AsyncLocalStorage } from "node:async_hooks";
import type { createDatabase } from "@polaris/db/client";
import type { AuthEmailDelivery } from "../auth";
import type { BackgroundTaskHandler } from "./security-options";

type Database = ReturnType<typeof createDatabase>["db"];

/**
 * What the Better Auth hooks remember between the steps of one request. It lives in the request scope, never in the
 * instance: the instance serves every request of the isolate (ADR 0017, emendas de 24/10/2026 e 25/10/2026).
 */
export interface AuthRequestState {
  /** Who was signed in when `/sign-out` began: the after hook audits the logout with it, after the session is gone. */
  logoutActorId: string | null;
  /** The last IP recorded for a session in this request, so the same change is not recorded twice. */
  readonly recordedSessionIps: Map<string, string>;
  /** The update hooks that extend a session (the daily refresh), told apart from the other updates of a session. */
  readonly refreshing: WeakSet<object>;
}

export function newAuthRequestState(): AuthRequestState {
  return {
    logoutActorId: null,
    recordedSessionIps: new Map(),
    refreshing: new WeakSet(),
  };
}

interface RequestScope {
  database: Database;
  /** The e-mails of the password flows, built for this request; absent while the password is off. */
  emailDelivery?: AuthEmailDelivery;
  requestId: string;
  /** The `waitUntil` of this request, so a task outlives the response without outliving the request. */
  runInBackground?: BackgroundTaskHandler;
}

interface RunningScope extends RequestScope {
  readonly state: AuthRequestState;
}

/**
 * The Better Auth instances are built once per isolate (ADR 0017, emendas de 24/10/2026 e 25/10/2026), so they cannot
 * hold anything of a request: a `Pool` is an I/O object of the request that opened it, and the runtime refuses to
 * reuse it from another one; a user remembered by the instance would reach the next request. What the instances hold
 * are functions that read the running request from this storage at each call. Outside `runWithRequestScope` there is
 * nothing to read and they throw, so a call that escapes the request fails closed.
 */
const storage = new AsyncLocalStorage<RunningScope>();

/** Runs `run` as one request: a fresh `AuthRequestState`, and the given database, identifier and background handler. */
export function runWithRequestScope<T>(
  scope: RequestScope,
  run: () => Promise<T>
): Promise<T> {
  return storage.run({ ...scope, state: newAuthRequestState() }, run);
}

function currentRequestScope(): RunningScope {
  const scope = storage.getStore();
  if (!scope) {
    throw new Error("request_database_unavailable");
  }
  return scope;
}

export function currentRequestId(): string {
  return currentRequestScope().requestId;
}

export function currentAuthRequestState(): AuthRequestState {
  return currentRequestScope().state;
}

/** Hands a task to the `waitUntil` of the running request; a scope without one lets the task run unawaited. */
export function runInRequestBackground(task: Promise<unknown>): void {
  currentRequestScope().runInBackground?.(task);
}

/** The e-mails of the running request; a request that sends none has no delivery and the call fails. */
export function currentEmailDelivery(): AuthEmailDelivery {
  const { emailDelivery } = currentRequestScope();
  if (!emailDelivery) {
    throw new Error("request_email_unavailable");
  }
  return emailDelivery;
}

/** A delivery that sends through the one of the running request at each call; it keeps no delivery of its own. */
export function requestScopedEmailDelivery(): AuthEmailDelivery {
  return {
    sendExistingAccount: (input) => {
      const send = currentEmailDelivery().sendExistingAccount;
      return send ? send(input) : Promise.resolve();
    },
    sendPasswordReset: (data, request) =>
      currentEmailDelivery().sendPasswordReset(data, request),
    sendVerificationEmail: (data, request) =>
      currentEmailDelivery().sendVerificationEmail(data, request),
  };
}

/**
 * A `db` that forwards every access to the one of the running request; it keeps no connection of its own. Every trap
 * reads the scope first, so outside a request any use of it throws.
 */
export function requestScopedDatabase(): Database {
  return new Proxy({} as Database, {
    defineProperty(_target, property, descriptor) {
      return Reflect.defineProperty(
        currentRequestScope().database,
        property,
        descriptor
      );
    },
    deleteProperty(_target, property) {
      return Reflect.deleteProperty(currentRequestScope().database, property);
    },
    get(_target, property) {
      const { database } = currentRequestScope();
      const value: unknown = Reflect.get(database, property, database);
      return typeof value === "function" ? value.bind(database) : value;
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        currentRequestScope().database,
        property
      );
      // the empty target has no property of its own: a proxy may only report one as configurable
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(currentRequestScope().database);
    },
    has(_target, property) {
      return Reflect.has(currentRequestScope().database, property);
    },
    isExtensible(target) {
      currentRequestScope();
      return Reflect.isExtensible(target);
    },
    ownKeys() {
      return Reflect.ownKeys(currentRequestScope().database);
    },
    preventExtensions() {
      currentRequestScope();
      return false;
    },
    set(_target, property, value) {
      const { database } = currentRequestScope();
      return Reflect.set(database, property, value, database);
    },
    setPrototypeOf() {
      currentRequestScope();
      return false;
    },
  });
}
