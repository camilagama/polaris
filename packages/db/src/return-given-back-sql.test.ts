import { readdirSync, readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  discountShareCents,
  discountSplitColumns,
  givenBackCents,
  itemCentsColumns,
} from "./return-given-back-sql";

const dialect = new PgDialect();
const render = (fragment: ReturnType<typeof sql>) =>
  dialect.sqlToQuery(fragment).sql.replace(/\s+/g, " ").trim();

const SRC = new URL("./", import.meta.url);
const RULE_MODULE = "return-given-back-sql.ts";
const RULE_USERS = ["customer-repository.ts", "economics-repository.ts"];

const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const PARTITIONED_WINDOW = /OVER \( ?PARTITION BY line\.sale_id/g;

const RULE_MARKERS = [
  /charged_unit_price\s*\*\s*100/,
  /split\.leftover/,
  /line\.quantity::numeric\s*\*\s*2/,
  /\bmod\(\s*\S+\s*\*\s*line\.value_cents/,
];

function sourceFiles(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(
      entry.isDirectory() ? `${entry.name}/` : entry.name,
      directory
    );
    if (entry.isDirectory()) {
      return sourceFiles(child);
    }
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)
      ? [child.pathname.slice(SRC.pathname.length)]
      : [];
  });
}

function filesWithTheRule(files: Record<string, string>) {
  return Object.entries(files)
    .filter(([, text]) => RULE_MARKERS.some((marker) => marker.test(text)))
    .map(([name]) => name)
    .sort();
}

describe("the rule of what a return gives back", () => {
  it("lives in one module of the package, and the two repositories import it", () => {
    const files = Object.fromEntries(
      sourceFiles(SRC).map((name) => [
        name,
        readFileSync(new URL(name, SRC), "utf8"),
      ])
    );
    expect(filesWithTheRule(files)).toEqual([RULE_MODULE]);
    for (const user of RULE_USERS) {
      expect(files[user]).toContain('from "./return-given-back-sql"');
    }
  });

  it("catches a copy of any piece of the rule in another file", () => {
    for (const piece of [
      "item.charged_unit_price * 100 AS unit_cents",
      "split.floor_cents + CASE WHEN split.rank <= split.leftover THEN 1 ELSE 0 END",
      "div(x + line.quantity, line.quantity::numeric * 2)",
      "ORDER BY mod(d.cents * line.value_cents, gross.cents) DESC",
    ]) {
      expect(
        filesWithTheRule({
          [RULE_MODULE]: piece,
          "other-repository.ts": `sql\`SELECT ${piece}\``,
          "clean.ts": "export const x = 1;",
        })
      ).toEqual(["other-repository.ts", RULE_MODULE].sort());
    }
  });

  it("splits one sale without a partition and many sales by their key", () => {
    const one = render(discountSplitColumns(sql`discount.cents`));
    expect(one).toContain("OVER ()");
    expect(one).toContain(
      "OVER ( ORDER BY mod(discount.cents * line.value_cents, gross.cents) DESC"
    );
    expect(one).not.toContain("PARTITION BY");

    const many = render(
      discountSplitColumns(sql`adjustment.discount_cents`, sql`line.sale_id`)
    );
    expect(many.match(PARTITIONED_WINDOW)).toHaveLength(2);
  });

  it("gives back price times units minus the share, rounded half up per item", () => {
    expect(render(givenBackCents)).toBe(
      "returned.quantity * line.unit_cents - div( coalesce(allocation.cents, 0) * returned.quantity * 2 + line.quantity, line.quantity::numeric * 2 )"
    );
    expect(render(discountShareCents)).toBe(
      "split.floor_cents + CASE WHEN split.rank <= split.leftover THEN 1 ELSE 0 END"
    );
    expect(render(itemCentsColumns(sql`item`))).toBe(
      "item.charged_unit_price * 100 AS unit_cents, item.charged_unit_price * item.quantity * 100 AS value_cents"
    );
  });
});
