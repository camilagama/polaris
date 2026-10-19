import { readdirSync, readFileSync } from "node:fs";
import {
  ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS,
  ORGANIZATION_PURGE_REQUIRED_SCOPE,
} from "@polaris/domain/privacy/organization-purge";
import { describe, expect, it } from "vitest";
import { PURGE_BILLING_FACT_KEYS, PURGE_DELETE_ORDER } from "./purge-datasets";
import {
  PURGE_FUNCTIONS,
  type PurgeFunctionName,
  purgeFunctionDifferences,
} from "./purge-function-definitions";

const list = (names: readonly string[]) =>
  names.map((name) => `'${name}'`).join(", ");
const days = `${ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS} days`;

/** The shape `pg_get_functiondef` prints for the three functions, filled from the domain. */
function definitions(): Record<PurgeFunctionName, string> {
  return {
    admin_schedule_organization_purge: `CREATE OR REPLACE FUNCTION public.admin_schedule_organization_purge()
DECLARE
  whole_organization text[] := ARRAY[${list(ORGANIZATION_PURGE_REQUIRED_SCOPE)}];
BEGIN
  -- a closure younger than 30 days, said in a comment, is not the code
  /* nor is interval '30 days' in a block comment */
  IF privacy_scope IS NULL OR NOT (privacy_scope @> whole_organization) THEN
    RAISE EXCEPTION 'privacy_scope_incomplete -- not a comment';
  END IF;
  IF NOT (privacy_scope <@ whole_organization) THEN
    RAISE EXCEPTION 'privacy_scope_covers_kept_data';
  END IF;
  IF closure_requested + interval '${days}' > pg_catalog.now() THEN
    RAISE EXCEPTION 'closure_period_not_elapsed';
  END IF;
  due := GREATEST(window_end, closure_requested + interval '${days}') + p_delay_seconds * interval '1 second';
END;`,
    organization_purge_blocker: `CREATE OR REPLACE FUNCTION public.organization_purge_blocker(p_organization text)
 AS $function$
  SELECT 1 WHERE closure.requested_at + interval '${days}' <= pg_catalog.now()
$function$`,
    purge_organization_data: `CREATE OR REPLACE FUNCTION public.purge_organization_data(p_organization text)
DECLARE
  deleted_tables text[] := ARRAY[
    ${list(PURGE_DELETE_ORDER)}
  ];
  kept_fact_keys text[] := ARRAY[
    ${list(PURGE_BILLING_FACT_KEYS)}
  ];
BEGIN
  blocker := public.organization_purge_blocker(p_organization);
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', blocker USING ERRCODE = '55000';
  END IF;
  FOREACH target IN ARRAY deleted_tables LOOP
    EXECUTE pg_catalog.format('DELETE FROM public.%I WHERE organization_id = $1', target) USING p_organization;
  END LOOP;
  UPDATE public.billing_events SET fact = (SELECT 1 WHERE entry.key = ANY (kept_fact_keys));
END;`,
  };
}

function mutated(
  name: PurgeFunctionName,
  change: (definition: string) => string
) {
  const result = definitions();
  const before = result[name];
  result[name] = change(before);
  expect(result[name]).not.toBe(before);
  return purgeFunctionDifferences(result);
}

