import { describe, expect, it } from "vitest";
import { calendarDayInTimezone } from "../lib/dates";
import { lastPurchaseRowText, lastPurchaseValueText } from "./last-purchase";

const TODAY = "2026-11-21";

describe("the last purchase on the customer row", () => {
  it.each([
    ["2026-11-21", "Última compra hoje"],
    ["2026-11-20", "Última compra ontem"],
    ["2026-11-18", "Última compra há 3 dias"],
    ["2026-10-22", "Última compra há 30 dias"],
  ])("tells %s in days up to 30 of them", (day, text) => {
    expect(lastPurchaseRowText(day, TODAY)).toBe(text);
  });

  it("writes the date past 30 days, with the year only when it is not this year", () => {
    expect(lastPurchaseRowText("2026-10-21", TODAY)).toBe(
      "Última compra em 21/10"
    );
    expect(lastPurchaseRowText("2025-12-30", TODAY)).toBe(
      "Última compra em 30/12/2025"
    );
  });

  it("counts the days across a month and a leap day", () => {
    expect(lastPurchaseRowText("2026-02-28", "2026-03-02")).toBe(
      "Última compra há 2 dias"
    );
    expect(lastPurchaseRowText("2024-02-28", "2024-03-01")).toBe(
      "Última compra há 2 dias"
    );
  });

  it("says Sem compras only for a customer the server answered as having none", () => {
    expect(lastPurchaseRowText(null, TODAY)).toBe("Sem compras");
    expect(lastPurchaseRowText(undefined, TODAY)).toBeNull();
  });

  it("writes the date of a day after today, which the store's clock should not give", () => {
    expect(lastPurchaseRowText("2026-11-22", TODAY)).toBe(
      "Última compra em 22/11"
    );
  });
});

describe("the last purchase in the summary of the customer", () => {
  it("is the same moment as the row, with a capital for the days and the whole date past 30", () => {
    expect(lastPurchaseValueText("2026-11-21", TODAY)).toBe("Hoje");
    expect(lastPurchaseValueText("2026-11-20", TODAY)).toBe("Ontem");
    expect(lastPurchaseValueText("2026-11-18", TODAY)).toBe("Há 3 dias");
    expect(lastPurchaseValueText("2026-10-21", TODAY)).toBe("21/10/2026");
  });
});

describe("the store's day, not the device's", () => {
  const AT_2330_IN_SAO_PAULO = new Date("2026-11-22T02:30:00.000Z");
  const AT_MIDNIGHT_IN_SAO_PAULO = new Date("2026-11-22T03:00:00.000Z");

  it("turns at the midnight of São Paulo: 23:30 there is still the day of the purchase, midnight is the day after", () => {
    const before = calendarDayInTimezone(
      AT_2330_IN_SAO_PAULO,
      "America/Sao_Paulo"
    );
    expect(before).toBe("2026-11-21");
    expect(lastPurchaseRowText("2026-11-21", before)).toBe(
      "Última compra hoje"
    );
    const after = calendarDayInTimezone(
      AT_MIDNIGHT_IN_SAO_PAULO,
      "America/Sao_Paulo"
    );
    expect(after).toBe("2026-11-22");
    expect(lastPurchaseRowText("2026-11-21", after)).toBe(
      "Última compra ontem"
    );
  });
});
