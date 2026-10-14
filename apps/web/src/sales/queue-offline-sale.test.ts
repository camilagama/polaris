import { buildOfflineLeaseClaims } from "@polaris/domain/offline/offline-lease";
import { describe, expect, it } from "vitest";
import { signOfflineLease } from "../lib/offline-lease-token";
import { MemoryOutboxStorage } from "../offline/outbox/memory-storage";
import { Outbox } from "../offline/outbox/outbox";
import type { RuntimeContext } from "../offline/runtime/offline-runtime";
import { pendingSales } from "../offline/sale-confirm";
import { FakeWriter } from "../offline/test-support";
import { confirmOnDevice } from "./confirm-outcome";
import { queueOfflineSale } from "./queue-offline-sale";
import type { PreparedConfirmation, SaleAttempt } from "./sale-form-model";

const key = { id: "k1", secret: "s".repeat(40) };
const userId = "user-1";
const organizationId = "org-1";
const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";
const productId = "0199c2d0-0000-7000-8000-0000000000f1";
const shirt = "0199c2d0-0000-7000-8000-0000000000b1";
const now = new Date("2026-10-14T12:30:00.000Z");
const HOUR = 3_600_000;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function setup(expired = false) {
  const lease = await signOfflineLease(
    buildOfflineLeaseClaims({
      capabilities: ["sale:create"],
      deviceId,
      epoch: 0,
      expiresAt: new Date(now.getTime() + (expired ? -HOUR : 24 * HOUR)),
      grantId: uuid(900),
      issuedAt: new Date(now.getTime() - (expired ? 48 : 1) * HOUR),
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
  await writer.upsert("variants", [
    {
      id: shirt,
      isDefault: true,
      listPrice: "50.00",
      position: null,
      productId,
      sku: null,
      values: [],
    },
  ]);
  await writer.upsert("inventory", [
    {
      productId,
      quantity: 2,
      updatedAt: now.toISOString(),
      variantId: shirt,
      version: 1,
    },
  ]);
  const stores: RuntimeContext = {
    deviceId,
    lease,
    organizationId,
    outbox,
    writer,
  };
  return { outbox, stores, writer };
}

function prepared(
  overrides: { listed?: string; quantity?: number } = {}
): Extract<PreparedConfirmation, { ok: true }> {
  const attempt: SaleAttempt = {
    commandId: uuid(101),
    occurredAt: now.toISOString(),
    recordedAt: now.toISOString(),
    signature: "sig",
  };
  return {
    attempt,
    ok: true,
    request: {
      adjustments: [],
      commandId: attempt.commandId,
      commandVersion: 1,
      items: [
        {
          chargedUnitPrice: "45.00",
          listedUnitPrice: overrides.listed ?? "55.00",
          quantity: overrides.quantity ?? 2,
          variantId: shirt,
        },
      ],
      occurredAt: attempt.occurredAt,
      organizationId,
      payment: {
        anticipationRequested: false,
        installmentPlan: null,
        installments: null,
        method: "pix",
      },
      paymentProfile: null,
      recordedAt: attempt.recordedAt,
    },
  };
}

const labels = new Map([[shirt, "Camiseta — Azul / M"]]);

describe("queueing a validated sale on the device", () => {
  it("keeps ONE command with the attempt's ID and instant and the prices the person typed", async () => {
    const { outbox, stores } = await setup();
    const view = await queueOfflineSale({
      labels,
      request: prepared().request,
      stores,
    });

    const { commands } = await outbox.snapshot();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      commandId: uuid(101),
      status: "pending",
      type: "sale.confirm",
    });
    expect(commands[0]?.payload).toMatchObject({
      items: [
        {
          chargedUnitPrice: "45.00",
          // the typed list price, not the variant's 50.00
          listedUnitPrice: "55.00",
          quantity: 2,
          variantId: shirt,
        },
      ],
      occurredAt: now.toISOString(),
      recordedAt: now.toISOString(),
    });
    expect(view.commandId).toBe(uuid(101));
    expect(view.totalDue).toContain("90,00");
    expect(view.stockWarnings).toEqual([]);
  });

  it("queuing the same attempt again does not duplicate the sale", async () => {
    const { outbox, stores } = await setup();
    const { request } = prepared();
    await queueOfflineSale({ labels, request, stores });
    await queueOfflineSale({ labels, request, stores });
    expect((await outbox.snapshot()).commands).toHaveLength(1);
  });

  it("queues anyway when the device's stock looks short, and says which line", async () => {
    const { outbox, stores } = await setup();
    const view = await queueOfflineSale({
      labels,
      request: prepared({ quantity: 3 }).request,
      stores,
    });
    expect(view.stockWarnings).toEqual([
      "Camiseta — Azul / M: o aparelho mostra 2 em estoque e a venda tem 3.",
    ]);
    expect((await outbox.snapshot()).commands).toHaveLength(1);
  });

  it("shows the queued sale as pending until the server answers", async () => {
    const { outbox, stores } = await setup();
    await queueOfflineSale({ labels, request: prepared().request, stores });
    expect(await pendingSales(outbox)).toMatchObject([
      { commandId: uuid(101), itemCount: 1, state: "pending" },
    ]);
  });
});

describe("the outcome of confirming on the device", () => {
  it("completes: forgets the attempt, remembers the prices, and shows the queued sale", async () => {
    const { stores } = await setup();
    const outcome = await confirmOnDevice(prepared(), stores, labels);
    expect(outcome.completed).toBe(true);
    expect(outcome.attempt).toBeNull();
    expect(outcome.prices?.day).toBe("2026-10-14");
    expect(outcome.submission.phase).toBe("queued");
  });

  it("fails definitely when nothing could be queued (an expired authorization), keeping the attempt so the same sale can be tried again", async () => {
    const { stores } = await setup(true);
    const attempt = prepared();
    const outcome = await confirmOnDevice(attempt, stores, labels);
    expect(outcome.completed).toBe(false);
    expect(outcome.attempt).toBe(attempt.attempt);
    expect(outcome.submission.phase).toBe("failed");
    if (outcome.submission.phase === "failed") {
      expect(outcome.submission.failure.message).toContain("Nada foi guardado");
    }
  });
});

describe("a sale with a payment profile", () => {
  it("is kept with the profile by id and version", async () => {
    const { outbox, stores } = await setup();
    const withProfile = prepared();
    withProfile.request.paymentProfile = {
      expectedVersion: 4,
      id: "0199c2d0-0000-7000-8000-0000000000c1",
    };
    await queueOfflineSale({ labels, request: withProfile.request, stores });
    expect((await outbox.snapshot()).commands[0]?.payload).toMatchObject({
      paymentProfile: {
        expectedVersion: 4,
        id: "0199c2d0-0000-7000-8000-0000000000c1",
      },
    });
  });

  it("is refused when it carries a date of its own, which the device command cannot hold", async () => {
    const { outbox, stores } = await setup();
    const dated = prepared();
    dated.request.recordedAt = "2026-10-14T12:30:05.000Z";
    await expect(
      queueOfflineSale({ labels, request: dated.request, stores })
    ).rejects.toThrow("device_sale_not_carriable");
    expect((await outbox.snapshot()).commands).toHaveLength(0);
  });
});
