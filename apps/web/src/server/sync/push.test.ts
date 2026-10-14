import type { PushCommandReadModel } from "@polaris/contracts";
import type {
  runSyncCommand,
  SyncCommandOutcome,
} from "@polaris/db/sync-command-repository";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it, vi } from "vitest";
import { signOfflineLease } from "../../lib/offline-lease-token";
import {
  InvalidSyncPayloadError,
  PUSH_REJECTION,
  pushCommands,
  type SyncCommandHandler,
} from "./push";

const lastCharacter = /.$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const key = { id: "k1", secret: "s".repeat(40) };
const keys = { signing: key, verification: [key] };
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const issuedAt = new Date("2026-10-14T12:00:00.000Z");
const expiresAt = new Date(issuedAt.getTime() + 72 * 3_600_000);
const afterExpiry = new Date(expiresAt.getTime() + 3_600_000);
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function lease(capabilities = ["customer:update"]) {
  return await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities,
      deviceId,
      epoch: 0,
      expiresAt,
      grantId: uuid(900),
      issuedAt,
      organizationId: "org-1",
      userId: "user-1",
    }),
    key
  );
}

async function command(
  n: number,
  overrides: Partial<PushCommandReadModel> = {}
): Promise<PushCommandReadModel> {
  return {
    baseVersion: null,
    commandId: uuid(n),
    createdAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
    deviceId,
    lease: await lease(),
    payload: { name: `Cliente ${n}` },
    type: "customer.create",
    ...overrides,
  };
}

function handler(overrides: Partial<SyncCommandHandler> = {}) {
  const execute = vi.fn(() => Promise.resolve({ ok: true }));
  const value: SyncCommandHandler = {
    capability: "customer:update",
    classify: () => null,
    execute,
    parse: (payload) => {
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        typeof (payload as { name?: unknown }).name !== "string"
      ) {
        throw new InvalidSyncPayloadError();
      }
      return payload;
    },
    type: "customer.create",
    ...overrides,
  };
  return { execute, value };
}

interface Recorded {
  executed: boolean;
  input: Parameters<typeof runSyncCommand>[2];
}

/** A fake database frame: records what it was asked and returns scripted outcomes. */
function frame(script: (n: number, recorded: Recorded) => SyncCommandOutcome) {
  const calls: Recorded[] = [];
  const run: typeof runSyncCommand = async (
    _transaction,
    _identity,
    input,
    execute
  ) => {
    const recorded: Recorded = { executed: false, input };
    calls.push(recorded);
    const outcome = script(calls.length, recorded);
    if (
      !(input.precheckFailure || outcome.replayed) &&
      outcome.status === "accepted"
    ) {
      await execute({} as never);
      recorded.executed = true;
    }
    return outcome;
  };
  return { calls, run };
}

const accepted: SyncCommandOutcome = {
  code: null,
  replayed: false,
  result: { ok: true },
  status: "accepted",
};
const rejected = (code: string): SyncCommandOutcome => ({
  code,
  replayed: false,
  result: null,
  status: "rejected",
});

function dependencies(
  run: typeof runSyncCommand,
  handlers: SyncCommandHandler[],
  now = afterExpiry
) {
  return {
    handlers,
    keys,
    now: () => now,
    runSyncCommand: run,
    withTenant: <T>(
      operation: (transaction: never, identity: never) => Promise<T>
    ) => operation({} as never, {} as never),
  };
}

