import { describe, expect, it } from "vitest";
import {
  InvalidWriteOffStockInputError,
  normalizeWriteOffStockInput,
  UnsupportedWriteOffStockCommandVersionError,
} from "./write-off-stock";

const variantId = "0199c2d0-0000-7000-8000-000000000002";
const commandId = "0199c2d0-0000-7000-8000-000000000003";

const validInput = {
  commandId,
  commandVersion: 1,
  occurredOn: "2026-10-09",
  quantity: 2,
  reasonCode: "damaged",
  variantId,
};

describe("writeOffStock command input", () => {
  it("normalizes a versioned reason and optional note", () => {
    expect(
      normalizeWriteOffStockInput({
        ...validInput,
        reasonNote: "  embalagem rasgada  ",
      })
    ).toEqual({
      ...validInput,
      reasonNote: "embalagem rasgada",
    });
  });

  it("requires a note when the reason is other", () => {
    expect(() =>
      normalizeWriteOffStockInput({ ...validInput, reasonCode: "other" })
    ).toThrow(InvalidWriteOffStockInputError);

    expect(
      normalizeWriteOffStockInput({
        ...validInput,
        reasonCode: "other",
        reasonNote: "avaria não classificada",
      }).reasonNote
    ).toBe("avaria não classificada");
  });

  it("rejects an unknown reason code and blank notes", () => {
    expect(() =>
      normalizeWriteOffStockInput({ ...validInput, reasonCode: "obsolete" })
    ).toThrow(InvalidWriteOffStockInputError);
    expect(() =>
      normalizeWriteOffStockInput({ ...validInput, reasonNote: "   " })
    ).toThrow(InvalidWriteOffStockInputError);
    expect(() =>
      normalizeWriteOffStockInput({ ...validInput, reasonNote: "\u00a0" })
    ).toThrow(InvalidWriteOffStockInputError);
  });

  it("limits notes to 500 Unicode code points", () => {
    const maximumNote = "🙂".repeat(500);
    expect(
      normalizeWriteOffStockInput({
        ...validInput,
        reasonNote: maximumNote,
      }).reasonNote
    ).toBe(maximumNote);
    expect(() =>
      normalizeWriteOffStockInput({
        ...validInput,
        reasonNote: `${maximumNote}🙂`,
      })
    ).toThrow(InvalidWriteOffStockInputError);
  });

  it("rejects invalid quantity, date, and UUIDs", () => {
    expect(() =>
      normalizeWriteOffStockInput({ ...validInput, quantity: 0 })
    ).toThrow(InvalidWriteOffStockInputError);
    expect(() =>
      normalizeWriteOffStockInput({ ...validInput, quantity: 1.5 })
    ).toThrow(InvalidWriteOffStockInputError);
    expect(() =>
      normalizeWriteOffStockInput({ ...validInput, occurredOn: "2026-02-29" })
    ).toThrow(InvalidWriteOffStockInputError);
    expect(() =>
      normalizeWriteOffStockInput({ ...validInput, variantId: "not-a-uuid" })
    ).toThrow(InvalidWriteOffStockInputError);
  });

  it("rejects unsupported command versions", () => {
    expect(() =>
      normalizeWriteOffStockInput({ ...validInput, commandVersion: 2 })
    ).toThrow(UnsupportedWriteOffStockCommandVersionError);
  });
});
