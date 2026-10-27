import { readdirSync, readFileSync } from "node:fs";
import { OUTBOX_EVENT_TYPES } from "@polaris/domain/events/outbox";
import { describe, expect, it } from "vitest";

/**
 * The naming of the events (dreaming of 27/10: the same review finding came back in 3 rounds of the billing ADR).
 * An event type, in the audit tables and in the outbox, is `domain.action`. A log key (`billing_command_rate_limited`)
 * and an error `reason` have another shape and never go in a CHECK of `event_type`. And one name does not mean two
 * things: the type of a hint in the outbox is not reused as the type of an audit row with another meaning.
 *
 * The audit lists are read from the migrations, the way the database holds them: the last form of each CHECK after
 * every DROP and ADD, in the order of the journal. The outbox types are the ones of the domain, which the policies of
 * the database repeat.
 */

const EVENT_TYPE = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

const MIGRATIONS_DIR = new URL("../drizzle/", import.meta.url);

interface Migration {
  name: string;
  sql: string;
}

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const DROP_CONSTRAINT =
  /ALTER TABLE (?:ONLY )?(?:public\.)?"?(\w+)"? DROP CONSTRAINT (?:IF EXISTS )?"?(\w+)"?/gi;
// `CONSTRAINT "name" CHECK ("table"."event_type" IN ('a.b', 'c.d'))`, in an ADD or inside a CREATE TABLE
const EVENT_TYPE_CHECK =
  /CONSTRAINT "(\w+)" CHECK \(\s*"(\w+)"\."event_type" IN \(([^)]*)\)\s*\)/g;
// a CHECK that opens with `event_type IN (...)` is a list of allowed types; one that only mentions event_type inside
// another condition (the actor coherence of 0087) restricts a subset of the list and is not one
const CHECK_STARTS_WITH_EVENT_TYPE =
  /CONSTRAINT "\w+" CHECK \(\s*(?:"?\w+"?\.)?"?event_type"? IN \(/;
const QUOTED_LITERAL = /'([^']*)'/g;

function migrationsInJournalOrder(): Migration[] {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", MIGRATIONS_DIR), "utf8")
  ) as { entries: { idx: number; tag: string }[] };
  const files = new Set(readdirSync(MIGRATIONS_DIR));
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map(({ tag }) => {
      expect(files.has(`${tag}.sql`), `${tag}.sql is in the journal`).toBe(
        true
      );
      return {
        name: tag,
        sql: readFileSync(new URL(`${tag}.sql`, MIGRATIONS_DIR), "utf8"),
      };
    });
}

/**
 * The CHECKs of `event_type` that list values, as they stand after the last migration: `table.constraint` -> values
 * (with the migration that wrote the CHECK). A statement that has a CHECK on `event_type` this reader cannot parse
 * throws, so a new way of writing it never passes unread.
 */
function finalEventTypeChecks(
  migrations: readonly Migration[]
): Map<string, { migration: string; values: string[] }> {
  const checks = new Map<string, { migration: string; values: string[] }>();
  for (const { name, sql } of migrations) {
    for (const statement of sql.split(STATEMENT_BREAKPOINT)) {
      for (const drop of statement.matchAll(DROP_CONSTRAINT)) {
        checks.delete(`${drop[1]}.${drop[2]}`);
      }
      const found = [...statement.matchAll(EVENT_TYPE_CHECK)];
      for (const [, constraint, table, list] of found) {
        const values = [...(list ?? "").matchAll(QUOTED_LITERAL)].map(
          (literal) => literal[1] ?? ""
        );
        checks.set(`${table}.${constraint}`, { migration: name, values });
      }
      if (CHECK_STARTS_WITH_EVENT_TYPE.test(statement) && found.length === 0) {
        throw new Error(
          `${name}: a CHECK of event_type that the reader does not parse`
        );
      }
    }
  }
  return checks;
}

function offPattern(values: readonly string[]): string[] {
  return values.filter((value) => !EVENT_TYPE.test(value));
}

// The shared names: one name in the audit and in the outbox, the same fact told twice. The test confirms the list is
// exactly this (a name added by someone is a decision, written here with its reason).
const SHARED_ON_PURPOSE: Readonly<Record<string, string>> = {
  "data_export.requested":
    "the same fact, an export was asked for: the audit row says who asked, the hint tells the consumer to build it (ADR 0078, ADR 0082)",
};

// Names that already stand in a merged migration and are off the pattern. Empty: none was found. A name added here
// is "legado", with the reason, and goes to the body of the PR for the decision.
const LEGACY_OFF_PATTERN: Readonly<Record<string, string>> = {};

const allMigrations = migrationsInJournalOrder();
const checks = finalEventTypeChecks(allMigrations);
const auditNames = new Map<string, string[]>();
for (const [key, { values }] of checks) {
  for (const value of values) {
    auditNames.set(value, [...(auditNames.get(value) ?? []), key]);
  }
}

