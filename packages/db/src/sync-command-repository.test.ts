import type { OfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it, vi } from "vitest";
import {
  isCommandTooOld,
  type RunSyncCommandInput,
  runSyncCommand,
  SYNC_REJECTION,
} from "./sync-command-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-10-18T12:00:00.000Z");

describe("isCommandTooOld", () => {
  it("accepts a command up to 90 days old and refuses one older", () => {
    expect(isCommandTooOld(new Date(NOW.getTime() - 89 * DAY_MS), NOW)).toBe(
      false
    );
    expect(isCommandTooOld(new Date(NOW.getTime() - 90 * DAY_MS), NOW)).toBe(
      false
    );
    expect(
      isCommandTooOld(new Date(NOW.getTime() - 90 * DAY_MS - 1), NOW)
    ).toBe(true);
  });

  it("leaves an unreadable creation time to the lease window check", () => {
    expect(isCommandTooOld(new Date("not a date"), NOW)).toBe(false);
  });
});

function fakeTransaction(existing: unknown[]) {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const limit = vi.fn().mockResolvedValue(existing);
  const insert = vi.fn();
  const chain = { from: () => chain, limit, where: () => chain };
  return {
    execute,
    insert,
    transaction: {
      execute,
      insert,
      select: () => chain,
    } as unknown as TenantRequestTransaction,
  };
}

const identity = {
  organizationId: "organization-1",
  userId: "user-a",
} as TenantRequestIdentity;

function staleInput(overrides: Partial<RunSyncCommandInput> = {}) {
  return {
    commandId: "command-1",
    commandType: "customer.create",
    createdAt: new Date(NOW.getTime() - 91 * DAY_MS),
    deviceId: "device-1",
    leaseClaims: null,
    now: NOW,
    payloadHash: "0".repeat(64),
    ...overrides,
  };
}

describe("runSyncCommand with a command older than 90 days", () => {
  it("refuses a new one with a stable code and stores nothing", async () => {
    const { insert, transaction } = fakeTransaction([]);
    const execute = vi.fn();

    const outcome = await runSyncCommand(
      transaction,
      identity,
      staleInput(),
      execute,
      () => null
    );

    expect(outcome).toEqual({
      code: SYNC_REJECTION.commandTooOld,
      replayed: false,
      result: null,
      status: "rejected",
    });
    expect(SYNC_REJECTION.commandTooOld).toBe("command_too_old");
    expect(insert).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("still replays the stored outcome of a command whose record exists", async () => {
    const { insert, transaction } = fakeTransaction([
      {
        commandType: "customer.create",
        outcomeCode: null,
        outcomeResult: { id: "customer-1" },
        outcomeStatus: "accepted",
        payloadHash: "0".repeat(64),
        userId: "user-a",
      },
    ]);
    const execute = vi.fn();

    const outcome = await runSyncCommand(
      transaction,
      identity,
      staleInput(),
      execute,
      () => null
    );

    expect(outcome).toEqual({
      code: null,
      replayed: true,
      result: { id: "customer-1" },
      status: "accepted",
    });
    expect(insert).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

const leaseOf = (sub: string) =>
  ({ dev: "device-1", jti: "grant-1", sub }) as OfflineLeaseClaims;

describe("runSyncCommand with a lease of another user", () => {
  it("answers session_changed and touches nothing", async () => {
    const { execute: sqlExecute, insert, transaction } = fakeTransaction([]);
    const execute = vi.fn();

    const outcome = await runSyncCommand(
      transaction,
      identity,
      staleInput({
        createdAt: NOW,
        leaseClaims: leaseOf("user-b"),
      }),
      execute,
      () => null
    );

    expect(outcome).toEqual({
      code: SYNC_REJECTION.sessionChanged,
      replayed: false,
      result: null,
      status: "rejected",
    });
    expect(SYNC_REJECTION.sessionChanged).toBe("session_changed");
    expect(insert).not.toHaveBeenCalled();
    expect(sqlExecute).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not replay another user's stored outcome for the same command ID", async () => {
    const { insert, transaction } = fakeTransaction([
      {
        commandType: "customer.create",
        outcomeCode: null,
        outcomeResult: { id: "customer-1" },
        outcomeStatus: "accepted",
        payloadHash: "0".repeat(64),
        userId: "user-b",
      },
    ]);
    const execute = vi.fn();

    const outcome = await runSyncCommand(
      transaction,
      identity,
      staleInput({ createdAt: NOW }),
      execute,
      () => null
    );

    expect(outcome).toEqual({
      code: SYNC_REJECTION.commandIdReused,
      replayed: false,
      result: null,
      status: "rejected",
    });
    expect(insert).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("runSyncCommand without verified lease claims", () => {
  it("refuses with the precheck code and stores nothing", async () => {
    const { insert, transaction } = fakeTransaction([]);
    const execute = vi.fn();

    const outcome = await runSyncCommand(
      transaction,
      identity,
      staleInput({ createdAt: NOW, precheckFailure: "lease_invalid" }),
      execute,
      () => null
    );

    expect(outcome).toEqual({
      code: "lease_invalid",
      replayed: false,
      result: null,
      status: "rejected",
    });
    expect(insert).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
