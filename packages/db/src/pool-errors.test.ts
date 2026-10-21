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
