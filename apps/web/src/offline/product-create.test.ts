import {
  InvalidVariantListPriceError,
  ProductNameError,
} from "@polaris/domain/catalog/product";
import { InvalidUnitCostError } from "@polaris/domain/inventory/inventory-cost";
import { InvalidReceiveStockInputError } from "@polaris/domain/inventory/receive-stock";
import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../lib/offline-lease-token";
import { MemoryOutboxStorage } from "./outbox/memory-storage";
import { Outbox } from "./outbox/outbox";
import {
  createOfflineProduct,
  discardPendingProduct,
  ProductHasDependentCommandsError,
  pendingProducts,
  restorePendingProducts,
} from "./product-create";
import { syncOutbox } from "./sync-runner";
import { FakeCatalogServer, FakeWriter } from "./test-support";

const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const now = new Date("2026-10-14T12:30:00.000Z");
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function setup() {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["product:create", "inventory:adjust"],
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
  const server = new FakeCatalogServer();
  let counter = 0;
  const create = (
    input: Parameters<typeof createOfflineProduct>[0]["input"]
  ) => {
    counter += 1;
    const n = counter;
    return createOfflineProduct({
      deviceId,
      input,
      lease,
      newCommandId: () => uuid(100 + n),
      newProductId: () => uuid(200 + n),
      newVariantId: () => uuid(300 + n),
      now: () => now,
      organizationId,
      outbox,
      writer,
    });
  };
  const sync = (overrides: Partial<Parameters<typeof syncOutbox>[0]> = {}) =>
    syncOutbox({
      outbox,
      pull: { source: server, writer },
      push: server.push,
      ...overrides,
    });
  return { create, outbox, server, sync, writer };
}

const stock = { occurredOn: "2026-10-14", quantity: 12, unitCost: "8.5" };

