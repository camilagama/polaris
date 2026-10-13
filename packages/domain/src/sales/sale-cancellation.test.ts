import { describe, expect, it } from "vitest";
import {
  CANCEL_SALE_COMMAND_VERSION,
  CANCELLATION_REASON_CODES,
  InvalidSaleCancellationError,
  MAX_CANCELLATION_NOTE_CODE_POINTS,
  normalizeCancelSaleCommand,
  planCancellationRestock,
  UnsupportedSaleCancellationCommandVersionError,
} from "./sale-cancellation";

const commandId = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a11";
const saleId = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a12";

function input(overrides: Record<string, unknown> = {}) {
  return {
    commandId,
    commandVersion: CANCEL_SALE_COMMAND_VERSION,
    saleId,
    ...overrides,
  } as Parameters<typeof normalizeCancelSaleCommand>[0];
}

describe("normalizeCancelSaleCommand", () => {
  it("accepts a bare cancellation with no reason", () => {
    expect(normalizeCancelSaleCommand(input())).toEqual({
      commandId,
      reasonCode: null,
      reasonNote: null,
      saleId,
    });
  });

  it("lowercases ids and trims the note", () => {
    expect(
      normalizeCancelSaleCommand(
        input({
          commandId: commandId.toUpperCase(),
          reasonCode: "customer_request",
          reasonNote: "  cliente desistiu \n",
          saleId: saleId.toUpperCase(),
        })
      )
    ).toEqual({
      commandId,
      reasonCode: "customer_request",
      reasonNote: "cliente desistiu",
      saleId,
    });
  });

  it("accepts every structured reason and requires a note only for other", () => {
    for (const reasonCode of CANCELLATION_REASON_CODES) {
      if (reasonCode === "other") {
        expect(() => normalizeCancelSaleCommand(input({ reasonCode }))).toThrow(
          InvalidSaleCancellationError
        );
        expect(
          normalizeCancelSaleCommand(
            input({ reasonCode, reasonNote: "outro motivo" })
          ).reasonNote
        ).toBe("outro motivo");
      } else {
        expect(
          normalizeCancelSaleCommand(input({ reasonCode })).reasonCode
        ).toBe(reasonCode);
      }
    }
  });

  it("rejects an unknown reason and a note without a reason", () => {
    expect(() =>
      normalizeCancelSaleCommand(input({ reasonCode: "fraud" }))
    ).toThrow(InvalidSaleCancellationError);
    expect(() =>
      normalizeCancelSaleCommand(input({ reasonNote: "só a nota" }))
    ).toThrow(InvalidSaleCancellationError);
    expect(() =>
      normalizeCancelSaleCommand(
        input({ reasonCode: "other", reasonNote: "   " })
      )
    ).toThrow(InvalidSaleCancellationError);
  });

  it("limits the note to 500 Unicode code points", () => {
    const limit = "𝒳".repeat(MAX_CANCELLATION_NOTE_CODE_POINTS);
    expect(
      normalizeCancelSaleCommand(
        input({ reasonCode: "other", reasonNote: limit })
      ).reasonNote
    ).toBe(limit);
    expect(() =>
      normalizeCancelSaleCommand(
        input({ reasonCode: "other", reasonNote: `${limit}x` })
      )
    ).toThrow(InvalidSaleCancellationError);
  });

  it("rejects notes PostgreSQL could not store faithfully", () => {
    for (const reasonNote of [
      "com\u0000nulo",
      "surrogate \ud800 solto",
      "x".repeat(5000),
    ]) {
      expect(() =>
        normalizeCancelSaleCommand(input({ reasonCode: "other", reasonNote }))
      ).toThrow(InvalidSaleCancellationError);
    }
  });

  it("rejects unsupported versions and malformed ids", () => {
    expect(() =>
      normalizeCancelSaleCommand(input({ commandVersion: 2 }))
    ).toThrow(UnsupportedSaleCancellationCommandVersionError);
    expect(() =>
      normalizeCancelSaleCommand(input({ commandId: "nope" }))
    ).toThrow(InvalidSaleCancellationError);
    expect(() => normalizeCancelSaleCommand(input({ saleId: "nope" }))).toThrow(
      InvalidSaleCancellationError
    );
  });
});

describe("planCancellationRestock", () => {
  it("restores every item at its own snapshot cost, in position order", () => {
    expect(
      planCancellationRestock([
        {
          position: 1,
          productId: "p2",
          quantity: 3,
          unitCost: null,
          variantId: "v2",
        },
        {
          position: 0,
          productId: "p1",
          quantity: 2,
          unitCost: "12.345678",
          variantId: "v1",
        },
      ])
    ).toEqual([
      {
        position: 0,
        productId: "p1",
        quantity: 2,
        unitCost: "12.345678",
        variantId: "v1",
      },
      {
        position: 1,
        productId: "p2",
        quantity: 3,
        unitCost: null,
        variantId: "v2",
      },
    ]);
  });

  it("refuses a sale without items", () => {
    expect(() => planCancellationRestock([])).toThrow(
      InvalidSaleCancellationError
    );
  });
});
