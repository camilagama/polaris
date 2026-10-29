import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  dailySalesQuery,
  inBlocks,
  periodSummaryQuery,
} from "./economics-repository";

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
  const tied = (alias: string) =>
    new RegExp(
      String.raw`\b${alias}\.organization_id = (?:\$\d+|(?:sale|expense)\.organization_id)`
    ).test(text);
  return [...text.matchAll(TABLE_ALIAS)]
    .filter(([, , alias]) => !tied(alias as string))
    .map(([, table, alias]) => `${table} AS ${alias}`);
}

describe("the statements of a period filter every table by the organization, besides RLS", () => {
  const dialect = new PgDialect();
  const period = { from: "2026-10-01", to: "2026-10-31" };
  const statements = {
    dailySalesQuery: dailySalesQuery("org", period),
    periodSummaryQuery: periodSummaryQuery("org", period),
    "periodSummaryQuery with a ranking": periodSummaryQuery("org", period, 3),
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
