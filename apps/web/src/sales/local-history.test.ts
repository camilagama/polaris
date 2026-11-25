import type { SaleListEntryReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import { filterLocalSales } from "./local-history";
import {
  emptyHistoryFilters,
  historyRows,
  initialHistoryState,
} from "./sale-history-model";

const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sale = (
  n: number,
  overrides: Partial<SaleListEntryReadModel> = {}
): SaleListEntryReadModel => ({
  cancelledAt: null,
  confirmedAt: "2026-10-14T12:00:00.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: uuid(n),
  itemCount: 1,
  occurredAt: `2026-10-${String(10 + n).padStart(2, "0")}T12:00:00.000Z`,
  occurredOn: `2026-10-${String(10 + n).padStart(2, "0")}`,
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "10.00",
  ...overrides,
});

const rows = [
  sale(1, { customerId: uuid(90), customerName: "Ângela Souza" }),
  sale(2, { cancelledAt: "2026-10-13T12:00:00.000Z", status: "cancelled" }),
  sale(3, { hasReturns: true }),
  sale(4),
];

const ids = (page: { sales: readonly SaleListEntryReadModel[] }) =>
  page.sales.map((item) => item.id);

describe("the sale history read from the device", () => {
  it("lists newest first, whole, with no further pages", () => {
    const page = filterLocalSales(rows, emptyHistoryFilters);
    expect(ids(page)).toEqual([uuid(4), uuid(3), uuid(2), uuid(1)]);
    expect(page.hasMore).toBe(false);
  });

  it("filters by situation like the server", () => {
    expect(
      ids(
        filterLocalSales(rows, { ...emptyHistoryFilters, status: "cancelled" })
      )
    ).toEqual([uuid(2)]);
    expect(
      ids(
        filterLocalSales(rows, { ...emptyHistoryFilters, status: "confirmed" })
      )
    ).toEqual([uuid(4), uuid(3), uuid(1)]);
    expect(
      ids(
        filterLocalSales(rows, {
          ...emptyHistoryFilters,
          status: "with_returns",
        })
      )
    ).toEqual([uuid(3)]);
  });

  it("filters by commercial date, both ends included", () => {
    expect(
      ids(
        filterLocalSales(rows, {
          ...emptyHistoryFilters,
          from: "2026-10-12",
          to: "2026-10-13",
        })
      )
    ).toEqual([uuid(3), uuid(2)]);
  });

  it("filters by customer name, accents and case aside, and never matches a sale without a customer", () => {
    expect(
      ids(
        filterLocalSales(rows, { ...emptyHistoryFilters, customer: "angela" })
      )
    ).toEqual([uuid(1)]);
    expect(
      ids(filterLocalSales(rows, { ...emptyHistoryFilters, customer: "zzz" }))
    ).toEqual([]);
  });
});

describe("a sale paid in parts in the history read from the device", () => {
  it("keeps the methods of the parts the server sent, and its row says them in order", () => {
    const split = sale(5, {
      paymentMethod: "pix",
      paymentMethods: ["pix", "credit_card"],
    });
    const page = filterLocalSales([...rows, split], emptyHistoryFilters);
    const [first] = page.sales;
    expect(first?.paymentMethods).toEqual(["pix", "credit_card"]);
    const lines = historyRows({
      ...initialHistoryState(),
      sales: [...page.sales],
    });
    expect(lines[0]).toMatchObject({
      methodText: "Pix + Crédito",
      splitPayment: true,
    });
    expect(lines[1]).toMatchObject({ methodText: "Pix", splitPayment: false });
  });
});
