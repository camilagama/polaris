import {
  InsufficientStockError,
  InventoryVariantNotFoundError,
} from "@polaris/domain/inventory/inventory";
import {
  SaleCommandConflictError,
  SaleOccurredInFutureError,
  SaleProductUnavailableError,
} from "@polaris/domain/sales/confirm-sale";
import {
  PaymentProfileLifecycleError,
  PaymentProfileNotFoundError,
  PaymentProfileVersionConflictError,
} from "@polaris/domain/sales/payment-profile";
import { SaleOccurredTooOldError } from "@polaris/domain/sales/sale-dates";
import { describe, expect, it, vi } from "vitest";
import { InvalidSyncPayloadError } from "../push";
import { createSaleConfirmHandler } from "./sale-confirm";

const variantId = "0199c2d0-0000-7000-8000-0000000000b2";
const commandId = "0199c2d0-0000-7000-8000-0000000000a1";
const identity = {
  capability: "sync:push",
  organizationId: "org-1",
  role: "owner",
  userId: "user-1",
};
const profileId = "0199c2d0-0000-7000-8000-0000000000c1";
const selling = { ...identity, capability: "sale:create" };

const sale = {
  adjustments: [],
  items: [
    {
      chargedUnitPrice: "19.90",
      listedUnitPrice: "20.00",
      quantity: 2,
      variantId,
    },
  ],
  occurredAt: "2026-10-14T12:00:00.000Z",
  payment: {
    anticipationRequested: false,
    installmentPlan: null,
    installments: null,
    method: "pix",
  },
  recordedAt: "2026-10-14T12:00:05.000Z",
};

describe("sale.confirm handler", () => {
  it("declares its type and the sale capability", () => {
    const handler = createSaleConfirmHandler();
    expect(handler.type).toBe("sale.confirm");
    expect(handler.capability).toBe("sale:create");
  });

  it("accepts a well-formed sale and returns it unchanged", () => {
    const handler = createSaleConfirmHandler();
    expect(handler.parse(sale)).toEqual(sale);
  });

  it("refuses what the confirm command would refuse", () => {
    const handler = createSaleConfirmHandler();
    const bad: unknown[] = [
      null,
      [],
      {},
      { ...sale, items: [] },
      { ...sale, recordedAt: undefined },
      { ...sale, occurredAt: "yesterday" },
      { ...sale, extra: true },
      { ...sale, items: [{ ...sale.items[0], quantity: 0 }] },
      { ...sale, items: [{ ...sale.items[0], variantId: "nope" }] },
      { ...sale, payment: { ...sale.payment, method: "barter" } },
      {
        ...sale,
        adjustments: [
          { kind: "discount", value: { amount: "999", type: "fixed" } },
        ],
      },
      { ...sale, items: [{ ...sale.items[0], chargedUnitPrice: "abc" }] },
      { ...sale, paymentProfile: { expectedVersion: 1, id: "nope" } },
      { ...sale, paymentProfile: { expectedVersion: 0, id: profileId } },
      { ...sale, paymentProfile: { id: profileId } },
    ];
    for (const payload of bad) {
      expect(() => handler.parse(payload)).toThrow(InvalidSyncPayloadError);
    }
  });

  it("leaves a sale dated ahead of the server clock to its own refusal at execution", () => {
    const handler = createSaleConfirmHandler();
    const future = { ...sale, occurredAt: "2100-01-01T00:00:00.000Z" };
    expect(handler.parse(future)).toEqual(future);
  });

  it("confirms under the sale identity with the command ID, no payment profile, and returns the sale", async () => {
    const confirmSale = vi.fn(() =>
      Promise.resolve({
        sale: {
          confirmedAt: new Date("2026-10-14T13:00:00.000Z"),
          id: "sale-1",
        },
        totals: { totalDue: "39.80" },
      })
    );
    const handler = createSaleConfirmHandler({
      confirmSale: confirmSale as never,
    });
    const result = await handler.execute(
      {} as never,
      identity,
      handler.parse(sale),
      { baseVersion: null, commandId }
    );
    expect(confirmSale).toHaveBeenCalledWith({}, selling, {
      ...sale,
      commandId,
      commandVersion: 1,
      paymentProfile: null,
      requestId: commandId,
    });
    expect(result).toEqual({
      confirmedAt: "2026-10-14T13:00:00.000Z",
      saleId: "sale-1",
      totalDue: "39.80",
    });
  });

  it("accepts a sale priced with the payment profile the device saw, by id and version, and passes it on", async () => {
    const withProfile = {
      ...sale,
      paymentProfile: { expectedVersion: 3, id: profileId },
    };
    const confirmSale = vi.fn(() =>
      Promise.resolve({
        sale: {
          confirmedAt: new Date("2026-10-14T13:00:00.000Z"),
          id: "sale-1",
        },
        totals: { totalDue: "39.80" },
      })
    );
    const handler = createSaleConfirmHandler({
      confirmSale: confirmSale as never,
    });
    expect(handler.parse(withProfile)).toEqual(withProfile);
    expect(handler.parse({ ...sale, paymentProfile: null })).toEqual({
      ...sale,
      paymentProfile: null,
    });
    await handler.execute({} as never, identity, handler.parse(withProfile), {
      baseVersion: null,
      commandId,
    });
    expect(confirmSale).toHaveBeenCalledWith(
      {},
      selling,
      expect.objectContaining({
        paymentProfile: { expectedVersion: 3, id: profileId },
      })
    );
  });

  it("names a profile that changed or went away as its own refusals", () => {
    const { classify } = createSaleConfirmHandler();
    expect(classify(new PaymentProfileVersionConflictError())).toBe(
      "payment_profile_changed"
    );
    expect(classify(new PaymentProfileLifecycleError())).toBe(
      "payment_profile_unavailable"
    );
    expect(classify(new PaymentProfileNotFoundError())).toBe(
      "payment_profile_unavailable"
    );
  });

  it("names the refusals for the device, and nothing else", () => {
    const { classify } = createSaleConfirmHandler();
    expect(classify(new InsufficientStockError())).toBe("insufficient_stock");
    expect(classify(new SaleProductUnavailableError())).toBe(
      "sale_product_unavailable"
    );
    expect(classify(new InventoryVariantNotFoundError())).toBe(
      "variant_not_found"
    );
    expect(classify(new SaleOccurredTooOldError())).toBe(
      "sale_occurred_too_old"
    );
    expect(classify(new SaleOccurredInFutureError())).toBe(
      "sale_occurred_in_future"
    );
    expect(classify(new SaleCommandConflictError())).toBe(
      "sale_command_conflict"
    );
    expect(classify(new Error("db down"))).toBeNull();
  });
});
