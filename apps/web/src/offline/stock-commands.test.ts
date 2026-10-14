import { InvalidInventoryCountInputError } from "@polaris/domain/inventory/inventory-count";
import { InvalidReceiveStockInputError } from "@polaris/domain/inventory/receive-stock";
import { InvalidWriteOffStockInputError } from "@polaris/domain/inventory/write-off-stock";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../lib/offline-lease-token";
import { MemoryOutboxStorage } from "./outbox/memory-storage";
import { Outbox } from "./outbox/outbox";
import {
  countStockOffline,
  discardPendingStock,
  effectiveStock,
  InsufficientLocalStockError,
  pendingStockCommands,
  receiveStockOffline,
  writeOffStockOffline,
} from "./stock-commands";
import { syncOutbox } from "./sync-runner";
import { FakeStockServer, FakeWriter } from "./test-support";

const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const variantId = "0199c2d0-0000-7000-8000-0000000000b2";
const productId = "0199c2d0-0000-7000-8000-0000000000f1";
const now = new Date("2026-10-14T12:30:00.000Z");
const occurredOn = "2026-10-14";
const deviceDayPattern = /^2026-10-1[3-5]$/;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function setup(initial: { quantity: number; version: number } | null) {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["inventory:adjust"],
      deviceId,
      epoch: 0,
      expiresAt: new Date(now.getTime() + 24 * 3_600_000),
      grantId: uuid(900),
      issuedAt: new Date(now.getTime() - 3_600_000),
      organizationId,
      userId,
    }),
    key
  );
  const outbox = new Outbox({
    deviceId,
    now: () => now,
    organizationId,
    storage: new MemoryOutboxStorage(),
    userId,
  });
  const writer = new FakeWriter();
  writer.meta = {
    bootstrappedAt: now.toISOString(),
    cursor: "0",
    status: "ready",
    updatedAt: now.toISOString(),
    version: 1,
  };
  const server = new FakeStockServer();
  if (initial) {
    server.seed(variantId, initial.quantity, initial.version);
    await writer.upsert("inventory", [
      {
        productId,
        quantity: initial.quantity,
        updatedAt: now.toISOString(),
        variantId,
        version: initial.version,
      },
    ]);
  }
  let counter = 0;
  const base = () => {
    counter += 1;
    return {
      deviceId,
      lease,
      newCommandId: () => uuid(100 + counter),
      now: () => now,
      occurredOn,
      organizationId,
      outbox,
      reader: writer,
      variantId,
    };
  };
  const sync = () =>
    syncOutbox({
      outbox,
      pull: { source: server, writer },
      push: server.push,
    });
  const stock = () => effectiveStock(outbox, writer, variantId);
  return { base, outbox, server, stock, sync, writer };
}

describe("stock the device shows", () => {
  it("is the server row plus what is still queued, in order", async () => {
    const { base, stock } = await setup({ quantity: 10, version: 3 });
    expect(await stock()).toEqual({ quantity: 10, version: 3 });

    await receiveStockOffline({ ...base(), quantity: 5, unitCost: "2" });
    expect(await stock()).toEqual({ quantity: 15, version: 4 });
    await writeOffStockOffline({
      ...base(),
      quantity: 4,
      reasonCode: "damaged",
    });
    expect(await stock()).toEqual({ quantity: 11, version: 5 });
    await countStockOffline({ ...base(), physicalQuantity: 9 });
    expect(await stock()).toEqual({ quantity: 9, version: 6 });
  });

  it("treats a variant without a row as no stock, version zero", async () => {
    const { base, stock } = await setup(null);
    expect(await stock()).toEqual({ quantity: 0, version: 0 });
    await receiveStockOffline({ ...base(), quantity: 3, unitCost: "1" });
    expect(await stock()).toEqual({ quantity: 3, version: 1 });
  });

  it("does not edit the local balance row when queueing", async () => {
    const { base, writer } = await setup({ quantity: 10, version: 3 });
    await receiveStockOffline({ ...base(), quantity: 5, unitCost: "2" });
    expect(writer.stock(variantId)).toMatchObject({ quantity: 10, version: 3 });
  });
});

describe("queueing stock commands", () => {
  it("normalizes what it queues and returns the stock after it", async () => {
    const { base } = await setup({ quantity: 10, version: 3 });
    const { command, stock } = await receiveStockOffline({
      ...base(),
      quantity: 5,
      unitCost: " 2.5 ",
    });
    expect(command).toMatchObject({
      baseVersion: null,
      status: "pending",
      type: "stock.receive",
    });
    expect(command.payload).toEqual({
      occurredOn,
      quantity: 5,
      unitCost: "2.500000",
      variantId,
    });
    expect(stock).toEqual({ quantity: 15, version: 4 });
  });

  it("dates the movement with the device's day unless one is given", async () => {
    const { base } = await setup({ quantity: 1, version: 1 });
    const { occurredOn: _omitted, ...withoutDate } = base();
    const { command } = await receiveStockOffline({
      ...withoutDate,
      quantity: 1,
      unitCost: "1",
    });
    expect(command.payload).toMatchObject({
      occurredOn: expect.stringMatching(deviceDayPattern),
    });
  });

  it("a count carries the balance version it counted against", async () => {
    const { base } = await setup({ quantity: 10, version: 3 });
    const first = await countStockOffline({ ...base(), physicalQuantity: 8 });
    expect(first.command.baseVersion).toBe(3);
    const second = await countStockOffline({ ...base(), physicalQuantity: 7 });
    expect(second.command.baseVersion).toBe(4);
  });

  it("refuses what the server would refuse, queueing nothing", async () => {
    const { base, outbox } = await setup({ quantity: 10, version: 3 });
    await expect(
      receiveStockOffline({ ...base(), quantity: 0, unitCost: "1" })
    ).rejects.toBeInstanceOf(InvalidReceiveStockInputError);
    await expect(
      writeOffStockOffline({ ...base(), quantity: 1, reasonCode: "other" })
    ).rejects.toBeInstanceOf(InvalidWriteOffStockInputError);
    await expect(
      countStockOffline({ ...base(), physicalQuantity: -1 })
    ).rejects.toBeInstanceOf(InvalidInventoryCountInputError);
    await expect(
      writeOffStockOffline({ ...base(), quantity: 11, reasonCode: "lost" })
    ).rejects.toBeInstanceOf(InsufficientLocalStockError);
    expect((await outbox.snapshot()).commands).toEqual([]);
  });
});