describe("creating a product offline", () => {
  it("queues one command and shows the product, its variant and the opening stock at once", async () => {
    const { create, outbox, writer } = await setup();
    const { command, rows } = await create({
      description: "  Algodão  ",
      initialStock: stock,
      listPrice: "49.9",
      name: "  Camiseta  ",
      sku: " CAM-01 ",
    });

    expect(command).toMatchObject({
      commandId: uuid(101),
      status: "pending",
      type: "product.create",
    });
    expect(command.payload).toEqual({
      categoryId: null,
      description: "Algodão",
      initialStock: stock,
      listPrice: "49.90",
      name: "Camiseta",
      productId: uuid(201),
      sku: "CAM-01",
      variantId: uuid(301),
    });
    expect(writer.product(uuid(201))).toEqual(rows.product);
    expect(writer.variant(uuid(301))).toMatchObject({
      isDefault: true,
      listPrice: "49.90",
      productId: uuid(201),
      sku: "CAM-01",
    });
    expect(writer.stock(uuid(301))).toMatchObject({
      productId: uuid(201),
      quantity: 12,
    });
    expect((await outbox.snapshot()).commands).toHaveLength(1);
  });

  it("takes an opening stock without a cost: the command carries a null cost and the stock shows at once", async () => {
    const { create, writer } = await setup();
    const { command } = await create({
      initialStock: { occurredOn: "2026-10-14", quantity: 4, unitCost: null },
      name: "Caneca",
    });
    expect((command.payload as { initialStock: unknown }).initialStock).toEqual(
      { occurredOn: "2026-10-14", quantity: 4, unitCost: null }
    );
    expect(writer.stock(uuid(301))).toMatchObject({ quantity: 4 });
  });

  it("refuses an opening stock with an unknown cost that the server would refuse", async () => {
    const { create, outbox } = await setup();
    for (const quantity of [0, 1.5, 2_147_483_648]) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(
        create({
          initialStock: { occurredOn: "2026-10-14", quantity, unitCost: null },
          name: "A",
        })
      ).rejects.toBeInstanceOf(Error);
    }
    expect((await outbox.snapshot()).commands).toEqual([]);
  });

  it("without opening stock there is no inventory row and no stock in the command", async () => {
    const { create, writer } = await setup();
    const { command } = await create({ name: "Meia" });
    expect(
      (command.payload as { initialStock: unknown }).initialStock
    ).toBeNull();
    expect(writer.stock(uuid(301))).toBeUndefined();
    expect(writer.product(uuid(201))?.name).toBe("Meia");
  });

  it("refuses what the server would refuse, queueing and writing nothing", async () => {
    const { create, outbox, writer } = await setup();
    const cases: [Parameters<typeof create>[0], unknown][] = [
      [{ name: "   " }, ProductNameError],
      [{ listPrice: "12,50", name: "A" }, InvalidVariantListPriceError],
      [
        { initialStock: { ...stock, quantity: 0 }, name: "A" },
        InvalidReceiveStockInputError,
      ],
      [
        { initialStock: { ...stock, quantity: 1.5 }, name: "A" },
        InvalidReceiveStockInputError,
      ],
      [
        { initialStock: { ...stock, occurredOn: "2026-13-40" }, name: "A" },
        InvalidReceiveStockInputError,
      ],
      [
        { initialStock: { ...stock, unitCost: "abc" }, name: "A" },
        InvalidUnitCostError,
      ],
    ];
    for (const [input, error] of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: each probe is verified on its own
      await expect(create(input)).rejects.toBeInstanceOf(error as never);
    }
    expect((await outbox.snapshot()).commands).toEqual([]);
    expect(writer.data.products.size).toBe(0);
    expect(writer.data.variants.size).toBe(0);
    expect(writer.data.inventory.size).toBe(0);
  });

  it("confirms after a sync: the server's rows replace the optimistic ones", async () => {
    const { create, outbox, server, sync, writer } = await setup();
    await create({ initialStock: stock, name: "Camiseta", sku: "CAM-01" });

    const summary = await sync();

    expect(summary).toMatchObject({ accepted: 1, rejected: 0, replayed: 0 });
    expect((await outbox.snapshot()).commands).toEqual([]);
    expect(server.products.has(uuid(201))).toBe(true);
    expect(server.inventory.get(uuid(301))?.quantity).toBe(12);
    expect(writer.product(uuid(201))?.updatedAt).toBe(
      "2026-10-14T13:00:00.000Z"
    );
    expect(writer.stock(uuid(301))?.updatedAt).toBe("2026-10-14T13:00:00.000Z");
    expect(writer.meta?.cursor).toBe("2");
    expect(await pendingProducts(outbox)).toEqual([]);
  });

  it("is safe to push twice: a lost response is resent and replayed, creating the product once", async () => {
    const { create, outbox, server, sync } = await setup();
    await create({ initialStock: stock, name: "Camiseta" });
    server.lostResponses = 1;

    await expect(sync()).rejects.toThrow("network lost the response");
    expect(server.products.size).toBe(1);
    expect(server.executions).toBe(1);
    expect((await outbox.snapshot()).commands.map((c) => c.status)).toEqual([
      "pending",
    ]);

    const second = await sync();
    expect(second).toMatchObject({ accepted: 1, replayed: 1 });
    expect(server.executions).toBe(1);
    expect(server.products.size).toBe(1);
    expect(server.inventory.size).toBe(1);
  });

  it("a taken SKU is refused whole: no product, no variant, no stock, and the queue waits", async () => {
    const { create, outbox, server, sync, writer } = await setup();
    await create({ name: "Camiseta", sku: "CAM-01" });
    await sync();
    await create({
      initialStock: stock,
      name: "Outra camiseta",
      sku: "cam-01",
    });
    await create({ name: "Meia" });

    const summary = await sync();

    expect(summary).toMatchObject({
      accepted: 0,
      notProcessed: 1,
      rejected: 1,
    });
    expect(server.products.size).toBe(1);
    expect(server.variants.size).toBe(1);
    expect(server.inventory.size).toBe(0);
    expect(summary.blockedBy?.rejection?.code).toBe("sku_conflict");
    expect(await pendingProducts(outbox)).toMatchObject([
      { code: "sku_conflict", productId: uuid(202), state: "rejected" },
      { code: null, productId: uuid(203), state: "pending" },
    ]);
    // still visible locally, needing attention
    expect(writer.product(uuid(202))?.name).toBe("Outra camiseta");
    expect((await sync()).requests).toBe(0);
  });

  it("discarding a refused product removes the command and its local rows, and unblocks the queue", async () => {
    const { create, outbox, server, sync, writer } = await setup();
    await create({ name: "Camiseta", sku: "CAM-01" });
    await sync();
    await create({ initialStock: stock, name: "Duplicada", sku: "CAM-01" });
    await create({ name: "Meia" });
    await sync();

    await discardPendingProduct(outbox, writer, uuid(102));

    expect(writer.product(uuid(202))).toBeUndefined();
    expect(writer.variant(uuid(302))).toBeUndefined();
    expect(writer.stock(uuid(302))).toBeUndefined();
    expect(writer.product(uuid(201))).toBeDefined();
    const summary = await sync();
    expect(summary.accepted).toBe(1);
    expect([...server.products.keys()]).toEqual([uuid(201), uuid(203)]);
  });

  it("does not discard a product a later command refers to, nor one being sent", async () => {
    const { create, outbox, writer } = await setup();
    const { command } = await create({ name: "Camiseta" });
    await outbox.enqueue({
      baseVersion: null,
      commandId: uuid(150),
      deviceId,
      lease: command.lease,
      organizationId,
      payload: { quantity: 3, variantId: uuid(301) },
      type: "stock.receive",
    });
    await expect(
      discardPendingProduct(outbox, writer, command.commandId)
    ).rejects.toBeInstanceOf(ProductHasDependentCommandsError);

    const other = await create({ name: "Meia" });
    await outbox.markSending(other.command.commandId);
    await expect(
      discardPendingProduct(outbox, writer, other.command.commandId)
    ).rejects.toThrow("product_is_sending");
    expect(writer.product(uuid(201))).toBeDefined();
  });

  it("restores the local rows of queued products after a crash", async () => {
    const { create, outbox, writer } = await setup();
    await create({ initialStock: stock, name: "Camiseta" });
    writer.data.products.clear();
    writer.data.variants.clear();
    writer.data.inventory.clear();

    expect(await restorePendingProducts(outbox, writer)).toBe(1);
    expect(writer.product(uuid(201))?.name).toBe("Camiseta");
    expect(writer.variant(uuid(301))?.productId).toBe(uuid(201));
    expect(writer.stock(uuid(301))?.quantity).toBe(12);
  });
});
