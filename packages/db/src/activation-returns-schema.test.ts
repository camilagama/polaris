import { readdirSync, readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_RETURN_K,
  activationReturnWeeks,
} from "./schema/activation-returns";

const MIGRATION_NAME = /^\d{4}_m3_voltou_da_sessao\.sql$/;
const drizzleDirectory = new URL("../drizzle/", import.meta.url);
// found by its name: a renumbering at the merge does not break the test
const migrationSql = readFileSync(
  new URL(
    readdirSync(drizzleDirectory).find((name) => MIGRATION_NAME.test(name)) ??
      "missing-m3-migration.sql",
    drizzleDirectory
  ),
  "utf8"
);
const STRING_LITERAL = /'[^']*'/g;
/** The statements of the migration, without their comment lines and string literals (a privilege named in a check). */
const statements = migrationSql.split("--> statement-breakpoint").map((part) =>
  part
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(STRING_LITERAL, "''")
);
const FORBIDDEN_SESSION_COLUMNS = [
  "id",
  "token",
  "ip_address",
  "user_agent",
  "expires_at",
];
const DESTRUCTIVE =
  /\b(DROP|RENAME|(?<!BEFORE )TRUNCATE|DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b/;
const ALTER_OF_ANOTHER_TABLE =
  /\bALTER TABLE (?!"activation_return_weeks"|public\.activation_return_weeks)/;
const OWNER = "polaris_activation_owner";
const GRANTED_TABLE = /ON (?:TABLE )?(\S+)/;
const ROW_GRANT = /GRANT (SELECT|INSERT)\b/;
const COLUMN_LIST = /\(/;
const OWNER_TO_ADMIN =
  /GRANT[^;]*polaris_activation_owner[^;]*TO polaris_admin_owner/;
const SESSION_TO_ADMIN = /GRANT[^;]*public\.session[^;]*TO polaris_admin_owner/;
const GRANT_TO_OWNER = new RegExp(`GRANT [^;]* TO ${OWNER}\\b`);

describe("the frozen counts of the M3", () => {
  it("hold the week, the instant and the two cells, never a store, a person or an ID", () => {
    expect(
      getTableConfig(activationReturnWeeks)
        .columns.map((column) => column.name)
        .sort()
    ).toEqual(["cohort_week", "frozen_at", "never_returned", "returned"]);
  });

  it("refuse a cell under k or alone in the table itself", () => {
    expect(ACTIVATION_RETURN_K).toBe(5);
    expect(migrationSql).toContain(
      '("activation_return_weeks"."returned" IS NULL AND "activation_return_weeks"."never_returned" IS NULL) OR ("activation_return_weeks"."returned" IS NOT NULL AND "activation_return_weeks"."never_returned" IS NOT NULL AND "activation_return_weeks"."returned" >= 5 AND "activation_return_weeks"."never_returned" >= 5)'
    );
  });

  it("come from a migration that only creates and grants, and alters no other table", () => {
    expect(statements.filter((part) => DESTRUCTIVE.test(part))).toEqual([]);
    expect(
      statements.filter((part) => ALTER_OF_ANOTHER_TABLE.test(part))
    ).toEqual([]);
  });

  it("are append-only by triggers that fire always", () => {
    for (const trigger of [
      "activation_return_weeks_no_change",
      "activation_return_weeks_no_truncate",
    ]) {
      expect(migrationSql).toContain(
        `ALTER TABLE public.activation_return_weeks ENABLE ALWAYS TRIGGER ${trigger};`
      );
    }
  });
});

describe("the owner of the M3 in its migration", () => {
  const grantsToOwner = statements.filter((part) => GRANT_TO_OWNER.test(part));

  it("reads three columns of session and none of the forbidden ones", () => {
    const onSession = grantsToOwner.filter((part) =>
      part.includes("public.session")
    );
    expect(onSession.map((part) => part.trim())).toEqual([
      `GRANT SELECT (user_id, created_at, updated_at) ON TABLE public.session TO ${OWNER};`,
    ]);
    for (const column of FORBIDDEN_SESSION_COLUMNS) {
      expect(onSession.join("\n")).not.toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("gets no grant on products, the person, the access log or the devices, and every grant names its columns", () => {
    const tables = grantsToOwner.map(
      (part) => GRANTED_TABLE.exec(part)?.[1] ?? part
    );
    for (const table of [
      "public.products",
      'public."user"',
      "public.auth_access_log",
      "public.devices",
    ]) {
      expect(tables).not.toContain(table);
    }
    expect(
      grantsToOwner.filter(
        (part) => ROW_GRANT.test(part) && !COLUMN_LIST.test(part)
      )
    ).toEqual([]);
  });

  it("is never granted to the Admin owner, which owns every admin_* function", () => {
    expect(migrationSql).not.toMatch(OWNER_TO_ADMIN);
    expect(migrationSql).not.toMatch(SESSION_TO_ADMIN);
  });

  it("sets the lock timeout before the policy on session, and resets it last", () => {
    const timeout = migrationSql.indexOf("SET LOCAL lock_timeout = '10s';");
    const policy = migrationSql.indexOf(
      'CREATE POLICY "session_activation_owner_select" ON "session"'
    );
    expect(timeout).toBeGreaterThanOrEqual(0);
    expect(policy).toBeGreaterThan(timeout);
    expect(migrationSql.trimEnd().endsWith("RESET lock_timeout;")).toBe(true);
  });
});
