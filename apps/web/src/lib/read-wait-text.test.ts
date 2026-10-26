import { describe, expect, it } from "vitest";
import { updatedAtText } from "./read-wait-text";

const ZONE = "America/Sao_Paulo";

describe("updatedAtText", () => {
  it("the hour alone when the copy is of today in the store's zone", () => {
    expect(
      updatedAtText(
        "2026-10-23T17:05:00.000Z",
        ZONE,
        new Date("2026-10-23T20:00:00.000Z")
      )
    ).toBe("Atualizado às 14:05");
  });

  it("the day too when the copy is of another day (an old copy never passes for a fresh one)", () => {
    expect(
      updatedAtText(
        "2026-10-22T21:40:00.000Z",
        ZONE,
        new Date("2026-10-23T12:00:00.000Z")
      )
    ).toBe("Atualizado em 22/10 às 18:40");
  });

  it("nothing for a date it cannot read", () => {
    expect(updatedAtText("x", ZONE, new Date())).toBe("");
  });
});
