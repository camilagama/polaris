import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { InvalidConfirmSaleCommandError } from "@polaris/domain/sales/confirm-sale";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../lib/offline-lease-token";
import { MemoryOutboxStorage } from "./outbox/memory-storage";
import { Outbox } from "./outbox/outbox";
import {
  confirmedSales,
  createOfflineSale,
  discardPendingSale,
  MissingSalePriceError,
  pendingSales,
  resubmitRejectedSale,
  UnknownLocalVariantError,
} from "./sale-confirm";
import { effectiveStock } from "./stock-commands";
import { syncOutbox } from "./sync-runner";
import { FakeStockServer, FakeWriter } from "./test-support";

const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const productId = "0199c2d0-0000-7000-8000-0000000000f1";
const shirt = "0199c2d0-0000-7000-8000-0000000000b1";
const sock = "0199c2d0-0000-7000-8000-0000000000b2";
const unpriced = "0199c2d0-0000-7000-8000-0000000000b3";
const now = new Date("2026-10-14T12:30:00.000Z");
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const pix = { method: "pix" } as const;

async function setup() {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create"],
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
  for (const [id, price] of [
    [shirt, "50.00"],
    [sock, "10.00"],
    [unpriced, null],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: fixtures are written in order
    await writer.upsert("variants", [
      {
        id,
        isDefault: true,
        listPrice: price,
        position: null,
        productId,
        sku: null,
        values: [],
      },
    ]);
  }
  const stockUp = async (variantId: string, quantity: number) => {
    server.seed(variantId, quantity, 1);
    await writer.upsert("inventory", [
      {
        productId,
        quantity,
        updatedAt: now.toISOString(),
        variantId,
        version: 1,
      },
    ]);
  };
  await stockUp(shirt, 5);
  await stockUp(sock, 20);
  let counter = 0;
  const sell = (
    lines: Parameters<typeof createOfflineSale>[0]["lines"],
    more: Partial<Parameters<typeof createOfflineSale>[0]> = {}
  ) => {
    counter += 1;
    const n = counter;
    return createOfflineSale({
      deviceId,
      lease,
      lines,
      newCommandId: () => uuid(100 + n),
      now: () => now,
      organizationId,
      outbox,
      payment: pix,
      reader: writer,
      ...more,
    });
  };
  const sync = () =>
    syncOutbox({
      outbox,
      pull: { source: server, writer },
      push: server.push,
    });
  return { lease, outbox, sell, server, stockUp, sync, writer };
}

describe("selling offline", () => {
  it("queues one sale command with the list prices, the commercial time and the device's evidence", async () => {
    const { outbox, sell } = await setup();
    const { command, totalDue, warnings } = await sell([
      { quantity: 2, variantId: shirt },
      { quantity: 3, variantId: sock },
    ]);

    expect(command).toMatchObject({
      baseVersion: null,
      commandId: uuid(101),
      status: "pending",
      type: "sale.confirm",
    });
    expect(command.payload).toEqual({
      adjustments: [],
      items: [
        {
          chargedUnitPrice: "50.00",
          listedUnitPrice: "50.00",
          quantity: 2,
          variantId: shirt,
        },
        {
          chargedUnitPrice: "10.00",
          listedUnitPrice: "10.00",
          quantity: 3,
          variantId: sock,
        },
      ],
      occurredAt: now.toISOString(),
      payment: {
        anticipationRequested: false,
        installmentPlan: null,
        installments: null,
        method: "pix",
      },
      recordedAt: now.toISOString(),
    });
    expect(totalDue).toBe("130.00");
    expect(warnings).toEqual([]);
    expect((await outbox.snapshot()).commands).toHaveLength(1);
  });

  it("charges what the person typed, keeping the list price as the reference, and applies adjustments", async () => {
    const { sell } = await setup();
    const { command, totalDue } = await sell(
      [{ chargedUnitPrice: "45.00", quantity: 2, variantId: shirt }],
      {
        adjustments: [
          { kind: "freight", value: { amount: "10.00", type: "fixed" } },
        ],
      }
    );
    expect(command.payload).toMatchObject({
      items: [{ chargedUnitPrice: "45.00", listedUnitPrice: "50.00" }],
    });
    expect(totalDue).toBe("100.00");
  });

  it("needs a price for a variant without a list price, and a known variant", async () => {
    const { outbox, sell } = await setup();
    await expect(
      sell([{ quantity: 1, variantId: unpriced }])
    ).rejects.toBeInstanceOf(MissingSalePriceError);
    const priced = await sell([
      { chargedUnitPrice: "7.50", quantity: 1, variantId: unpriced },
    ]);
    expect(priced.command.payload).toMatchObject({
      items: [{ chargedUnitPrice: "7.50", listedUnitPrice: "7.50" }],
    });
    await expect(
      sell([{ quantity: 1, variantId: uuid(777) }])
    ).rejects.toBeInstanceOf(UnknownLocalVariantError);
    expect((await outbox.snapshot()).commands).toHaveLength(1);
  });

  it("refuses a sale the server would refuse for its shape, queueing nothing", async () => {
    const { outbox, sell } = await setup();
    await expect(sell([])).rejects.toBeInstanceOf(
      InvalidConfirmSaleCommandError
    );
    await expect(
      sell([{ quantity: 0, variantId: shirt }])
    ).rejects.toBeInstanceOf(InvalidConfirmSaleCommandError);
    expect((await outbox.snapshot()).commands).toEqual([]);
  });

  it("warns when the local stock looks too low but still queues the sale: the server decides", async () => {
    const { outbox, sell } = await setup();
    const { warnings } = await sell([{ quantity: 8, variantId: shirt }]);
    expect(warnings).toEqual([
      { available: 5, requested: 8, variantId: shirt },
    ]);
    expect((await outbox.snapshot()).commands).toHaveLength(1);
  });

  it("the stock shown drops by what is queued, never below zero, and does not edit the local row", async () => {
    const { outbox, sell, writer } = await setup();
    await sell([{ quantity: 2, variantId: shirt }]);
    expect(await effectiveStock(outbox, writer, shirt)).toEqual({
      quantity: 3,
      version: 2,
    });
    await sell([{ quantity: 9, variantId: shirt }]);
    expect(await effectiveStock(outbox, writer, shirt)).toEqual({
      quantity: 0,
      version: 3,
    });
    expect(writer.stock(shirt)).toMatchObject({ quantity: 5, version: 1 });
  });
});

describe("a sale through its states", () => {
  it("goes pending, then syncing while it is being sent, then confirmed", async () => {
    const { outbox, sell, server, sync, writer } = await setup();
    const { command } = await sell([{ quantity: 2, variantId: shirt }]);
    expect(await pendingSales(outbox)).toMatchObject([
      {
        code: null,
        commandId: command.commandId,
        itemCount: 1,
        state: "pending",
      },
    ]);
    await outbox.markSending(command.commandId);
    expect((await pendingSales(outbox))[0]?.state).toBe("syncing");
    await outbox.recoverInterrupted();

    const summary = await sync();

    expect(summary.accepted).toBe(1);
    const [confirmed] = confirmedSales(summary.acceptedCommands);
    expect(confirmed).toMatchObject({ commandId: command.commandId });
    expect(confirmed?.saleId).toBe(server.sales.get(command.commandId)?.saleId);
    expect(await pendingSales(outbox)).toEqual([]);
    expect(writer.stock(shirt)).toMatchObject({ quantity: 3, version: 2 });
    expect(await effectiveStock(outbox, writer, shirt)).toEqual({
      quantity: 3,
      version: 2,
    });
  });

  it("is safe to push twice: a lost response is replayed, the sale confirmed once", async () => {
    const { sell, server, sync } = await setup();
    await sell([{ quantity: 2, variantId: shirt }]);
    server.lostResponses = 1;

    await expect(sync()).rejects.toThrow("network lost the response");
    expect(server.sales.size).toBe(1);

    const second = await sync();
    expect(second).toMatchObject({ accepted: 1, replayed: 1 });
    expect(server.sales.size).toBe(1);
    expect(server.executions).toBe(1);
    expect(server.balances.get(shirt)?.quantity).toBe(3);
  });

  it("is rejected whole when the stock does not cover it, with nothing taken, and blocks the queue", async () => {
    const { outbox, sell, server, sync } = await setup();
    await sell([
      { quantity: 2, variantId: sock },
      { quantity: 4, variantId: shirt },
    ]);
    await sell([{ quantity: 1, variantId: sock }]);
    // another device sold shirts meanwhile
    server.seed(shirt, 1, 2);

    const summary = await sync();

    expect(summary).toMatchObject({
      accepted: 0,
      notProcessed: 1,
      rejected: 1,
    });
    expect(server.sales.size).toBe(0);
    expect(server.balances.get(sock)?.quantity).toBe(20);
    expect(await pendingSales(outbox)).toMatchObject([
      { code: "insufficient_stock", state: "rejected" },
      { code: null, state: "pending" },
    ]);
    expect((await sync()).requests).toBe(0);
  });

  it("an account refusal is needs_attention and cannot be resubmitted from here", async () => {
    const { lease, outbox, sell } = await setup();
    const { command } = await sell([{ quantity: 1, variantId: sock }]);
    await outbox.markSending(command.commandId);
    await outbox.reject(command.commandId, "authorization_revoked");

    expect((await pendingSales(outbox))[0]).toMatchObject({
      code: "authorization_revoked",
      state: "needs_attention",
    });
    await expect(
      resubmitRejectedSale(outbox, { commandId: command.commandId, lease })
    ).rejects.toThrow("sale_needs_attention");
  });

  it("a refused sale is resubmitted as a new command once the cause is fixed, keeping its time and evidence", async () => {
    const { lease, outbox, sell, server, sync } = await setup();
    const { command } = await sell([{ quantity: 4, variantId: shirt }]);
    server.seed(shirt, 1, 2);
    await sync();
    expect((await pendingSales(outbox))[0]?.state).toBe("rejected");

    // the missing stock arrives (a receipt made on another device)
    server.seed(shirt, 6, 3);
    const next = await resubmitRejectedSale(outbox, {
      commandId: command.commandId,
      lease,
      newCommandId: () => uuid(500),
    });

    expect(next.commandId).toBe(uuid(500));
    expect(next.payload).toEqual(command.payload);
    expect((await pendingSales(outbox)).map((sale) => sale.commandId)).toEqual([
      uuid(500),
    ]);
    const summary = await sync();
    expect(summary.accepted).toBe(1);
    expect(server.sales.size).toBe(1);
    expect(server.balances.get(shirt)?.quantity).toBe(2);
  });

  it("only a refused sale is resubmitted; a sale being sent is not discarded", async () => {
    const { lease, outbox, sell } = await setup();
    const { command } = await sell([{ quantity: 1, variantId: sock }]);
    await expect(
      resubmitRejectedSale(outbox, { commandId: command.commandId, lease })
    ).rejects.toThrow("sale_not_rejected");
    await outbox.markSending(command.commandId);
    await expect(discardPendingSale(outbox, command.commandId)).rejects.toThrow(
      "sale_is_sending"
    );
    await expect(discardPendingSale(outbox, uuid(999))).rejects.toThrow(
      "not_a_pending_sale"
    );
  });

  it("a refused sale can be discarded, and the stock shown stops counting it", async () => {
    const { outbox, sell, server, sync, writer } = await setup();
    const { command } = await sell([{ quantity: 4, variantId: shirt }]);
    server.seed(shirt, 1, 2);
    await sync();
    await discardPendingSale(outbox, command.commandId);
    expect(await pendingSales(outbox)).toEqual([]);
    expect(await effectiveStock(outbox, writer, shirt)).toMatchObject({
      quantity: 5,
    });
  });
});

const profileSelection = {
  expectedVersion: 3,
  id: "0199c2d0-0000-7000-8000-0000000000c1",
};

describe("a sale priced with a payment profile", () => {
  it("carries the profile by id and version, and a sale without one keeps its old shape", async () => {
    const { sell } = await setup();
    const priced = await sell([{ quantity: 1, variantId: shirt }], {
      paymentProfile: profileSelection,
    });
    expect(priced.command.payload).toMatchObject({
      paymentProfile: profileSelection,
    });

    const plain = await sell([{ quantity: 1, variantId: shirt }]);
    expect(plain.command.payload).not.toHaveProperty("paymentProfile");
    const none = await sell([{ quantity: 1, variantId: shirt }], {
      paymentProfile: null,
    });
    expect(none.command.payload).not.toHaveProperty("paymentProfile");
  });

  it("is resubmitted without its profile after a profile refusal, as a new command that keeps everything else", async () => {
    const { lease, outbox, sell } = await setup();
    const { command } = await sell([{ quantity: 2, variantId: shirt }], {
      paymentProfile: profileSelection,
    });
    await outbox.markSending(command.commandId);
    await outbox.reject(command.commandId, "payment_profile_changed");

    const next = await resubmitRejectedSale(outbox, {
      commandId: command.commandId,
      lease,
      withoutProfile: true,
    });

    expect(next.commandId).not.toBe(command.commandId);
    expect(next.payload).not.toHaveProperty("paymentProfile");
    expect(next.payload).toMatchObject({
      items: (command.payload as { items: unknown }).items,
      occurredAt: (command.payload as { occurredAt: unknown }).occurredAt,
      recordedAt: (command.payload as { recordedAt: unknown }).recordedAt,
    });
    const { commands } = await outbox.snapshot();
    expect(commands.map((item) => item.commandId)).toEqual([next.commandId]);
  });

  it("refuses to drop the profile of a sale that was refused for anything else", async () => {
    const { lease, outbox, sell } = await setup();
    const { command } = await sell([{ quantity: 2, variantId: shirt }], {
      paymentProfile: profileSelection,
    });
    await outbox.markSending(command.commandId);
    await outbox.reject(command.commandId, "insufficient_stock");
    await expect(
      resubmitRejectedSale(outbox, {
        commandId: command.commandId,
        lease,
        withoutProfile: true,
      })
    ).rejects.toThrow("sale_not_profile_refused");
    expect((await outbox.snapshot()).commands).toHaveLength(1);
  });
});
