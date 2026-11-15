import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Support never archives, deletes or edits a store's product to open a slot (docs/business-rules/platform-admin.md):
 * those acts are permanent or silent, and the owner would neither know nor agree. The Admin has no path that
 * touches the catalog, and this keeps it so: no file of the Admin app and no file of the Admin's database code names
 * a catalog table, the catalog's schema or repository, or one of the catalog's write commands. Reading a product's
 * counts goes through the diagnostics, which return only numbers. A comment that names them fails too: say it in
 * the docs.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF = "apps/admin/src/product-confinement.test.ts";
const SKIPPED_DIRECTORIES = new Set([
  ".turbo",
  ".wrangler",
  "dist",
  "generated",
  "node_modules",
]);
const ADMIN_REPOSITORY = /^admin.*\.ts$/;
const TEXT_FILE = /\.(c|m)?(j|t)sx?$|\.sql$/;

const CATALOG_TABLES =
  "products|product_variants|product_options|product_option_values|variant_option_values|product_media|variant_media";
const CATALOG_SYMBOLS =
  "products|productVariants|productOptions|productOptionValues|variantOptionValues|productMedia|variantMedia";
const MARKERS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "SQL on a catalog table",
    pattern: new RegExp(
      `\\b(?:from|join|update|into|table|only|truncate)\\s+(?:"?public"?\\.)?"?(?:${CATALOG_TABLES})\\b`,
      "i"
    ),
  },
  {
    name: "a catalog table or module imported by name",
    pattern: new RegExp(
      `\\b(?:${CATALOG_SYMBOLS})\\b(?=[^;]*\\bfrom\\s+(?:["'][^"']*(?:schema|product|media)[^"']*["']|["']@polaris/db["']))`
    ),
  },
  {
    name: "a catalog table reached through a query builder or the schema namespace",
    pattern: new RegExp(
      `\\b(?:from|update|insert|delete|innerJoin|leftJoin|rightJoin|fullJoin)\\(\\s*(?:\\w+\\.)?(?:${CATALOG_SYMBOLS})\\b|\\bschema\\.(?:${CATALOG_SYMBOLS})\\b`
    ),
  },
  {
    name: "the catalog's schema or repository module",
    pattern:
      /["'][^"']*(?:product-repository|product-schema|schema\/product|schema\/media|media-schema|media-repository|public-catalog)[^"']*["']|["']@polaris\/db\/schema[^"']*["']/,
  },
  {
    name: "a catalog write command",
    pattern:
      /\b(?:create|update|archive|restore|delete|configure)Product(?![a-z])\w*|\bsetProductVariant\w*|\bchangeProductLifecycle\b/,
  },
];

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (TEXT_FILE.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

const dbSource = join(root, "packages/db/src");
const scanned = [
  ...walk(join(root, "apps/admin")),
  ...readdirSync(dbSource)
    .filter((name) => ADMIN_REPOSITORY.test(name))
    .map((name) => join(dbSource, name)),
]
  .map((path) => ({
    path: relative(root, path),
    text: readFileSync(path, "utf8"),
  }))
  .filter((file) => file.path !== SELF);

function touchingCatalog(
  files: readonly { path: string; text: string }[]
): string[] {
  return files
    .flatMap((file) =>
      MARKERS.filter((marker) => marker.pattern.test(file.text)).map(
        (marker) => `${file.path}: ${marker.name}`
      )
    )
    .sort();
}

describe("the Admin never touches a store's products", () => {
  it("walks the Admin app and the Admin's database repositories (the scan is not vacuous)", () => {
    const paths = scanned.map((file) => file.path);
    expect(paths).toContain("apps/admin/src/worker.ts");
    expect(paths).toContain("packages/db/src/admin-support-repository.ts");
    expect(paths).toContain("packages/db/src/admin-diagnostics-repository.ts");
  });

  it("leaves out this file and the folders of builds and dependencies", () => {
    const paths = scanned.map((file) => file.path);
    expect(paths).not.toContain(SELF);
    expect(paths.filter((path) => path.includes("node_modules"))).toEqual([]);
  });

  it("names no catalog table, module or write command", () => {
    expect(
      touchingCatalog(scanned),
      "Support never archives, deletes or edits a product to open a slot: the way out is the owner deleting archived products or the Pro plan, or a temporary release audited under billing:operate (docs/business-rules/platform-admin.md, docs/runbooks/atendimento-pedido-de-vaga.md)"
    ).toEqual([]);
  });

  const SQL = "SQL on a catalog table";
  const IMPORTED = "a catalog table or module imported by name";
  const MODULE = "the catalog's schema or repository module";
  const COMMAND = "a catalog write command";
  const BUILDER =
    "a catalog table reached through a query builder or the schema namespace";
  it.each([
    [
      "an UPDATE of products",
      'await db.query("UPDATE products SET x = 1")',
      [SQL],
    ],
    [
      "a DELETE of variants",
      "DELETE FROM product_variants WHERE id = $1",
      [SQL],
    ],
    [
      "an INSERT into products",
      'sql`insert into "products" (name) values (1)`',
      [SQL],
    ],
    [
      "a query builder over the table",
      "const rows = await db.select().from(products);",
      [BUILDER],
    ],
    [
      "the schema namespace",
      "await tx.update(schema.productVariants).set({});",
      [BUILDER],
    ],
    [
      "the schema barrel imported whole",
      'import * as schema from "@polaris/db/schema";',
      [MODULE],
    ],
    [
      "the package barrel",
      'import { products } from "@polaris/db";',
      [IMPORTED],
    ],
    [
      "a join on the media of a product",
      "JOIN public.product_media m ON m.id = 1",
      [SQL],
    ],
    [
      "the schema's table imported",
      'import { products } from "@polaris/db/product-schema";',
      [IMPORTED, MODULE],
    ],
    [
      "the repository's archive command",
      'import { archiveProduct } from "@polaris/db/product-repository";',
      [MODULE, COMMAND],
    ],
    [
      "a local call of the write command",
      "await deleteProduct(tx, who, input);",
      [COMMAND],
    ],
  ])("would catch %s", (_name, text, markers) => {
    expect(
      touchingCatalog([{ path: "apps/admin/src/planted.ts", text }])
    ).toEqual(
      markers.map((marker) => `apps/admin/src/planted.ts: ${marker}`).sort()
    );
  });

  it.each([
    ["an entitlement key", 'const key = "variants.active.max";'],
    ["a name that only starts like a command", "createProductionGuard(env);"],
    ["a usage count", "const usage = { archivedProducts: 0, products: 12 };"],
    ["the images-per-product key", 'const key = "images.per_product.max";'],
  ])("leaves %s alone", (_name, text) => {
    expect(
      touchingCatalog([{ path: "apps/admin/src/planted.ts", text }])
    ).toEqual([]);
  });
});
