import { describe, expect, it } from "vitest";
import { type CurrentCharge, currentChargeAfter } from "./facts";

const DAY_MS = 86_400_000;
const periodEnd = new Date("2026-12-10T03:00:00.000Z");
const at = (offsetMs: number): Date => new Date(periodEnd.getTime() + offsetMs);

const stored: CurrentCharge = {
  amount: "24.90",
  eventId: "0199a000-0000-7000-8000-000000000001",
  periodEndsAt: periodEnd,
};
const charge = (
  periodEndsAt: Date,
  amount: string | null = "29.90"
): CurrentCharge => ({
  amount,
  eventId: "0199a000-0000-7000-8000-000000000002",
  periodEndsAt,
});

describe("currentChargeAfter", () => {
  it("records the first charge it sees", () => {
    const first = charge(periodEnd, "24.90");
    expect(currentChargeAfter(null, first)).toEqual({
      charge: first,
      kind: "replace",
    });
  });

  it("records a first charge without amount as null, never a guess", () => {
    const first = charge(periodEnd, null);
    expect(currentChargeAfter(null, first)).toEqual({
      charge: first,
      kind: "replace",
    });
  });

  it("replaces everything with a renewal of another amount", () => {
    const renewal = charge(at(31 * DAY_MS), "29.90");
    expect(currentChargeAfter(stored, renewal)).toEqual({
      charge: renewal,
      kind: "replace",
    });
  });

  it("drops the old amount when the renewal carries none", () => {
    const renewal = charge(at(31 * DAY_MS), null);
    expect(currentChargeAfter(stored, renewal)).toEqual({
      charge: renewal,
      kind: "replace",
    });
  });

  it("keeps the stored charge for a late confirmation of an older period", () => {
    expect(currentChargeAfter(stored, charge(at(-31 * DAY_MS)))).toEqual({
      kind: "keep",
    });
  });

  it.each([
    ["the same instant", 0],
    ["a day later", DAY_MS],
    ["a day earlier", -DAY_MS],
  ])(
    "treats %s as the same period: a redelivery keeps it",
    (_label, offset) => {
      expect(currentChargeAfter(stored, charge(at(offset)))).toEqual({
        kind: "keep",
      });
    }
  );

  it("moves on one millisecond past the tolerance", () => {
    const renewal = charge(at(DAY_MS + 1));
    expect(currentChargeAfter(stored, renewal).kind).toBe("replace");
  });

  it("keeps an older period one millisecond before the tolerance", () => {
    expect(currentChargeAfter(stored, charge(at(-DAY_MS - 1))).kind).toBe(
      "keep"
    );
  });

  it("fills a missing amount from a second fact of the same period", () => {
    const withoutAmount = { ...stored, amount: null };
    expect(currentChargeAfter(withoutAmount, charge(at(3_600_000)))).toEqual({
      amount: "29.90",
      kind: "fill_amount",
    });
  });

  it("keeps a missing amount when the second fact has none either", () => {
    const withoutAmount = { ...stored, amount: null };
    expect(currentChargeAfter(withoutAmount, charge(periodEnd, null))).toEqual({
      kind: "keep",
    });
  });

  it("never fills an amount from an older period", () => {
    const withoutAmount = { ...stored, amount: null };
    expect(currentChargeAfter(withoutAmount, charge(at(-31 * DAY_MS)))).toEqual(
      { kind: "keep" }
    );
  });
});
