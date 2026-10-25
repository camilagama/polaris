import { EventEmitter } from "node:events";
import { logger } from "@polaris/observability/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

const leakedData = /secret|host=/;
const pools: EventEmitter[] = [];

vi.mock("pg", () => ({
  Pool: class extends EventEmitter {
    constructor() {
      super();
      pools.push(this);
    }
    end() {
      return Promise.resolve();
    }
  },
}));

const { createDatabase } = await import("./client");
const { connectionsClosedByUs } = await import("./pool-errors");
const { createBillingStore } = await import("./billing-store");
const { createAuthLoginLockMaintenanceClient } = await import(
  "./auth-login-lock-maintenance"
);
const { createAuthUnverifiedUserMaintenanceClient } = await import(
  "./auth-unverified-user-maintenance"
);
const { createOutboxClient } = await import("./outbox-dispatch");
const { createMediaCleanupClient } = await import("./media-cleanup");
const { createPrivacyMaintenanceClient } = await import(
  "./privacy-maintenance"
);

const factories = {
  authLoginLockMaintenance: () =>
    createAuthLoginLockMaintenanceClient("postgres://u:secret@h/db"),
  authUnverifiedUserMaintenance: () =>
    createAuthUnverifiedUserMaintenanceClient("postgres://u:secret@h/db"),
  billingStore: () => createBillingStore("postgres://u:secret@h/db"),
  database: () => createDatabase("postgres://u:secret@h/db"),
  mediaCleanup: () => createMediaCleanupClient("postgres://u:secret@h/db"),
  outbox: () => createOutboxClient("postgres://u:secret@h/db"),
  privacyMaintenance: () =>
    createPrivacyMaintenanceClient("postgres://u:secret@h/db"),
};

function socketClosed() {
  return Object.assign(
    new Error("This socket has been closed. host=h password=secret"),
    { code: "ECONNRESET" }
  );
}

describe("pools made per request survive a connection error after the response", () => {
  afterEach(() => {
    pools.length = 0;
    vi.restoreAllMocks();
  });

  for (const [name, create] of Object.entries(factories)) {
    it(`${name}: an error on the pool is handled and logged without data`, () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      create();
      const [pool] = pools;
      expect(() => pool?.emit("error", socketClosed())).not.toThrow();
      expect(warn).toHaveBeenCalledWith("database_pool_error", {
        errorClass: "Error",
        errorCode: "ECONNRESET",
      });
    });

    it(`${name}: an error on a connection is handled and logged without data`, () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      create();
      const [pool] = pools;
      const client = new EventEmitter();
      pool?.emit("connect", client);
      expect(() => client.emit("error", socketClosed())).not.toThrow();
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(leakedData);
      expect(warn).toHaveBeenCalledExactlyOnceWith("database_pool_error", {
        errorClass: "Error",
        errorCode: "ECONNRESET",
      });
    });
  }
});

/**
 * A connection as `pg-pool` hands it over: the pool's own listener of an idle connection is attached before the pool
 * emits `connect`, and on an error it ends the connection and passes the error on to the pool (pg-pool 3.14).
 */
function idleConnection(pool: EventEmitter) {
  const client = Object.assign(new EventEmitter(), {
    end: vi.fn(() => Promise.resolve()),
  });
  client.on("error", (error: unknown) => {
    client.end();
    pool.emit("error", error, client);
  });
  pool.emit("connect", client);
  return client;
}

/** What workerd gives the pending read of a socket the Worker closed itself (pg-cloudflare 1.4.1). */
const ownCloseRead = () => new TypeError("This socket has been closed.");

describe("one connection error is one log, and the close of a connection this side ends is not one (CPU-1d)", () => {
  afterEach(() => {
    pools.length = 0;
    vi.restoreAllMocks();
  });

  it("logs an error of an idle connection once, though the pool passes it on", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    createDatabase("postgres://u:secret@h/db");
    const client = idleConnection(pools[0] as EventEmitter);
    client.emit("error", socketClosed());
    expect(warn).toHaveBeenCalledExactlyOnceWith("database_pool_error", {
      errorClass: "Error",
      errorCode: "ECONNRESET",
    });
  });

  it("only counts the read that fails because the connection was being ended here", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    createDatabase("postgres://u:secret@h/db");
    const client = idleConnection(pools[0] as EventEmitter);
    const before = connectionsClosedByUs();
    await client.end();
    client.emit("error", ownCloseRead());
    expect(warn).not.toHaveBeenCalled();
    expect(connectionsClosedByUs()).toBe(before + 1);
  });

  it("still logs that same error, once, when nothing here was ending the connection", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    createDatabase("postgres://u:secret@h/db");
    const client = idleConnection(pools[0] as EventEmitter);
    const before = connectionsClosedByUs();
    client.emit("error", ownCloseRead());
    expect(warn).toHaveBeenCalledExactlyOnceWith("database_pool_error", {
      errorClass: "TypeError",
    });
    expect(connectionsClosedByUs()).toBe(before);
  });

  it("logs any other error of a connection being ended", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    createDatabase("postgres://u:secret@h/db");
    const client = idleConnection(pools[0] as EventEmitter);
    await client.end();
    client.emit("error", socketClosed());
    expect(warn).toHaveBeenCalledExactlyOnceWith("database_pool_error", {
      errorClass: "Error",
      errorCode: "ECONNRESET",
    });
  });
});