describe("the event types the migrations allow in the audit tables", () => {
  it("reads the final CHECK of the tenant audit and of the platform audit", () => {
    expect([...checks.keys()].sort()).toEqual([
      "platform_audit_events.platform_audit_events_type_allowed",
      "tenant_audit_event.tenant_audit_event_type_registered",
    ]);
    // the last migration that rebuilt each one, and a list that is not empty
    expect(
      checks.get("platform_audit_events.platform_audit_events_type_allowed")
        ?.migration
    ).toBe("0105_funil_de_ativacao");
    expect(
      checks.get("tenant_audit_event.tenant_audit_event_type_registered")
        ?.migration
    ).toBe("0100_autosservico_de_cobranca");
    for (const { values } of checks.values()) {
      expect(values.length).toBeGreaterThan(20);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("are all domain.action, but the legacy ones the list names", () => {
    const off = offPattern([...auditNames.keys()]);
    expect(off.sort()).toEqual(Object.keys(LEGACY_OFF_PATTERN).sort());
  });
});

describe("the event types of the outbox", () => {
  it("are all domain.action, but the legacy ones the list names", () => {
    expect(OUTBOX_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(offPattern(OUTBOX_EVENT_TYPES).sort()).toEqual(
      Object.keys(LEGACY_OFF_PATTERN).filter((name) =>
        (OUTBOX_EVENT_TYPES as readonly string[]).includes(name)
      )
    );
  });

  it("are written by a migration (a policy or a function), so the domain list does not drift alone", () => {
    const all = allMigrations.map(({ sql }) => sql).join("\n");
    for (const type of OUTBOX_EVENT_TYPES) {
      expect(all, type).toContain(`'${type}'`);
    }
  });
});

describe("a name does not mean two things", () => {
  it("is in the audit and in the outbox only when the exceptions list says so", () => {
    const both = OUTBOX_EVENT_TYPES.filter((type) => auditNames.has(type));
    expect([...both].sort()).toEqual(Object.keys(SHARED_ON_PURPOSE).sort());
    for (const reason of Object.values(SHARED_ON_PURPOSE)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("is in one audit table only", () => {
    const twice = [...auditNames].filter(([, tables]) => tables.length > 1);
    expect(twice).toEqual([]);
  });
});

describe("the control cases, planted: the reader and the rules refuse them", () => {
  const planted = (
    name: string,
    list: string,
    table = "tenant_audit_event"
  ): Migration => ({
    name,
    sql: `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_type_allowed" CHECK ("${table}"."event_type" IN (${list}));`,
  });

  it("refuses a log key (billing_x) and a capitalized name (Billing.X) in a CHECK", () => {
    const read = finalEventTypeChecks([
      planted("9000_planted", "'billing.ok', 'billing_x', 'Billing.X'"),
    ]);
    const values = read.get(
      "tenant_audit_event.tenant_audit_event_type_allowed"
    )?.values;
    expect(values).toEqual(["billing.ok", "billing_x", "Billing.X"]);
    expect(offPattern(values ?? [])).toEqual(["billing_x", "Billing.X"]);
  });

  it("refuses names with a dash, a digit or two dots too", () => {
    expect(
      offPattern(["a-b.c", "a1.c", "a.b.c", "a.", ".a", "billing.refund_ok"])
    ).toEqual(["a-b.c", "a1.c", "a.b.c", "a.", ".a"]);
  });

  it("follows a DROP and the ADD after it: the last CHECK is the one that counts", () => {
    const read = finalEventTypeChecks([
      planted("9000_first", "'a.one'"),
      {
        name: "9001_second",
        sql: `ALTER TABLE "tenant_audit_event" DROP CONSTRAINT "tenant_audit_event_type_allowed";--> statement-breakpoint\n${planted("", "'a.two'").sql}`,
      },
    ]);
    expect(
      read.get("tenant_audit_event.tenant_audit_event_type_allowed")
    ).toEqual({ migration: "9001_second", values: ["a.two"] });
    const dropped = finalEventTypeChecks([
      planted("9000_first", "'a.one'"),
      {
        name: "9001_second",
        sql: `ALTER TABLE "tenant_audit_event" DROP CONSTRAINT "tenant_audit_event_type_allowed";`,
      },
    ]);
    expect(dropped.size).toBe(0);
  });

  it("reads a CHECK inside a CREATE TABLE", () => {
    const read = finalEventTypeChecks([
      {
        name: "9000_create",
        sql: `CREATE TABLE "t" (\n\t"event_type" text NOT NULL,\n\tCONSTRAINT "t_type_allowed" CHECK ("t"."event_type" IN ('a.b', 'billing_x'))\n);`,
      },
    ]);
    expect(read.get("t.t_type_allowed")?.values).toEqual(["a.b", "billing_x"]);
  });

  it("throws on a CHECK of event_type it cannot parse", () => {
    expect(() =>
      finalEventTypeChecks([
        {
          name: "9000_odd",
          sql: `ALTER TABLE "t" ADD CONSTRAINT "t_odd" CHECK ("event_type" IN ('a.b'));`,
        },
      ])
    ).toThrow("does not parse");
  });

  it("finds a name shared by the audit and the outbox that no list allows", () => {
    const read = finalEventTypeChecks([
      planted("9000_planted", "'billing.renewal_cancel_requested'"),
    ]);
    const planted_names = new Set(
      [...read.values()].flatMap(({ values }) => values)
    );
    const shared = OUTBOX_EVENT_TYPES.filter((type) => planted_names.has(type));
    expect(shared).toEqual(["billing.renewal_cancel_requested"]);
    expect(Object.keys(SHARED_ON_PURPOSE)).not.toContain(shared[0]);
  });
});
