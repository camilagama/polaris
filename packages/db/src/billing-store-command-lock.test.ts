import { describe, expect, it, vi } from "vitest";
import {
  BillingCommandInProgressError,
  type CommandLockCounter,
  createBillingStore,
} from "./billing-store";

/**
 * The isolate's count of command locks (ADR 0104, decision 4), before any connection: the advisory lock itself is
 * proved on PostgreSQL 18 by the `billing-trial-claims` and `billing-owner-commands` gates. The store points at an
 * address nothing listens on, so getting past the count shows as a connection error.
 */
const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const unreachable = "postgres://gate:secret@127.0.0.1:1/none";

function storeWith(commandLocks: CommandLockCounter) {
  return createBillingStore(unreachable, { commandLocks });
}

describe("withOrganizationLock: one command lock per isolate", () => {
  it("refuses at once while this isolate holds one, for any organization, and never connects", async () => {
    const locks: CommandLockCounter = {
      held: 1,
      holder: {},
      since: Date.now(),
    };
    const store = storeWith(locks);
    const operation = vi.fn(() => Promise.resolve("ran"));

    await expect(
      store.withOrganizationLock(organizationId, operation)
    ).rejects.toBeInstanceOf(BillingCommandInProgressError);
    expect(operation).not.toHaveBeenCalled();
    expect(locks.held).toBe(1);
    await store.close();
  });

  it("does not trust a hold older than the lock's transaction can live: it tries the database again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stale = {};
    const locks: CommandLockCounter = {
      held: 1,
      holder: stale,
      since: Date.now() - 80_000,
    };
    const store = storeWith(locks);
    const operation = vi.fn(() => Promise.resolve("ran"));

    const failure = await store
      .withOrganizationLock(organizationId, operation)
      .then(
        () => null,
        (error: unknown) => error
      );

    // past the count: the connection is what failed, not the isolate's lock
    expect(failure).not.toBeInstanceOf(BillingCommandInProgressError);
    expect(failure).toBeInstanceOf(Error);
    expect(operation).not.toHaveBeenCalled();
    // and its own hold is released, so the next command is not refused by it
    expect(locks.held).toBe(0);
    expect(locks.holder).toBeUndefined();
    vi.restoreAllMocks();
    await store.close();
  });

  it("releases its own hold when the operation fails", async () => {
    const locks: CommandLockCounter = { held: 0 };
    const store = storeWith(locks);

    await expect(
      store.withOrganizationLock(organizationId, () => Promise.resolve())
    ).rejects.toBeInstanceOf(Error);
    expect(locks.held).toBe(0);
    await store.close();
  });
});
