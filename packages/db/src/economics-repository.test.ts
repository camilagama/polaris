import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { InvalidSaleFactError } from "@polaris/domain/economics/sale-economics";
import {
  dailySalesQuery,
  inBlocks,
  periodSummaryQuery,
  readPeriodSummary,
} from "./economics-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "./tenant-transaction";

const PRODUCT_ORGANIZATION = /\bproduct\.organization_id = \$\d+/;
const TABLE_ALIAS = /\bpublic\.(\w+) AS (\w+)/g;

describe("inBlocks", () => {
  it("splits a list into consecutive blocks that keep every value once and in order", () => {
    expect(inBlocks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inBlocks([], 3)).toEqual([]);
    expect(inBlocks([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it("keeps a very long list under the block size", () => {
    const ids = Array.from({ length: 70_000 }, (_, index) => index);
    const blocks = inBlocks(ids, 5000);
    expect(blocks).toHaveLength(14);
    expect(
      Math.max(...blocks.map((block) => block.length))
    ).toBeLessThanOrEqual(5000);
    expect(blocks.flat()).toEqual(ids);
  });
});

/** Each `public.<table> AS <alias>` of a statement whose alias is never tied to an organization in it. */
function tablesWithoutOrganization(text: string): string[] {
  const tied = (table: string, alias: string) =>
    new RegExp(
      table === "organizations"
        ? String.raw`\b${alias}\.id = \$\d+`
        : String.raw`\b${alias}\.organization_id = (?:\$\d+|(?:sale|expense)\.organization_id)`
    ).test(text);
  return [...text.matchAll(TABLE_ALIAS)]
    .filter(([, table, alias]) => !tied(table as string, alias as string))
    .map(([, table, alias]) => `${table} AS ${alias}`);
}

describe("the statements of a period filter every table by the organization, besides RLS", () => {
  const dialect = new PgDialect();
  const period = { from: "2026-10-01", to: "2026-10-31" };
  const statements = {
    dailySalesQuery: dailySalesQuery("org", period),
    periodSummaryQuery: periodSummaryQuery("org", period),
    "periodSummaryQuery with a ranking": periodSummaryQuery("org", period, 3),
    "periodSummaryQuery by month": periodSummaryQuery("org", period, 3, {
      asOf: "2026-10-15T12:00:00.000Z",
    }),
  };

  it.each(Object.entries(statements))("%s", (_name, statement) => {
    const { sql } = dialect.sqlToQuery(statement);
    expect([...sql.matchAll(TABLE_ALIAS)].length).toBeGreaterThan(4);
    expect(tablesWithoutOrganization(sql)).toEqual([]);
  });

  it("finds a table read without the organization (control)", () => {
    const { sql } = dialect.sqlToQuery(periodSummaryQuery("org", period, 3));
    const planted = sql.replace(PRODUCT_ORGANIZATION, "product.id IS NOT NULL");
    expect(planted).not.toBe(sql);
    expect(tablesWithoutOrganization(planted)).toEqual(["products AS product"]);
  });
});

const identity = {
  capability: "report:read",
  organizationId: "org",
} as unknown as TenantRequestIdentity;

/** A transaction that answers every statement with these rows, and keeps the statements it was given. */
function answering(rows: readonly Record<string, unknown>[]) {
  const statements: string[] = [];
  const dialect = new PgDialect();
  const transaction = {
    execute: (statement: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      statements.push(dialect.sqlToQuery(statement).sql);
      return Promise.resolve({ rows });
    },
  } as unknown as TenantRequestTransaction;
  return { statements, transaction };
}

const ZERO_ROW = {
  anticipation: "0",
  cogs: "0",
  discounts: "0",
  gross: "0",
  invalid: 0,
  lines: 0,
  linked: "0",
  linked_count: 0,
  operating: "0",
  operating_count: 0,
  processing: "0",
  returns: "0",
  sales: 0,
  surcharges: "0",
  units: "0",
  unknown_anticipation: 0,
  unknown_cost: 0,
  unknown_processing: 0,
  unknown_sales: 0,
};

function dayRows(from: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...ZERO_ROW,
    date: new Date(Date.parse(`${from}T00:00:00Z`) + index * 86_400_000)
      .toISOString()
      .slice(0, 10),
    gross: String(100 * (index + 1)),
    sales: 1,
  }));
}

interface MonthRowShape {
  after_today?: boolean;
  date: string;
  days: number;
  last_date: string;
  operating?: string;
  unknown_sales?: number;
}

function monthRows(today: string, rows: readonly MonthRowShape[]) {
  return rows.map((row) => ({
    ...ZERO_ROW,
    after_today: false,
    gross: "1000",
    operating: "0",
    sales: 2,
    today,
    unknown_days: row.unknown_sales ? 1 : 0,
    ...row,
  }));
}

describe("readPeriodSummary: one entry per date up to 62 days, per month above", () => {
  it("reads 62 days by date, with the same statement and the same answer as before (no granularity, nothing apart)", async () => {
    const period = { from: "2026-09-01", to: "2026-11-01" };
    const { statements, transaction } = answering(dayRows(period.from, 62));
    const read = await readPeriodSummary(transaction, identity, period);
    expect(Object.keys(read)).toEqual(["daily", "reads", "result"]);
    expect(read.daily).toHaveLength(62);
    expect(Object.keys(read.daily[0] ?? {})).toEqual([
      "date",
      "netSales",
      "salesCount",
      "costs",
      "operatingExpenses",
      "operatingResult",
    ]);
    expect(statements).toEqual([
      new PgDialect().sqlToQuery(periodSummaryQuery("org", period)).sql,
    ]);
    expect(statements[0]).not.toContain("store_today");
  });

  it("reads 63 days by month: the ends cut by the period, each month with its last date, its days and its unknown days", async () => {
    const period = { from: "2026-08-15", to: "2026-10-16" };
    const { statements, transaction } = answering(
      monthRows("2026-11-04", [
        { date: "2026-08-15", days: 17, last_date: "2026-08-31" },
        {
          date: "2026-09-01",
          days: 30,
          last_date: "2026-09-30",
          unknown_sales: 1,
        },
        { date: "2026-10-01", days: 16, last_date: "2026-10-16" },
      ])
    );
    const read = await readPeriodSummary(transaction, identity, period, {
      asOf: "2026-11-04T15:00:00.000Z",
    });
    expect(statements[0]).toContain("store_today");
    expect(read.granularity).toBe("month");
    expect(read.afterToday).toBeUndefined();
    expect(read.daily).toEqual([
      expect.objectContaining({
        costs: "0.00",
        date: "2026-08-15",
        days: 17,
        netSales: "10.00",
        salesCount: 2,
        to: "2026-08-31",
        unknownDays: 0,
      }),
      expect.objectContaining({
        costs: null,
        date: "2026-09-01",
        days: 30,
        operatingResult: null,
        to: "2026-09-30",
        unknownDays: 1,
      }),
      expect.objectContaining({ date: "2026-10-01", to: "2026-10-16" }),
    ]);
    expect(read.result.netSales).toBe("30.00");
    expect(read.reads.days).toBe(3);
  });

  it("ends the month of today at today and keeps the dates after it apart, in the result too (D2-a)", async () => {
    const period = { from: "2026-09-20", to: "2026-12-18" };
    const { transaction } = answering(
      monthRows("2026-11-04", [
        { date: "2026-09-20", days: 11, last_date: "2026-09-30" },
        { date: "2026-10-01", days: 31, last_date: "2026-10-31" },
        { date: "2026-11-01", days: 4, last_date: "2026-11-04" },
        {
          after_today: true,
          date: "2026-11-05",
          days: 44,
          last_date: "2026-12-18",
          operating: "30000",
        },
      ]).map((row) =>
        row.after_today
          ? { ...row, gross: "0", operating_count: 1, sales: 0 }
          : row
      )
    );
    const read = await readPeriodSummary(transaction, identity, period, {
      asOf: "2026-11-04T15:00:00.000Z",
    });
    expect(read.daily.map((month) => month.date)).toEqual([
      "2026-09-20",
      "2026-10-01",
      "2026-11-01",
    ]);
    expect(read.daily.at(-1)).toEqual(
      expect.objectContaining({ days: 4, to: "2026-11-04" })
    );
    expect(read.afterToday).toEqual(
      expect.objectContaining({
        costs: "300.00",
        date: "2026-11-05",
        days: 44,
        operatingExpenses: "300.00",
        to: "2026-12-18",
      })
    );
    expect(read.result.operatingExpenses).toBe("300.00");
    expect(read.result.netSales).toBe("30.00");
    expect(read.reads.days).toBe(4);
  });

  it.each([
    [
      "a month missing",
      [{ date: "2026-08-15", days: 17, last_date: "2026-08-31" }],
    ],
    [
      "a month not cut by the period",
      [
        { date: "2026-08-01", days: 31, last_date: "2026-08-31" },
        { date: "2026-09-01", days: 30, last_date: "2026-09-30" },
        { date: "2026-10-01", days: 16, last_date: "2026-10-16" },
      ],
    ],
    [
      "a wrong count of days",
      [
        { date: "2026-08-15", days: 17, last_date: "2026-08-31" },
        { date: "2026-09-01", days: 29, last_date: "2026-09-30" },
        { date: "2026-10-01", days: 16, last_date: "2026-10-16" },
      ],
    ],
    [
      "dates after today in a month",
      [
        { date: "2026-08-15", days: 17, last_date: "2026-08-31" },
        { date: "2026-09-01", days: 30, last_date: "2026-09-30" },
        { date: "2026-10-01", days: 16, last_date: "2026-10-16" },
      ],
      "2026-10-10",
    ],
  ])(
    "refuses a monthly answer with %s",
    async (_, rows, today = "2026-11-04") => {
      const { transaction } = answering(monthRows(today, rows));
      await expect(
        readPeriodSummary(
          transaction,
          identity,
          { from: "2026-08-15", to: "2026-10-16" },
          { asOf: "2026-11-04T15:00:00.000Z" }
        )
      ).rejects.toBeInstanceOf(InvalidSaleFactError);
    }
  );

  it("refuses a monthly answer with no row (the store's today was not read)", async () => {
    const { transaction } = answering([]);
    await expect(
      readPeriodSummary(transaction, identity, {
        from: "2026-01-01",
        to: "2026-11-04",
      })
    ).rejects.toBeInstanceOf(InvalidSaleFactError);
  });
});
