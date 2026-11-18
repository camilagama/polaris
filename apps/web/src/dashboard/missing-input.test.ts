import { describe, expect, it } from "vitest";
import {
  missingDaysText,
  missingInputOf,
  singleUnknownMonth,
} from "./missing-input";

describe("missingDaysText", () => {
  it("writes day in the singular when the period has one day", () => {
    expect(
      missingDaysText(
        { input: "cost", month: null, total: 1, unknown: 1 },
        "informed"
      )
    ).toBe("1 de 1 dia sem custo informado");
  });

  it("keeps day in the plural for any other total", () => {
    expect(
      missingDaysText(
        { input: "fee", month: null, total: 2, unknown: 1 },
        "short"
      )
    ).toBe("1 de 2 dias sem taxa");
  });
});

describe("singleUnknownMonth", () => {
  it("is null when two months have unknown days", () => {
    expect(
      singleUnknownMonth(
        [
          { date: "2026-10-01", days: 31, unknownDays: 2 },
          { date: "2026-11-01", days: 17, unknownDays: 1 },
        ],
        "2026"
      )
    ).toBeNull();
  });

  it("is null when the month with unknown days carries no day count", () => {
    expect(
      singleUnknownMonth([{ date: "2026-11-01", unknownDays: 1 }], "2026")
    ).toBeNull();
  });
});

describe("missingInputOf", () => {
  it("is cost when an item line has unknown cost even with a fee unknown", () => {
    expect(
      missingInputOf({
        anticipationFeesUnknown: 1,
        itemLinesWithUnknownCost: 1,
        processingFeesUnknown: 1,
      })
    ).toBe("cost");
  });
});
