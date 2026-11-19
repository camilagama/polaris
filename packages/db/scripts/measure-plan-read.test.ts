import { describe, expect, it } from "vitest";
import {
  assertLocalMeasureUrl,
  groupQueries,
  percentile,
  readOrganizationTotals,
  runsOf,
  warmupOf,
} from "./measure-plan-read";

const SHAPE_CHANGED = /changed its queries/;
const AT_LEAST_30 = /at least 30/;
const AT_LEAST_1 = /at least 1$/;
const SELECT_ONLY = /^SELECT/;
const WRITES = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i;
const LOCAL = "postgresql://owner:x@localhost:5432/polaris_gate";
const NEON =
  "postgresql://owner:x@ep-quiet-bird-a1b2c3d4.c-2.sa-east-1.aws.neon.tech/neondb";

describe("assertLocalMeasureUrl", () => {
  it("accepts the local PostgreSQL in CI", () => {
    expect(assertLocalMeasureUrl(LOCAL, true).hostname).toBe("localhost");
    expect(
      assertLocalMeasureUrl(
        "postgresql://owner:x@127.0.0.1:5432/polaris_gate",
        true
      ).hostname
    ).toBe("127.0.0.1");
  });

  it.each([
    ["no URL", undefined, true],
    ["a direct Neon endpoint, even a disposable one", NEON, true],
    [
      "a Neon pooler",
      "postgresql://owner:x@ep-quiet-bird-a1b2c3d4-pooler.c-2.sa-east-1.aws.neon.tech/neondb",
      true,
    ],
    ["another host", "postgresql://owner:x@db.example.com:5432/polaris", true],
    [
      "a local URL whose ?host= points elsewhere",
      `${LOCAL}?host=ep-quiet-bird-a1b2c3d4.c-2.sa-east-1.aws.neon.tech`,
      true,
    ],
    ["a local URL with ?hostaddr=", `${LOCAL}?hostaddr=10.0.0.5`, true],
    ["a protocol that is not postgres", "mysql://owner:x@localhost/db", true],
    ["the local PostgreSQL outside CI", LOCAL, false],
  ])("refuses %s", (_, url, ci) => {
    expect(() => assertLocalMeasureUrl(url, ci)).toThrow();
  });
});

describe("runsOf", () => {
  it("defaults to 30 and refuses fewer", () => {
    expect(runsOf(undefined)).toBe(30);
    expect(runsOf("45")).toBe(45);
    expect(() => runsOf("29")).toThrow(AT_LEAST_30);
    expect(() => runsOf("30.5")).toThrow(AT_LEAST_30);
    expect(() => runsOf("muitos")).toThrow(AT_LEAST_30);
  });
});

describe("warmupOf", () => {
  it("defaults to 5 and refuses no warm-up at all", () => {
    expect(warmupOf(undefined)).toBe(5);
    expect(warmupOf("1")).toBe(1);
    expect(() => warmupOf("0")).toThrow(AT_LEAST_1);
    expect(() => warmupOf("-2")).toThrow(AT_LEAST_1);
    expect(() => warmupOf("abc")).toThrow(AT_LEAST_1);
  });
});

describe("percentile", () => {
  it("takes the nearest rank", () => {
    const values = Array.from({ length: 20 }, (_, index) => 20 - index);
    expect(percentile(values, 0.5)).toBe(10);
    expect(percentile(values, 0.95)).toBe(19);
    expect(percentile(values, 1)).toBe(20);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
  });
});

// The shape of the SQL `readOwnerPlanTenantFacts` sends, cut short; the run on the database is what proves the
// patterns against drizzle's real text, and it refuses to report when they stop matching.
const READ = [
  'select "amount" from "billing_prices"',
  'select "key" from "plan_entitlements"',
  'select "state" from "organization_billing"',
  'select "key" from "entitlement_grants"',
  "SELECT now() AS now",
  'select count(distinct "products"."id")::int, count("product_variants"."id")::int from "products"',
  'select count(*)::int from "goals"',
  'select count(*) from "product_media"',
  'select count(*)::int from "product_variants"',
  'select min("occurred_on")::text, count(*)::int from "sales"',
  "SELECT now() AS now",
  'select "timezone" from "organizations"',
  'select count(*)::int from "products"',
].map((text) => ({ text }));

describe("groupQueries", () => {
  it("splits the read into catalogs, the four usage counts, the sales and the rest", () => {
    expect(groupQueries(READ)).toEqual([
      ...new Array(5).fill("catalogs"),
      ...new Array(4).fill("usageCounts"),
      "salesCount",
      ...new Array(3).fill("rest"),
    ]);
  });

  it("refuses a read whose shape changed", () => {
    expect(() => groupQueries(READ.filter((_, index) => index !== 7))).toThrow(
      SHAPE_CHANGED
    );
    expect(() => groupQueries(READ.slice(5))).toThrow(SHAPE_CHANGED);
    expect(() => groupQueries(READ.filter((_, index) => index !== 9))).toThrow(
      SHAPE_CHANGED
    );
  });
});

describe("readOrganizationTotals", () => {
  it("returns the total and the qa-medida-plano count with one read-only query", async () => {
    const calls: { text: string; values: unknown[] | undefined }[] = [];
    const client = {
      query: (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return Promise.resolve({ rows: [{ qa: 4, total: 11 }] });
      },
    };
    const totals = await readOrganizationTotals(client as never);
    expect(totals).toEqual({
      qaMedidaPlanoOrganizations: 4,
      totalOrganizations: 11,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text.trimStart()).toMatch(SELECT_ONLY);
    expect(calls[0]?.text).not.toMatch(WRITES);
    expect(calls[0]?.values).toEqual(["qa-medida-plano-"]);
  });

  it("reports zero for a database with no organizations", async () => {
    const client = { query: () => Promise.resolve({ rows: [] }) };
    expect(await readOrganizationTotals(client as never)).toEqual({
      qaMedidaPlanoOrganizations: 0,
      totalOrganizations: 0,
    });
  });
});
