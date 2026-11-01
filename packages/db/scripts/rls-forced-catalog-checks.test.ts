import { describe, expect, it } from "vitest";
import {
  RLS_EXEMPT_SCHEMAS,
  RLS_EXEMPT_TABLES,
  type RlsExemptSchema,
  type RlsExemptTable,
} from "../src/rls-exempt-tables";
import {
  type CatalogPolicy,
  type CatalogRelation,
  type CatalogSnapshot,
  catalogViolations,
  POLICIES_SQL,
  RELATIONS_SQL,
  SCHEMAS_SQL,
} from "./rls-forced-catalog-checks";

const table = (
  name: string,
  overrides: Partial<CatalogRelation> = {}
): CatalogRelation => ({
  forced: true,
  kind: "r",
  name,
  rowSecurity: true,
  securityInvoker: false,
  ...overrides,
});

const view = (
  name: string,
  overrides: Partial<CatalogRelation> = {}
): CatalogRelation => ({
  forced: false,
  kind: "v",
  name,
  rowSecurity: false,
  securityInvoker: true,
  ...overrides,
});

const policy = (
  tableName: string,
  name: string,
  roles: string[],
  permissive = true
): CatalogPolicy => ({ name, permissive, roles, table: tableName });

const healthy: CatalogSnapshot = {
  policies: [policy("sale", "sale_current_tenant", ["polaris_runtime"])],
  relations: [table("sale"), table("product", { kind: "p" })],
  schemas: ["drizzle"],
};
const drizzle: RlsExemptSchema = {
  reason: "migration journal",
  schema: "drizzle",
};
const planPrices: RlsExemptTable = {
  reason: "platform catalog, migration 0000",
  table: "plan_price",
};

const verdict = (
  snapshot: CatalogSnapshot,
  tables: readonly RlsExemptTable[] = [],
  schemas: readonly RlsExemptSchema[] = [drizzle]
) => catalogViolations(snapshot, tables, schemas);

