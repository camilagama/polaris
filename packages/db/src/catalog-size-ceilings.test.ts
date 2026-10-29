import { readFileSync } from "node:fs";
import {
  MAX_PRODUCT_OPTION_VALUE_LENGTH,
  MAX_PRODUCT_VARIANT_SKU_LENGTH,
} from "@polaris/domain/catalog/product";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { productVariants } from "./schema/product";
import { productOptionValues } from "./schema/product-variants";

const MIGRATION = "0107_limite_de_sku_e_valor_de_opcao";
const dialect = new PgDialect();
const CEILING = /char_length\([^)]*\)\s*<=\s*(\d+)/g;
const NOT_VALID_AT_END = /\bNOT VALID;?\s*$/;
const migrationSql = readFileSync(
  new URL(`../drizzle/${MIGRATION}.sql`, import.meta.url),
  "utf8"
);

const ceilings = [
  {
    constraint: "product_option_values_name_max_length",
    domain: MAX_PRODUCT_OPTION_VALUE_LENGTH,
    table: productOptionValues,
  },
  {
    constraint: "product_variants_sku_max_length",
    domain: MAX_PRODUCT_VARIANT_SKU_LENGTH,
    table: productVariants,
  },
] as const;

function ceilingOf(sqlText: string): number {
  const found = [...sqlText.matchAll(CEILING)];
  expect(found, sqlText).toHaveLength(1);
  return Number(found[0]?.[1]);
}

function migrationDefinition(constraint: string): string {
  const statement = migrationSql
    .split("--> statement-breakpoint")
    .find((part) => part.includes(`ADD CONSTRAINT "${constraint}"`));
  expect(statement, constraint).toBeDefined();
  return statement ?? "";
}

describe("size ceilings of the catalog in the database", () => {
  it("the domain ceilings are the ones the constraints were written for", () => {
    expect([
      MAX_PRODUCT_OPTION_VALUE_LENGTH,
      MAX_PRODUCT_VARIANT_SKU_LENGTH,
    ]).toEqual([80, 64]);
  });

  for (const { constraint, domain, table } of ceilings) {
    it(`${constraint}: schema, migration and snapshot carry the domain number`, () => {
      const check = getTableConfig(table).checks.find(
        (candidate) => candidate.name === constraint
      );
      expect(check, `${constraint} is in the schema`).toBeDefined();
      const rendered = dialect.sqlToQuery(check?.value as never).sql;
      expect(ceilingOf(rendered)).toBe(domain);

      expect(ceilingOf(migrationDefinition(constraint))).toBe(domain);

      const snapshot = JSON.parse(
        readFileSync(
          new URL("../drizzle/meta/0107_snapshot.json", import.meta.url),
          "utf8"
        )
      ) as {
        tables: Record<
          string,
          { checkConstraints: Record<string, { value: string }> }
        >;
      };
      const tableName = getTableConfig(table).name;
      const recorded =
        snapshot.tables[`public.${tableName}`]?.checkConstraints[constraint];
      expect(recorded, `${constraint} is in the snapshot`).toBeDefined();
      expect(ceilingOf(recorded?.value ?? "")).toBe(domain);
    });
  }

  it("the migration adds both constraints NOT VALID and validates each of them", () => {
    for (const { constraint } of ceilings) {
      expect(migrationDefinition(constraint)).toMatch(NOT_VALID_AT_END);
      expect(migrationSql).toContain(`VALIDATE CONSTRAINT "${constraint}"`);
    }
  });
});