describe("pushCommands", () => {
  it("answers each command and runs the domain handler with the parsed payload", async () => {
    const { execute, value } = handler();
    const { calls, run } = frame(() => accepted);
    const results = await pushCommands(
      [await command(1), await command(2)],
      dependencies(run, [value])
    );
    expect(results.map((r) => [r.commandId, r.status])).toEqual([
      [uuid(1), "accepted"],
      [uuid(2), "accepted"],
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      {},
      {},
      { name: "Cliente 1" },
      { baseVersion: null, commandId: uuid(1) }
    );
    expect(calls[0]?.input).toMatchObject({
      commandId: uuid(1),
      commandType: "customer.create",
      deviceId,
      precheckFailure: null,
    });
  });

  it("stops at the first rejection: the rest are not processed, in order", async () => {
    const { value } = handler();
    const { calls, run } = frame((n) =>
      n === 2 ? rejected("stock_insufficient") : accepted
    );
    const results = await pushCommands(
      [await command(1), await command(2), await command(3), await command(4)],
      dependencies(run, [value])
    );
    expect(results.map((r) => r.status)).toEqual([
      "accepted",
      "rejected",
      "not_processed",
      "not_processed",
    ]);
    expect(results[1]?.code).toBe("stock_insufficient");
    expect(results[2]).toMatchObject({
      code: null,
      replayed: false,
      result: null,
    });
    expect(calls).toHaveLength(2);
  });

  it("treats a replayed rejection like a rejection", async () => {
    const { value } = handler();
    const { run } = frame(() => ({ ...rejected("conflict"), replayed: true }));
    const results = await pushCommands(
      [await command(1), await command(2)],
      dependencies(run, [value])
    );
    expect(results.map((r) => r.status)).toEqual(["rejected", "not_processed"]);
    expect(results[0]?.replayed).toBe(true);
  });

  it("verifies the lease signature but not its window, so a command made in time can sync late", async () => {
    const { value } = handler();
    const { calls, run } = frame(() => accepted);
    await pushCommands(
      [await command(1)],
      dependencies(run, [value], afterExpiry)
    );
    const claims = calls[0]?.input.leaseClaims;
    expect(claims?.jti).toBe(uuid(900));
    expect(calls[0]?.input.precheckFailure).toBeNull();
  });

  it("refuses a forged or garbage lease without running anything", async () => {
    const { execute, value } = handler();
    const { calls, run } = frame((_n, recorded) =>
      rejected(recorded.input.precheckFailure ?? "unexpected")
    );
    const forged = (await lease()).replace(lastCharacter, (c) =>
      c === "A" ? "B" : "A"
    );
    const results = await pushCommands(
      [await command(1, { lease: forged })],
      dependencies(run, [value])
    );
    expect(results[0]?.code).toBe(PUSH_REJECTION.leaseInvalid);
    expect(calls[0]?.input.leaseClaims).toBeNull();
    const garbage = await pushCommands(
      [await command(2, { lease: "garbage" })],
      dependencies(run, [value])
    );
    expect(garbage[0]?.code).toBe(PUSH_REJECTION.leaseInvalid);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an unknown command type, a capability the lease lacks and a bad payload", async () => {
    const { execute, value } = handler();
    const { run } = frame((_n, recorded) =>
      rejected(recorded.input.precheckFailure ?? "unexpected")
    );
    const unknown = await pushCommands(
      [await command(1, { type: "sale.confirm" })],
      dependencies(run, [value])
    );
    expect(unknown[0]?.code).toBe(PUSH_REJECTION.unsupportedCommandType);
    const noCapability = await pushCommands(
      [await command(2, { lease: await lease(["sale:create"]) })],
      dependencies(run, [value])
    );
    expect(noCapability[0]?.code).toBe(PUSH_REJECTION.capabilityNotInLease);
    const badPayload = await pushCommands(
      [await command(3, { payload: [1, 2] })],
      dependencies(run, [value])
    );
    expect(badPayload[0]?.code).toBe(PUSH_REJECTION.invalidPayload);
    expect(execute).not.toHaveBeenCalled();
  });

  it("also needs the capabilities the payload itself asks for", async () => {
    const { execute, value } = handler({
      extraCapabilities: (payload) =>
        (payload as { withStock?: boolean }).withStock
          ? ["inventory:adjust"]
          : [],
    });
    const { run } = frame((_n, recorded) =>
      recorded.input.precheckFailure
        ? rejected(recorded.input.precheckFailure)
        : accepted
    );
    const plain = await pushCommands(
      [await command(1, { payload: { name: "A" } })],
      dependencies(run, [value])
    );
    expect(plain[0]?.status).toBe("accepted");
    const missing = await pushCommands(
      [await command(2, { payload: { name: "B", withStock: true } })],
      dependencies(run, [value])
    );
    expect(missing[0]?.code).toBe(PUSH_REJECTION.capabilityNotInLease);
    const granted = await pushCommands(
      [
        await command(3, {
          lease: await lease(["customer:update", "inventory:adjust"]),
          payload: { name: "C", withStock: true },
        }),
      ],
      dependencies(run, [value])
    );
    expect(granted[0]?.status).toBe("accepted");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("hashes the content so key order does not matter but any change does", async () => {
    const { value } = handler();
    const hashes: string[] = [];
    const { run } = frame((_n, recorded) => {
      hashes.push(recorded.input.payloadHash);
      return accepted;
    });
    const deps = dependencies(run, [value]);
    await pushCommands(
      [await command(1, { payload: { extra: { b: 1, c: 2 }, name: "a" } })],
      deps
    );
    await pushCommands(
      [await command(1, { payload: { extra: { b: 1, c: 2 }, name: "a" } })],
      deps
    );
    await pushCommands([await command(1, { payload: { name: "b" } })], deps);
    await pushCommands([await command(1, { baseVersion: 3 })], deps);
    expect(hashes[0]).toMatch(sha256Pattern);
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).not.toBe(hashes[0]);
    expect(hashes[3]).not.toBe(hashes[0]);
  });

  it("hands expected domain failures to the handler's classifier", async () => {
    class Refusal extends Error {}
    const { value } = handler({
      classify: (error) => (error instanceof Refusal ? "domain_refusal" : null),
    });
    let classified: string | null = null;
    const run: typeof runSyncCommand = (_t, _i, _input, _execute, classify) => {
      classified = classify(new Refusal());
      return Promise.resolve(rejected(classified ?? "none"));
    };
    const results = await pushCommands(
      [await command(1)],
      dependencies(run, [value])
    );
    expect(classified).toBe("domain_refusal");
    expect(results[0]?.code).toBe("domain_refusal");
  });

  it("lets unexpected errors propagate so the device retries", async () => {
    const { value } = handler();
    const run: typeof runSyncCommand = () =>
      Promise.reject(new Error("db down"));
    await expect(
      pushCommands([await command(1)], dependencies(run, [value]))
    ).rejects.toThrow("db down");
  });
});