describe("syncing stock commands", () => {
  it("applies the queue in order and the server's balance replaces the overlay", async () => {
    const { base, outbox, server, stock, sync, writer } = await setup({
      quantity: 10,
      version: 3,
    });
    await receiveStockOffline({ ...base(), quantity: 5, unitCost: "2" });
    await writeOffStockOffline({
      ...base(),
      quantity: 4,
      reasonCode: "damaged",
    });
    await countStockOffline({ ...base(), physicalQuantity: 9 });

    const summary = await sync();

    expect(summary).toMatchObject({ accepted: 3, rejected: 0 });
    expect(server.balances.get(variantId)).toMatchObject({
      quantity: 9,
      version: 6,
    });
    expect((await outbox.snapshot()).commands).toEqual([]);
    expect(writer.stock(variantId)).toMatchObject({ quantity: 9, version: 6 });
    expect(await stock()).toEqual({ quantity: 9, version: 6 });
  });

  it("is safe to push twice: a lost response is replayed, not applied again", async () => {
    const { base, server, stock, sync } = await setup({
      quantity: 10,
      version: 1,
    });
    await receiveStockOffline({ ...base(), quantity: 5, unitCost: "2" });
    server.lostResponses = 1;

    await expect(sync()).rejects.toThrow("network lost the response");
    expect(server.balances.get(variantId)?.quantity).toBe(15);

    const second = await sync();
    expect(second).toMatchObject({ accepted: 1, replayed: 1 });
    expect(server.executions).toBe(1);
    expect(server.balances.get(variantId)?.quantity).toBe(15);
    expect(await stock()).toEqual({ quantity: 15, version: 2 });
  });

  it("a count made against a stale balance is refused and blocks the queue, without a way to force it", async () => {
    const { base, outbox, server, stock, sync } = await setup({
      quantity: 10,
      version: 3,
    });
    await countStockOffline({ ...base(), physicalQuantity: 8 });
    await receiveStockOffline({ ...base(), quantity: 1, unitCost: "1" });
    // another device moved the balance while this one was offline
    server.seed(variantId, 20, 4);

    const summary = await sync();

    expect(summary).toMatchObject({
      accepted: 0,
      notProcessed: 1,
      rejected: 1,
    });
    expect(summary.blockedBy?.rejection?.code).toBe(
      "inventory_version_conflict"
    );
    expect(server.balances.get(variantId)).toMatchObject({
      quantity: 20,
      version: 4,
    });
    expect(await pendingStockCommands(outbox)).toMatchObject([
      {
        code: "inventory_version_conflict",
        state: "rejected",
        type: "stock.count",
      },
      { code: null, state: "pending", type: "stock.receive" },
    ]);
    // the refused count no longer counts toward what is shown
    expect(await stock()).toEqual({ quantity: 10 + 1, version: 4 });
    expect((await sync()).requests).toBe(0);
  });

  it("a write-off the server cannot honour is refused whole and can be discarded to move on", async () => {
    const { base, outbox, server, stock, sync, writer } = await setup({
      quantity: 10,
      version: 1,
    });
    await writeOffStockOffline({ ...base(), quantity: 8, reasonCode: "lost" });
    await receiveStockOffline({ ...base(), quantity: 1, unitCost: "1" });
    // someone else sold 5 while the device was offline
    server.seed(variantId, 5, 2);
    await writer.upsert("inventory", [
      {
        productId,
        quantity: 5,
        updatedAt: now.toISOString(),
        variantId,
        version: 2,
      },
    ]);

    const summary = await sync();
    expect(summary.blockedBy?.rejection?.code).toBe("insufficient_stock");
    expect(server.balances.get(variantId)?.quantity).toBe(5);

    const [refused] = await pendingStockCommands(outbox);
    expect(refused?.state).toBe("rejected");
    await discardPendingStock(outbox, refused?.commandId ?? "");
    expect(await stock()).toEqual({ quantity: 6, version: 3 });

    expect((await sync()).accepted).toBe(1);
    expect(server.balances.get(variantId)?.quantity).toBe(6);
  });

  it("does not discard a movement that is being sent, nor anything that is not stock", async () => {
    const { base, outbox } = await setup({ quantity: 10, version: 1 });
    const { command } = await receiveStockOffline({
      ...base(),
      quantity: 1,
      unitCost: "1",
    });
    await outbox.markSending(command.commandId);
    await expect(
      discardPendingStock(outbox, command.commandId)
    ).rejects.toThrow("stock_command_is_sending");
    await expect(discardPendingStock(outbox, uuid(999))).rejects.toThrow(
      "not_a_pending_stock_command"
    );
  });
});
