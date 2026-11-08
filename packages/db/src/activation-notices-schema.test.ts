import { readdirSync, readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  activationEmailSuppressions,
  activationNotices,
  emailOptOuts,
} from "./schema/activation-notices";

const dialect = new PgDialect();
const TABLES = [activationNotices, emailOptOuts, activationEmailSuppressions];
const MIGRATION_NAME = /^\d{4}_avisos_de_ativacao\.sql$/;
const drizzleDirectory = new URL("../drizzle/", import.meta.url);
// found by its name: a renumbering at the merge does not break the test
const migrationSql = readFileSync(
  new URL(
    readdirSync(drizzleDirectory).find((name) => MIGRATION_NAME.test(name)) ??
      "missing-activation-migration.sql",
    drizzleDirectory
  ),
  "utf8"
);
/** Column names that would hold personal data or free text (ADR 0106, D1 and D8). */
const PERSONAL = new Set([
  "address",
  "agent",
  "amount",
  "body",
  "document",
  "email",
  "ip",
  "name",
  "phone",
  "text",
  "value",
]);
/** The one column named after an address holds its HMAC, never the address. */
const HMAC_COLUMN = "address_hmac";
const DESTRUCTIVE = /\b(DROP|RENAME|TRUNCATE|DELETE FROM|UPDATE public)\b/;
const ALTER_OF_ANOTHER_TABLE =
  /\bALTER TABLE (?!"?activation_|"?email_opt_outs|public\.(activation_|email_opt_outs))/;
const EMAIL_GRANT_TO_OWNER =
  /GRANT[^;]*\bemail\b[^;]*TO polaris_activation_notice_owner/;
const SESSION_GRANT_TO_OWNER =
  /GRANT[^;]*public\.session[^;]*TO polaris_activation_notice_owner/;
const CLOSED_LIST = String.raw`IN \('[a-z0-9_]+'`;
const SHORT_CODE = String.raw`~ '\^\[a-z\]\[a-z0-9_\]\{0,63\}\$'`;
const REFUSAL = String.raw`!~ '\[\[:space:\]\[:cntrl:\]@\]'`;

type SeriesTable = (typeof TABLES)[number];

function checksOf(table: SeriesTable): string[] {
  return getTableConfig(table).checks.map(
    (check) => dialect.sqlToQuery(check.value as never).sql
  );
}

/** A check holds the column to a closed list or a short code of lower-case letters, or refuses "@" outright. */
function refusesAt(column: string): RegExp {
  return new RegExp(`"${column}" (${CLOSED_LIST}|${SHORT_CODE}|${REFUSAL})`);
}

function textColumnsWithoutRefusal(table: SeriesTable): string[] {
  const { columns, name } = getTableConfig(table);
  const checks = checksOf(table);
  return columns
    .filter((column) => column.getSQLType() === "text")
    .filter(
      (column) => !checks.some((check) => refusesAt(column.name).test(check))
    )
    .map((column) => `${name}.${column.name}`);
}

/** The statements of the migration, without their comment lines. */
const statements = migrationSql.split("--> statement-breakpoint").map((part) =>
  part
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
);

describe("the tables of the activation series", () => {
  it("have no column for an address, a name, an IP, a free text or a value", () => {
    const columns = TABLES.flatMap((table) =>
      getTableConfig(table).columns.map((column) => column.name)
    );
    expect(
      columns.filter(
        (column) =>
          column !== HMAC_COLUMN &&
          column.split("_").some((part) => PERSONAL.has(part))
      )
    ).toEqual([]);
    expect(columns).toContain(HMAC_COLUMN);
  });

  it("refuse an @ in every text column", () => {
    expect(TABLES.flatMap(textColumnsWithoutRefusal)).toEqual([]);
  });

  it("would catch a text column left without the refusal", () => {
    expect(refusesAt("step").test("\"step\" IN ('a1', 'a2')")).toBe(true);
    expect(refusesAt("step").test("\"step\" ~ '^[a-z]'")).toBe(false);
    expect(refusesAt("user_id").test('"user_id" IS NOT NULL')).toBe(false);
  });

  it("keep the suppression as a 32-byte HMAC, never as text", () => {
    const hmac = getTableConfig(activationEmailSuppressions).columns.find(
      (column) => column.name === "address_hmac"
    );
    expect(hmac?.getSQLType()).toBe("bytea");
    expect(checksOf(activationEmailSuppressions)).toContain(
      'octet_length("activation_email_suppressions"."address_hmac") = 32'
    );
  });

  it("allow one notice per person and step, whatever the store", () => {
    const uniques = getTableConfig(activationNotices).uniqueConstraints.map(
      (constraint) => constraint.columns.map((column) => column.name)
    );
    expect(uniques).toEqual([["user_id", "step"]]);
  });

  it("take the notice with the membership and the opt-out with the account, but not the suppression", () => {
    const [membership] = getTableConfig(activationNotices).foreignKeys;
    expect(
      membership?.reference().columns.map((column) => column.name)
    ).toEqual(["organization_id", "user_id"]);
    expect(membership?.onDelete).toBe("cascade");
    expect(getTableConfig(emailOptOuts).foreignKeys[0]?.onDelete).toBe(
      "cascade"
    );
    expect(getTableConfig(activationEmailSuppressions).foreignKeys).toEqual([]);
  });

  it("come from a migration that only creates and grants", () => {
    expect(statements.filter((part) => DESTRUCTIVE.test(part))).toEqual([]);
    expect(
      statements.filter((part) => ALTER_OF_ANOTHER_TABLE.test(part))
    ).toEqual([]);
  });

  it("give the owner of the series neither the session nor the address, and the migration refuses both at its end", () => {
    expect(migrationSql).not.toMatch(EMAIL_GRANT_TO_OWNER);
    expect(migrationSql).not.toMatch(SESSION_GRANT_TO_OWNER);
    expect(migrationSql).toContain(
      "has_column_privilege('polaris_activation_notice_owner', 'public.\"user\"', 'email', 'SELECT')"
    );
    expect(migrationSql).toContain(
      "has_any_column_privilege('polaris_activation_notice_owner', 'public.session', 'SELECT')"
    );
  });
});
