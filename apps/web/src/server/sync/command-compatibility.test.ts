import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../../lib/offline-lease-token";
import { createOfflineCustomer } from "../../offline/customer-create";
import { MemoryOutboxStorage } from "../../offline/outbox/memory-storage";
import { Outbox } from "../../offline/outbox/outbox";
import { createOfflineProduct } from "../../offline/product-create";
import { createOfflineSale } from "../../offline/sale-confirm";
import {
  countStockOffline,
  receiveStockOffline,
  writeOffStockOffline,
} from "../../offline/stock-commands";
import { FakeWriter } from "../../offline/test-support";
import { syncCommandHandlers } from "./registry";

/**
 * Old app versions (plan PR62). A device can keep running an older build for a
 * while (a tab left open, an update deferred by the queue), and the commands it
 * queued must still be understood by the server that is deployed after it.
 *
 * The golden file holds the payload and base version each command type puts in
 * the outbox TODAY. Changing what a builder emits fails the first test, which is
 * the moment to decide on purpose: keep the server accepting the old shape (the
 * second test must still pass), or give the command a new version/type. The rule
 * is that the contract only grows: new optional fields, new types, never a field
 * removed or reinterpreted. The server is deployed before the app that uses a new
 * field, because the sale payload is strict and refuses fields it does not know.
 */
const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const now = new Date("2026-10-14T12:30:00.000Z");
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const occurredOn = "2026-10-14";

async function currentPayloads() {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create", "inventory:adjust", "product:create"],
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
  let counter = 0;
  const common = () => {
    counter += 1;
    const n = counter;
    return {
      deviceId,
      lease,
      newCommandId: () => uuid(100 + n),
      now: () => now,
      organizationId,
      outbox,
      writer,
    };
  };
  await createOfflineCustomer({
    ...common(),
    input: {
      email: "ana@example.test",
      name: "Ana Souza",
      notes: "Cliente antigo",
      phone: "+5511999990000",
    },
    newCustomerId: () => uuid(201),
  });
  const product = await createOfflineProduct({
    ...common(),
    input: {
      categoryId: uuid(250),
      description: "Algodão",
      initialStock: { occurredOn, quantity: 10, unitCost: "20" },
      listPrice: "50.00",
      name: "Camiseta",
      sku: "CAM-01",
    },
    newProductId: () => uuid(301),
    newVariantId: () => uuid(302),
  });
  const variantId = product.rows.variant.id;
  const stock = () => ({
    ...common(),
    occurredOn,
    reader: writer,
    variantId,
  });
  await receiveStockOffline({ ...stock(), quantity: 5, unitCost: "30" });
  await writeOffStockOffline({
    ...stock(),
    quantity: 2,
    reasonCode: "damaged",
    reasonNote: "Caiu da prateleira",
  });
  await countStockOffline({
    ...stock(),
    physicalQuantity: 9,
    valuationUnitCost: null,
  });
  await createOfflineSale({
    ...common(),
    adjustments: [
      { kind: "freight", value: { amount: "10.00", type: "fixed" } },
    ],
    lines: [{ chargedUnitPrice: "45.00", quantity: 2, variantId }],
    payment: { method: "pix" },
    reader: writer,
  });
  // a sale priced with the payment profile the device saw (by id and version)
  await createOfflineSale({
    ...common(),
    lines: [{ chargedUnitPrice: "50.00", quantity: 1, variantId }],
    payment: { method: "debit_card" },
    paymentProfile: { expectedVersion: 3, id: uuid(601) },
    reader: writer,
  });
  const { commands } = await outbox.snapshot();
  return commands.map((command) => ({
    baseVersion: command.baseVersion,
    payload: command.payload,
    type: command.type,
  }));
}

describe("old app versions", () => {
  it("the payloads the client emits today are the ones committed, so a change is deliberate", async () => {
    await expect(
      `${JSON.stringify(await currentPayloads(), null, 2)}\n`
    ).toMatchFileSnapshot("./__golden__/command-payloads.json");
  });

  it("the server understands every committed payload: a build older than the server still syncs", async () => {
    const committed = JSON.parse(
      (await import("node:fs")).readFileSync(
        new URL("./__golden__/command-payloads.json", import.meta.url),
        "utf8"
      )
    ) as { baseVersion: number | null; payload: unknown; type: string }[];
    expect(committed.length).toBeGreaterThan(0);
    for (const { payload, type } of committed) {
      const handler = syncCommandHandlers.find((item) => item.type === type);
      expect(handler, `a handler for ${type}`).toBeDefined();
      expect(() => handler?.parse(payload), type).not.toThrow();
    }
    // every command type the server registers is covered by the golden file
    const covered = new Set(committed.map((entry) => entry.type));
    for (const handler of syncCommandHandlers) {
      expect(
        covered.has(handler.type),
        `golden payload for ${handler.type}`
      ).toBe(true);
    }
  });

  it("a build newer than the server is refused as an invalid payload, not applied halfway", () => {
    const sale = syncCommandHandlers.find(
      (item) => item.type === "sale.confirm"
    );
    const base = {
      adjustments: [],
      items: [
        {
          chargedUnitPrice: "10.00",
          listedUnitPrice: "10.00",
          quantity: 1,
          variantId: uuid(302),
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
    };
    expect(() => sale?.parse(base)).not.toThrow();
    expect(() => sale?.parse({ ...base, aFieldFromTheFuture: true })).toThrow();
  });
});