describe("the catalog verdict of the rls-forced-catalog gate", () => {
  it("passes a catalog where every table forces row security, with drizzle exempt", () => {
    expect(verdict(healthy)).toEqual([]);
  });

  it("fails a table without row security, and says the table and what to do", () => {
    const found = verdict({
      ...healthy,
      relations: [
        ...healthy.relations,
        table("brand_new", { forced: false, rowSecurity: false }),
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("public.brand_new");
    expect(found[0]).toContain("RLS_EXEMPT_TABLES");
    expect(found[0]).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("fails a table that lost only FORCE, and one enabled with no FORCE on a partitioned table", () => {
    const found = verdict({
      ...healthy,
      relations: [
        table("sale", { forced: false }),
        table("product", { forced: false, kind: "p" }),
      ],
    });
    expect(found).toHaveLength(2);
  });

  it("fails a table with FORCE but row security not enabled", () => {
    expect(
      verdict({
        ...healthy,
        relations: [table("sale", { rowSecurity: false })],
      })
    ).toHaveLength(1);
  });

  it("accepts an unprotected table that is on the list", () => {
    expect(
      verdict(
        {
          ...healthy,
          relations: [
            table("plan_price", { forced: false, rowSecurity: false }),
          ],
        },
        [planPrices]
      )
    ).toEqual([]);
  });

  it("fails a list entry whose table is gone", () => {
    const found = verdict(healthy, [planPrices]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("plan_price");
    expect(found[0]).toContain("not a table of public any more");
  });

  it("fails a list entry whose table now forces row security", () => {
    const found = verdict({ ...healthy, relations: [table("plan_price")] }, [
      planPrices,
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("already has row security enabled and forced");
  });

  it("fails a list entry that names a view, not a table", () => {
    const found = verdict({ ...healthy, relations: [view("plan_price")] }, [
      planPrices,
    ]);
    expect(
      found.some((line) => line.includes("not a table of public any more"))
    ).toBe(true);
  });

  it("fails a repeated entry and an entry with no reason", () => {
    const found = verdict(
      {
        ...healthy,
        relations: [table("plan_price", { forced: false, rowSecurity: false })],
      },
      [planPrices, { reason: " ", table: "plan_price" }]
    );
    expect(found).toHaveLength(2);
    expect(found.join("\n")).toContain("more than once");
    expect(found.join("\n")).toContain("has no reason");
  });

  it("fails a view and a materialized view without security_invoker, and passes the ones with it", () => {
    const found = verdict({
      ...healthy,
      relations: [
        ...healthy.relations,
        view("plain_view", { securityInvoker: false }),
        view("plain_matview", { kind: "m", securityInvoker: false }),
        view("safe_view"),
        view("safe_matview", { kind: "m" }),
      ],
    });
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("view public.plain_view");
    expect(found[1]).toContain("materialized view public.plain_matview");
    expect(found[0]).toContain("deletion-ledger-restore.md");
  });

  it("fails a user schema besides public that is not on the list", () => {
    const found = verdict({ ...healthy, schemas: ["drizzle", "analytics"] });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("schema analytics");
    expect(found[0]).toContain("deletion-ledger-restore.md");
  });

  it("fails an exempt schema that does not exist, and a repeated one", () => {
    expect(verdict({ ...healthy, schemas: [] })).toHaveLength(1);
    expect(verdict(healthy, [], [drizzle, drizzle])).toHaveLength(1);
  });

  it("fails a foreign table, which has no row security, unless it is on the list", () => {
    const foreign = table("remote", {
      forced: false,
      kind: "f",
      rowSecurity: false,
    });
    const found = verdict({
      ...healthy,
      relations: [...healthy.relations, foreign],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("foreign table public.remote");
    expect(
      verdict({ ...healthy, relations: [...healthy.relations, foreign] }, [
        { reason: "planted", table: "remote" },
      ])
    ).toEqual([]);
  });

  it("fails a policy whose roles are {public}, and says the table and the policy", () => {
    const found = verdict({
      ...healthy,
      policies: [
        ...healthy.policies,
        policy("expenses", "open_to_all", ["public"]),
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("policy open_to_all on public.expenses");
    expect(found[0]).toContain("TO PUBLIC");
  });

  it("fails a policy whose roles are {public,other}, in either order", () => {
    const found = verdict({
      ...healthy,
      policies: [
        policy("expenses", "first", ["public", "polaris_runtime"]),
        policy("sale", "second", ["polaris_runtime", "public"]),
      ],
    });
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("policy first on public.expenses");
    expect(found[1]).toContain("policy second on public.sale");
  });

  it("passes a restrictive policy for {public}, which only narrows access", () => {
    expect(
      verdict({
        ...healthy,
        policies: [policy("sale", "narrow", ["public"], false)],
      })
    ).toEqual([]);
  });

  it("passes an empty policy list and policies that name only roles", () => {
    expect(verdict({ ...healthy, policies: [] })).toEqual([]);
    expect(
      verdict({
        ...healthy,
        policies: [
          policy("sale", "a", ["polaris_runtime"]),
          policy("sale", "b", ["polaris_runtime", "polaris_admin_runtime"]),
          policy("sale", "c", ["publicity"]),
        ],
      })
    ).toEqual([]);
  });

  it("keeps the exempt lists exactly as reviewed: no table, and the drizzle schema", () => {
    expect(RLS_EXEMPT_TABLES).toEqual([]);
    expect(RLS_EXEMPT_SCHEMAS.map((entry) => entry.schema)).toEqual([
      "drizzle",
    ]);
  });

  it("reads public only, user schemas besides public, and the security_invoker option as true, on, 1 or yes", () => {
    expect(RELATIONS_SQL).toContain("n.nspname = 'public'");
    expect(RELATIONS_SQL).toContain("c.relkind IN ('r', 'p', 'f', 'v', 'm')");
    expect(RELATIONS_SQL).toContain("security_invoker=(true|on|1|yes)");
    expect(SCHEMAS_SQL).toContain("nspname <> 'information_schema'");
    expect(SCHEMAS_SQL).toContain("nspname !~ '^pg_'");
    expect(POLICIES_SQL).toContain("schemaname = 'public'");
    expect(POLICIES_SQL).toContain("roles::text[]");
    expect(POLICIES_SQL).toContain("permissive = 'PERMISSIVE'");
  });
});
