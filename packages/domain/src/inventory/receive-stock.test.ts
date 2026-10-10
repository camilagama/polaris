import { describe, expect, it } from "vitest";
import {
  InvalidReceiveStockInputError,
  normalizeReceiveStockInput,
  UnsupportedReceiveStockCommandVersionError,
} from "./receive-stock";

const variantId = "0199c2d0-0000-7000-8000-000000000002";
const commandId = "0199c2d0-0000-7000-8000-000000000003";

describe("receiveStock command input", () => {
  it("normalizes a valid versioned receipt", () => {
    expect(
      normalizeReceiveStockInput({
        commandId,
        commandVersion: 1,
        occurredOn: "2026-10-09",
        quantity: 5,
        unitCost: "0012.34",
        variantId,
      })
    ).toEqual({
      commandId,
      commandVersion: 1,
      occurredOn: "2026-10-09",
      quantity: 5,
      unitCost: "12.340000",
      variantId,
    });
  });

  it("rejects invalid quantity, date, and UUIDs", () => {
    const base = {
      commandId,
      commandVersion: 1,
      occurredOn: "2026-10-09",
      quantity: 1,
      unitCost: "1.00",
      variantId,
    };

    expect(() => normalizeReceiveStockInput({ ...base, quantity: 0 })).toThrow(
      InvalidReceiveStockInputError
    );
    expect(() =>
      normalizeReceiveStockInput({ ...base, quantity: 1.5 })
    ).toThrow(InvalidReceiveStockInputError);
    expect(() =>
      normalizeReceiveStockInput({ ...base, occurredOn: "2026-02-29" })
    ).toThrow(InvalidReceiveStockInputError);
    expect(() =>
      normalizeReceiveStockInput({ ...base, commandId: "not-a-uuid" })
    ).toThrow(InvalidReceiveStockInputError);
    expect(() =>
      normalizeReceiveStockInput({ ...base, variantId: "not-a-uuid" })
    ).toThrow(InvalidReceiveStockInputError);
  });

  it("rejects unsupported command versions", () => {
    expect(() =>
      normalizeReceiveStockInput({
        commandId,
        commandVersion: 2,
        occurredOn: "2026-10-09",
        quantity: 1,
        unitCost: "1.00",
        variantId,
      })
    ).toThrow(UnsupportedReceiveStockCommandVersionError);
  });
});
