import { describe, expect, it } from "vitest";
import { hasUnsentWork, isDraftChanged, markUnsentWork } from "./unsent-work";

describe("unsent work", () => {
  it("is held while any screen says so, and clears when the last one leaves", () => {
    expect(hasUnsentWork()).toBe(false);
    const sale = markUnsentWork("sale");
    const stock = markUnsentWork("stock");
    expect(hasUnsentWork()).toBe(true);
    sale();
    expect(hasUnsentWork()).toBe(true);
    stock();
    expect(hasUnsentWork()).toBe(false);
  });

  it("compares a draft with the one the form started with, field by field", () => {
    const initial = { amount: "", note: "x" };
    expect(isDraftChanged({ amount: "", note: "x" }, initial)).toBe(false);
    expect(isDraftChanged({ amount: "1", note: "x" }, initial)).toBe(true);
  });
});
