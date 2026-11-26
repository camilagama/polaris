import type { PushCommandReadModel } from "@polaris/contracts";
import type { runSyncCommand } from "@polaris/db/sync-command-repository";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../../lib/offline-lease-token";
import { PUSH_REJECTION, pushCommands } from "./push";
import { syncCommandHandlers } from "./registry";

const key = { id: "k1", secret: "s".repeat(40) };
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const issuedAt = new Date("2026-10-14T12:00:00.000Z");
const expiresAt = new Date(issuedAt.getTime() + 72 * 3_600_000);
const productId = "0199c2d0-0000-7000-8000-00000000a001";

async function deleteCommand(): Promise<PushCommandReadModel> {
  return {
    baseVersion: 2,
    commandId: "0199c2d0-0000-7000-8000-00000000c001",
    createdAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
    deviceId,
    lease: await signOfflineLease(
      buildOfflineLeaseClaims({
        capabilities: ["product:update"],
        deviceId,
        epoch: 0,
        expiresAt,
        grantId: "0199c2d0-0000-7000-8000-000000000900",
        issuedAt,
        organizationId: "org-1",
        userId: "user-1",
      }),
      key
    ),
    payload: { id: productId },
    type: "product.delete",
  };
}

describe("product.delete never travels through the sync queue", () => {
  it("answers unsupported_command_type for a product.delete command, even with a lease that grants product:update", async () => {
    const run: typeof runSyncCommand = (_transaction, _identity, input) =>
      Promise.resolve({
        code: input.precheckFailure ?? "unexpected",
        replayed: false,
        result: null,
        status: "rejected",
      });
    const [answer] = await pushCommands([await deleteCommand()], {
      handlers: syncCommandHandlers,
      hashKeys: { current: "h".repeat(32), previous: [] },
      keys: { signing: key, verification: [key] },
      now: () => new Date(expiresAt.getTime() + 3_600_000),
      runSyncCommand: run,
      withTenant: (operation) => operation({} as never, {} as never),
    });
    expect(answer?.code).toBe(PUSH_REJECTION.unsupportedCommandType);
  });

  it("fails if a handler for product.delete is registered", () => {
    const types = syncCommandHandlers.map((handler) => handler.type);
    expect(types).not.toContain("product.delete");
    expect(types).toHaveLength(new Set(types).size);
  });
});