describe("purgeFunctionDifferences", () => {
  it("accepts functions that follow the domain", () => {
    expect(purgeFunctionDifferences(definitions())).toEqual([]);
  });

  it("covers the three functions the gate is mandatory for", () => {
    expect(Object.keys(definitions()).sort()).toEqual(
      [...PURGE_FUNCTIONS].sort()
    );
  });

  it("fails when the closure period goes back to 30 days in the scheduling", () => {
    const problems = mutated("admin_schedule_organization_purge", (sql) =>
      sql.replaceAll(`interval '${days}'`, "interval '30 days'")
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("interval '30 days'");
    expect(problems[2]).toContain("2 time(s)");
  });

  it("fails when the closure period goes back to 30 days in the blocker", () => {
    expect(
      mutated("organization_purge_blocker", (sql) =>
        sql.replace(`interval '${days}'`, "interval '30 days'")
      )
    ).toEqual([
      `organization_purge_blocker: interval '30 days' is not the closure period of ${days}`,
      `organization_purge_blocker: it must count the closure period of ${days} 1 time(s)`,
    ]);
  });

  it("fails when a period is written in another unit or removed", () => {
    expect(
      mutated("organization_purge_blocker", (sql) =>
        sql.replace(`interval '${days}'`, "interval '3 months'")
      )
    ).toHaveLength(2);
    expect(
      mutated("organization_purge_blocker", (sql) =>
        sql.replace(`interval '${days}'`, "interval '1 second'")
      )
    ).toEqual([
      "organization_purge_blocker: interval '1 second' is not the closure period of 90 days",
      "organization_purge_blocker: it must count the closure period of 90 days 1 time(s)",
    ]);
  });

  it("fails when audit_logs comes back into the scope", () => {
    const problems = mutated("admin_schedule_organization_purge", (sql) =>
      sql.replace("'media']", "'media', 'audit_logs']")
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("extra [audit_logs]");
  });

  it("fails when a category of the scope is dropped", () => {
    const problems = mutated("admin_schedule_organization_purge", (sql) =>
      sql.replace("'customers', ", "")
    );
    expect(problems[0]).toContain("missing [customers]");
  });

  it("fails when the purge deletes the audit of the tenant", () => {
    const problems = mutated("purge_organization_data", (sql) =>
      sql.replace("'memberships'", "'memberships', 'tenant_audit_event'")
    );
    expect(problems.join("\n")).toContain("extra [tenant_audit_event]");
    expect(problems.join("\n")).toContain("tables that survive the purge");
  });

  it("fails when a table leaves the list or the order changes", () => {
    expect(
      mutated("purge_organization_data", (sql) => sql.replace("'sales', ", ""))
    ).toHaveLength(1);
    expect(
      mutated("purge_organization_data", (sql) =>
        sql.replace("'sales', 'stock_movements'", "'stock_movements', 'sales'")
      )
    ).toHaveLength(1);
  });

  it("fails when another statement deletes or truncates", () => {
    expect(
      mutated(
        "purge_organization_data",
        (sql) =>
          `${sql.replace("END;", "")}DELETE FROM public.tenant_audit_event WHERE organization_id = p_organization;\nEND;`
      )
    ).toHaveLength(1);
    expect(
      mutated(
        "purge_organization_data",
        (sql) => `${sql.replace("END;", "")}TRUNCATE public.sales;\nEND;`
      )
    ).toHaveLength(1);
  });

  it("fails when the billing fact keys drift", () => {
    expect(
      mutated("purge_organization_data", (sql) =>
        sql.replace("'type', ", "'type', 'payerDocument', ")
      )[0]
    ).toContain("extra [payerDocument]");
  });

  it("fails when a declaration is missing, instead of passing on nothing", () => {
    expect(
      mutated("admin_schedule_organization_purge", (sql) =>
        sql.replace("whole_organization", "scope")
      )[0]
    ).toContain("whole_organization array is not declared");
  });

  it("fails when the due date no longer counts the period, even with a delay in seconds", () => {
    const problems = mutated("admin_schedule_organization_purge", (sql) =>
      sql.replace(
        `closure_requested + interval '${days}') + p_delay`,
        "closure_requested + interval '1 second') + p_delay"
      )
    );
    expect(problems.join("\n")).toContain(
      "interval '1 second' is not the closure period"
    );
  });

  it("fails when the period is written in a form that is not compared", () => {
    expect(
      mutated("admin_schedule_organization_purge", (sql) =>
        sql.replace(`interval '${days}') +`, "'30 days'::interval) +")
      ).join("\n")
    ).toContain("::interval or make_interval");
    expect(
      mutated("organization_purge_blocker", (sql) =>
        sql.replace(
          `interval '${days}'`,
          `make_interval(days => 30) + interval '${days}'`
        )
      ).join("\n")
    ).toContain("::interval or make_interval");
  });

  it("fails when a list is right but nothing reads it", () => {
    expect(
      mutated("purge_organization_data", (sql) =>
        sql.replace(
          "IN ARRAY deleted_tables LOOP",
          "IN ARRAY deleted_tables[1:5] LOOP"
        )
      )[0]
    ).toContain("the loop over deleted_tables is gone");
    expect(
      mutated("purge_organization_data", (sql) =>
        sql.replace(
          "blocker := public.organization_purge_blocker(p_organization);",
          "blocker := NULL;"
        )
      )[0]
    ).toContain("the call to organization_purge_blocker is gone");
    expect(
      mutated("admin_schedule_organization_purge", (sql) =>
        sql.replace(
          "IF NOT (privacy_scope <@ whole_organization) THEN",
          "IF false THEN"
        )
      )[0]
    ).toContain(
      "the check that the scope holds nothing the purge keeps is gone"
    );
    expect(
      mutated("purge_organization_data", (sql) =>
        sql.replace("kept_fact_keys)", "ARRAY[]::text[])")
      )[0]
    ).toContain("the filter of the billing fact by kept_fact_keys is gone");
  });

  it("fails when a list is assigned again or the purge calls something for effect", () => {
    expect(
      mutated("purge_organization_data", (sql) =>
        sql.replace("BEGIN", "BEGIN\n  deleted_tables := ARRAY['sales'];")
      )[0]
    ).toContain("deleted_tables must be assigned once");
    expect(
      mutated("purge_organization_data", (sql) =>
        sql.replace(
          "BEGIN",
          "BEGIN\n  PERFORM public.wipe_audit(p_organization);"
        )
      )[0]
    ).toContain("it calls a function with PERFORM");
  });

  it("fails on a list with an element that is not a literal", () => {
    expect(
      mutated("admin_schedule_organization_purge", (sql) =>
        sql.replace("'media']", "'media', extra_scope]")
      )[0]
    ).toContain("not declared with literals");
  });

  it("does not trip on the case of the keywords, or on a comment marker inside a string", () => {
    const result = definitions();
    result.admin_schedule_organization_purge =
      result.admin_schedule_organization_purge.replace(
        ":= ARRAY[",
        ":= array["
      );
    expect(purgeFunctionDifferences(result)).toEqual([]);
  });
});

describe("the migrations", () => {
  const migrations = readdirSync(new URL("../drizzle/", import.meta.url))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const BODY_DELIMITER = "$function$";

  /** The body each migration gives a function, the last one winning, as the replay of the migrations does. */
  function lastDefinition(name: PurgeFunctionName): string {
    const header = new RegExp(
      `CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`
    );
    let definition = "";
    for (const file of migrations) {
      const sql = readFileSync(
        new URL(`../drizzle/${file}`, import.meta.url),
        "utf8"
      );
      for (const match of sql.matchAll(new RegExp(header, "g"))) {
        const open = sql.indexOf(BODY_DELIMITER, match.index);
        const close = sql.indexOf(BODY_DELIMITER, open + BODY_DELIMITER.length);
        definition = sql.slice(match.index, close + BODY_DELIMITER.length);
      }
    }
    return definition;
  }

  it("leave the three purge functions as the domain says, with no database", () => {
    const final = Object.fromEntries(
      PURGE_FUNCTIONS.map((name) => [name, lastDefinition(name)])
    ) as Record<PurgeFunctionName, string>;
    for (const name of PURGE_FUNCTIONS) {
      expect(final[name], name).not.toBe("");
    }
    expect(purgeFunctionDifferences(final)).toEqual([]);
  });
});
