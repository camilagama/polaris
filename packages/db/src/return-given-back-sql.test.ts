import { readdirSync, readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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

const SOURCE_FILE = /\.(?:tsx?|mjs|js)$/;
const THIS_TEST = "return-given-back-sql.test.ts";

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
    return SOURCE_FILE.test(entry.name)
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
    delete files[THIS_TEST];
    expect(filesWithTheRule(files)).toEqual([RULE_MODULE]);
    for (const user of RULE_USERS) {
      expect(files[user]).toContain('from "./return-given-back-sql"');
    }
  });

  it("flags a piece of the rule copied into another file of packages/db/src, tests and subfolders included", () => {
    for (const piece of [
      "item.charged_unit_price * 100 AS unit_cents",
      "split.floor_cents + CASE WHEN split.rank <= split.leftover THEN 1 ELSE 0 END",
      "div(x + line.quantity, line.quantity::numeric * 2)",
      "ORDER BY mod(d.cents * line.value_cents, gross.cents) DESC",
    ]) {
      const copies = [
        "other-repository.ts",
        "schema/nested.ts",
        "other-repository.test.ts",
        "copy.mjs",
      ];
      expect(
        filesWithTheRule({
          [RULE_MODULE]: piece,
          ...Object.fromEntries(
            copies.map((name) => [name, `sql\`SELECT ${piece}\``])
          ),
          "clean.ts": "export const x = 1;",
        })
      ).toEqual([...copies, RULE_MODULE].sort());
    }
  });

  it("splits one sale without a partition and many sales by their key, the whole text of the fragment", () => {
    expect(render(discountSplitColumns(sql`discount.cents`))).toBe(
      "div(discount.cents * line.value_cents, gross.cents) AS floor_cents, discount.cents - sum(div(discount.cents * line.value_cents, gross.cents)) OVER () AS leftover, row_number() OVER ( ORDER BY mod(discount.cents * line.value_cents, gross.cents) DESC, line.position ) AS rank"
    );
    expect(
      render(
        discountSplitColumns(sql`adjustment.discount_cents`, sql`line.sale_id`)
      )
    ).toBe(
      "div(adjustment.discount_cents * line.value_cents, gross.cents) AS floor_cents, adjustment.discount_cents - sum(div(adjustment.discount_cents * line.value_cents, gross.cents)) OVER (PARTITION BY line.sale_id) AS leftover, row_number() OVER ( PARTITION BY line.sale_id ORDER BY mod(adjustment.discount_cents * line.value_cents, gross.cents) DESC, line.position ) AS rank"
    );
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
