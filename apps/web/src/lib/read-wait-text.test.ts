import { describe, expect, it } from "vitest";
import { copyShownText } from "./read-wait-text";

const ZONE = "America/Sao_Paulo";

describe("copyShownText", () => {
  it("the hour alone, with what is not in it, when the copy is of today in the store's zone", () => {
    expect(
      copyShownText(
        "2026-10-23T17:05:00.000Z",
        ZONE,
        new Date("2026-10-23T20:00:00.000Z")
      )
    ).toBe(
      "Mostrando os números de 14:05. Vendas feitas depois não estão aqui."
    );
  });

  it("the day too when the copy is of another day (an old copy never passes for a fresh one)", () => {
    expect(
      copyShownText(
        "2026-10-22T21:40:00.000Z",
        ZONE,
        new Date("2026-10-23T12:00:00.000Z")
      )
    ).toBe(
      "Mostrando os números de 22/10 às 18:40. Vendas feitas depois não estão aqui."
    );
  });

  it("nothing for a date it cannot read", () => {
    expect(copyShownText("x", ZONE, new Date())).toBe("");
  });
});
