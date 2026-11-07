import { readdirSync, readFileSync } from "node:fs";
import { OUTBOX_EVENT_TYPES } from "@polaris/domain/events/outbox";
import { describe, expect, it } from "vitest";

/**
 * The naming of the events.
 * An event type, in the audit tables and in the outbox, is `domain.action`. A log key (`billing_command_rate_limited`)
 * and an error `reason` have another shape and never go in a CHECK of `event_type`. And one name does not mean two
 * things: the type of a hint in the outbox is not reused as the type of an audit row with another meaning.
 *
 * The audit lists are read from the migrations, the way the database holds them: the last form of each CHECK after
 * every DROP and ADD, in the order of the journal. The outbox types are the ones of the domain, and the policies of
 * `event_outbox` in the migrations must name the same ones (no type is written in the database and missing from the
 * domain, or the other way round). Log keys have no list in the code (each is a literal of a `logger` call), so there
 * is nothing to check for them here.
 *
 * Limits, said here so nobody trusts more than it does: the reader sees a CHECK written `CONSTRAINT "name" CHECK (...)`
 * (what drizzle writes), not an unnamed one; the policies of the outbox are the union of what every migration wrote
 * (a type that left the domain fails until the old policy is gone from the history, so it is a signal to look, not a
 * proof of the final policy); the third audit table, `auth_security_audit_event`, types `event_type` with an enum, read
 * from its CREATE TYPE and ADD VALUEs.
 */

const EVENT_TYPE = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

const MIGRATIONS_DIR = new URL("../drizzle/", import.meta.url);

interface Migration {
  name: string;
  sql: string;
}

interface EventTypeCheck {
  migration: string;
  values: string[];
}

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const ALTER_TABLE = /ALTER TABLE (?:ONLY )?(?:"?public"?\.)?"?(\w+)"?/i;
const CREATE_TABLE =
  /CREATE TABLE (?:IF NOT EXISTS )?(?:"?public"?\.)?"?(\w+)"?/i;
const DROP_TABLE = /DROP TABLE (?:IF EXISTS )?(?:"?public"?\.)?"?(\w+)"?/gi;
const DROP_CONSTRAINT = /DROP CONSTRAINT (?:IF EXISTS )?"?(\w+)"?/gi;
// `CONSTRAINT "name" CHECK (`: the body of a CHECK runs to the next CONSTRAINT or the end of the statement
const CHECK_START = /CONSTRAINT\s+"?(\w+)"?\s+CHECK\s*\(/gi;
const EVENT_TYPE_WORD = /\bevent_type\b/i;
// a CHECK that opens with `event_type IN ('a.b', 'c.d')`, the column alone or as "table"."event_type"
const LIST_CHECK =
  /^\s*(?:"?(\w+)"?\.)?"?event_type"?\s+IN\s*\(([^)]*)\)\s*\)/i;
const QUOTED_LITERAL = /'([^']*)'/g;
const JOURNAL_TAG = /^\d{4}_/;

// CHECKs that mention event_type and do not list the allowed types (a pattern of characters, a limit, or a rule on a
// subset of the list). Exact, each with its reason: any other CHECK of event_type that is not a list makes the reader
// throw.
const NOT_A_LIST: Readonly<Record<string, string>> = {
  "tenant_audit_event.tenant_audit_event_type_format":
    "a pattern of characters and a length (the shape of the name), not the list of the allowed ones: the list is the CHECK tenant_audit_event_type_registered",
  "queue_dead_letters.queue_dead_letters_event_type_format":
    "a pattern of characters and a length on the type of a dead letter, which is an outbox type: the outbox list is read from the domain",
  "platform_audit_events.platform_audit_events_actor_coherent":
    "a rule that ties the actor to a subset of the types (which ones carry an actor), not the list of the allowed ones: the list is platform_audit_events_type_allowed",
};

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

function tableOf(statement: string): string | undefined {
  return ALTER_TABLE.exec(statement)?.[1] ?? CREATE_TABLE.exec(statement)?.[1];
}

/** The CHECKs of the statement that mention event_type: constraint name, table and the text of the body. */
function eventTypeChecksOf(
  statement: string
): { body: string; constraint: string; table: string | undefined }[] {
  const starts = [...statement.matchAll(CHECK_START)];
  return starts
    .map((start, position) => ({
      body: statement.slice(
        (start.index ?? 0) + start[0].length,
        starts[position + 1]?.index ?? statement.length
      ),
      constraint: start[1] ?? "",
      table: tableOf(statement),
    }))
    .filter(({ body }) => EVENT_TYPE_WORD.test(body));
}

/**
 * The CHECKs of `event_type` that list values, as they stand after the last migration: `table.constraint` -> values
 * (with the migration that wrote the CHECK). A CHECK of event_type that is not such a list and is not in
 * `NOT_A_LIST` throws, so a new way of writing it (`= ANY(ARRAY[...])`, `event_type = 'a' OR ...`, another case)
 * never passes unread.
 */
function readEventTypeChecks(migrations: readonly Migration[]): {
  checks: Map<string, EventTypeCheck>;
  unread: Map<string, string>;
} {
  const checks = new Map<string, EventTypeCheck>();
  // the CHECKs of event_type that are not a list and still stand: `table.constraint` -> migration
  const unread = new Map<string, string>();
  const forget = (table: string, constraint?: string) => {
    for (const found of [checks, unread]) {
      for (const key of [...found.keys()]) {
        const sameTable = key.startsWith(`${table}.`);
        if (sameTable && (!constraint || key === `${table}.${constraint}`)) {
          found.delete(key);
        }
      }
    }
  };
  for (const { name, sql } of migrations) {
    for (const statement of sql.split(STATEMENT_BREAKPOINT)) {
      for (const drop of statement.matchAll(DROP_TABLE)) {
        forget(drop[1] ?? "");
      }
      for (const drop of statement.matchAll(DROP_CONSTRAINT)) {
        forget(tableOf(statement) ?? "", drop[1]);
      }
      for (const check of eventTypeChecksOf(statement)) {
        const list = LIST_CHECK.exec(check.body);
        if (!list) {
          unread.set(`${check.table}.${check.constraint}`, name);
          continue;
        }
        const values = [...(list[2] ?? "").matchAll(QUOTED_LITERAL)].map(
          (literal) => literal[1] ?? ""
        );
        checks.set(`${list[1] ?? check.table}.${check.constraint}`, {
          migration: name,
          values,
        });
      }
    }
  }
  return { checks, unread };
}

function finalEventTypeChecks(
  migrations: readonly Migration[]
): Map<string, EventTypeCheck> {
  const { checks, unread } = readEventTypeChecks(migrations);
  // only a CHECK that stands after the last migration has to be readable: one a later migration drops is history
  for (const [key, name] of unread) {
    if (!(key in NOT_A_LIST)) {
      throw new Error(
        `${name}: the CHECK ${key} on event_type is not a list the reader parses`
      );
    }
  }
  return checks;
}

// a comment line of the migration before the statement (or inside it) is not code: a type named in prose does not count
const SQL_LINE_COMMENT = /--[^\n]*/g;
const POLICY_ON_OUTBOX =
  /^\s*(?:CREATE|ALTER) POLICY\s+"?\w+"?\s+ON\s+(?:"?public"?\.)?"?event_outbox"?/i;
// `type = 'a.b'` and `"event_outbox"."type" IN ('a.b', 'c.d')`; `entity_type` is another word
const POLICY_TYPE = /\btype"?\s*(?:=\s*'([^']+)'|IN\s*\(([^)]*)\))/gi;

/** The types the policies on `event_outbox` name, over every migration. */
function outboxTypesOfPolicies(migrations: readonly Migration[]): Set<string> {
  const types = new Set<string>();
  for (const { sql } of migrations) {
    for (const statement of sql.split(STATEMENT_BREAKPOINT)) {
      const code = statement.replace(SQL_LINE_COMMENT, "");
      if (!POLICY_ON_OUTBOX.test(code)) {
        continue;
      }
      for (const found of code.matchAll(POLICY_TYPE)) {
        const literals = found[1]
          ? [found[1]]
          : [...(found[2] ?? "").matchAll(QUOTED_LITERAL)].map(
              (literal) => literal[1] ?? ""
            );
        for (const literal of literals) {
          types.add(literal);
        }
      }
    }
  }
  return types;
}

const AUTH_ENUM = "auth_security_audit_event_type";
const AUTH_ENUM_CREATE = new RegExp(
  String.raw`CREATE TYPE\s+(?:"?public"?\.)?"?${AUTH_ENUM}"?\s+AS ENUM\s*\(([^)]*)\)`,
  "gi"
);
const AUTH_ENUM_ADD = new RegExp(
  String.raw`ALTER TYPE\s+(?:"?public"?\.)?"?${AUTH_ENUM}"?\s+ADD VALUE\s+(?:IF NOT EXISTS\s+)?'([^']*)'`,
  "gi"
);

/**
 * The values of the enum that types `auth_security_audit_event_type` of the auth audit (an enum, not a CHECK), over
 * every migration: Postgres never removes a value of an enum, so the union of the CREATE and of the ADD VALUEs is the
 * final list.
 */
function authAuditTypes(migrations: readonly Migration[]): string[] {
  const values: string[] = [];
  for (const { sql } of migrations) {
    const code = sql.replace(SQL_LINE_COMMENT, "");
    for (const created of code.matchAll(AUTH_ENUM_CREATE)) {
      values.push(
        ...[...(created[1] ?? "").matchAll(QUOTED_LITERAL)].map(
          (literal) => literal[1] ?? ""
        )
      );
    }
    for (const added of code.matchAll(AUTH_ENUM_ADD)) {
      values.push(added[1] ?? "");
    }
  }
  return values;
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
const LEGACY_AUTH_REASON =
  "legado: value of the enum auth_security_audit_event_type, written before the convention (the auth audit is a log of snake_case facts of the sign-in, with no domain); renaming a value of an enum is a migration, out of this task, and goes to the body of the PR for the decision";
const LEGACY_OFF_PATTERN: Readonly<Record<string, string>> = {
  device_revoked: LEGACY_AUTH_REASON,
  google_callback_failed: LEGACY_AUTH_REASON,
  google_callback_succeeded: LEGACY_AUTH_REASON,
  google_login_started: LEGACY_AUTH_REASON,
  login_locked: LEGACY_AUTH_REASON,
  login_unlocked: LEGACY_AUTH_REASON,
  logout_failed: LEGACY_AUTH_REASON,
  logout_succeeded: LEGACY_AUTH_REASON,
  password_changed: LEGACY_AUTH_REASON,
  password_reset_completed: LEGACY_AUTH_REASON,
  password_set: LEGACY_AUTH_REASON,
  unverified_user_deleted: LEGACY_AUTH_REASON,
};

const allMigrations = migrationsInJournalOrder();
const checks = finalEventTypeChecks(allMigrations);
const unreadKeys = [...readEventTypeChecks(allMigrations).unread.keys()];
const auditNames = new Map<string, string[]>();
for (const [key, { values }] of checks) {
  for (const value of values) {
    auditNames.set(value, [...(auditNames.get(value) ?? []), key]);
  }
}
const authTypes = authAuditTypes(allMigrations);
for (const value of authTypes) {
  auditNames.set(value, [
    ...(auditNames.get(value) ?? []),
    `auth_security_audit_event.${AUTH_ENUM}`,
  ]);
}

describe("the event types the migrations allow in the audit tables", () => {
  it("reads the final CHECK of the tenant audit and of the platform audit", () => {
    expect([...checks.keys()].sort()).toEqual([
      "platform_audit_events.platform_audit_events_type_allowed",
      "tenant_audit_event.tenant_audit_event_type_registered",
    ]);
    // written by a migration no older than the one that last rebuilt it when this was written: a newer one that
    // rebuilds it again is no reason to touch the test
    const oldest: Record<string, string> = {
      "platform_audit_events.platform_audit_events_type_allowed":
        "0105_funil_de_ativacao",
      "tenant_audit_event.tenant_audit_event_type_registered":
        "0100_autosservico_de_cobranca",
    };
    for (const [key, floor] of Object.entries(oldest)) {
      const found = checks.get(key);
      expect(found?.migration, key).toMatch(JOURNAL_TAG);
      expect((found?.migration ?? "") >= floor, key).toBe(true);
      expect(found?.values.length, key).toBeGreaterThan(20);
      expect(new Set(found?.values).size, key).toBe(found?.values.length);
    }
  });

  it("reads the enum of the auth audit, the third audit table, from its CREATE TYPE and its ADD VALUEs", () => {
    expect(authTypes.length).toBeGreaterThan(10);
    expect(new Set(authTypes).size).toBe(authTypes.length);
    expect(authTypes).toContain("device_revoked");
    expect(authTypes).toContain("unverified_user_deleted");
  });

  it("are all domain.action, but the legacy ones the list names", () => {
    const off = offPattern([...auditNames.keys()]);
    expect(off.sort()).toEqual(Object.keys(LEGACY_OFF_PATTERN).sort());
  });

  it("have a reason for every CHECK of event_type that is not a list", () => {
    for (const [constraint, reason] of Object.entries(NOT_A_LIST)) {
      expect(reason.length, constraint).toBeGreaterThan(10);
    }
    expect(Object.keys(NOT_A_LIST).sort()).toEqual([
      "platform_audit_events.platform_audit_events_actor_coherent",
      "queue_dead_letters.queue_dead_letters_event_type_format",
      "tenant_audit_event.tenant_audit_event_type_format",
    ]);
    // an entry whose CHECK no longer stands is a leftover: the exception goes with the cause
    expect(
      Object.keys(NOT_A_LIST).filter((key) => !unreadKeys.includes(key))
    ).toEqual([]);
  });
});

describe("the event types of the outbox", () => {
  it("are all domain.action, but the legacy ones the list names", () => {
    expect(OUTBOX_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(offPattern(OUTBOX_EVENT_TYPES).sort()).toEqual(
      Object.keys(LEGACY_OFF_PATTERN)
        .filter((name) =>
          (OUTBOX_EVENT_TYPES as readonly string[]).includes(name)
        )
        .sort()
    );
  });

  it("are the ones the policies of event_outbox name, no more and no less", () => {
    const named = outboxTypesOfPolicies(allMigrations);
    expect([...named].sort()).toEqual([...OUTBOX_EVENT_TYPES].sort());
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
  const key = "tenant_audit_event.tenant_audit_event_type_allowed";

  it("refuses a log key (billing_x) and a capitalized name (Billing.X) in a CHECK", () => {
    const read = finalEventTypeChecks([
      planted("9000_planted", "'billing.ok', 'billing_x', 'Billing.X'"),
    ]);
    const values = read.get(key)?.values;
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
    expect(read.get(key)).toEqual({
      migration: "9001_second",
      values: ["a.two"],
    });
  });

  it("forgets a CHECK that a DROP removed and nothing added back", () => {
    for (const drop of [
      `ALTER TABLE "tenant_audit_event" DROP CONSTRAINT "tenant_audit_event_type_allowed";`,
      "ALTER TABLE public.tenant_audit_event DROP CONSTRAINT IF EXISTS tenant_audit_event_type_allowed;",
      `ALTER TABLE "public"."tenant_audit_event" DROP CONSTRAINT "other", DROP CONSTRAINT "tenant_audit_event_type_allowed";`,
      `DROP TABLE "tenant_audit_event";`,
    ]) {
      const read = finalEventTypeChecks([
        planted("9000_first", "'a.one'"),
        { name: "9001_drop", sql: drop },
      ]);
      expect(read.size, drop).toBe(0);
    }
  });

  it("reads a CHECK inside a CREATE TABLE, in lower case and without quotes", () => {
    const read = finalEventTypeChecks([
      {
        name: "9000_create",
        sql: `CREATE TABLE "t" (\n\t"event_type" text NOT NULL,\n\tCONSTRAINT "t_type_allowed" CHECK ("t"."event_type" IN ('a.b', 'billing_x'))\n);`,
      },
      {
        name: "9001_by_hand",
        sql: "alter table u add constraint u_type check (event_type in ('c.d', 'e_f'));",
      },
    ]);
    expect(read.get("t.t_type_allowed")?.values).toEqual(["a.b", "billing_x"]);
    expect(read.get("u.u_type")?.values).toEqual(["c.d", "e_f"]);
  });

  it("throws on a CHECK of event_type it cannot read as a list", () => {
    for (const body of [
      `("event_type" = ANY (ARRAY['a.b']))`,
      `("t"."event_type" = 'a.b' OR "t"."event_type" = 'billing_x')`,
      "((event_type)::text IN ('a.b'))",
    ]) {
      expect(
        () =>
          finalEventTypeChecks([
            {
              name: "9000_odd",
              sql: `ALTER TABLE "t" ADD CONSTRAINT "t_odd" CHECK ${body};`,
            },
          ]),
        body
      ).toThrow("not a list the reader parses");
    }
  });

  it("reads the enum of the auth audit and refuses a value of it that is off the pattern", () => {
    const read = authAuditTypes([
      {
        name: "9000_enum",
        sql: `CREATE TYPE "public"."${AUTH_ENUM}" AS ENUM('a.b', 'billing_x');--> statement-breakpoint\n-- ALTER TYPE "public"."${AUTH_ENUM}" ADD VALUE 'in_a_comment';--> statement-breakpoint\nALTER TYPE "public"."${AUTH_ENUM}" ADD VALUE IF NOT EXISTS 'Billing.X';--> statement-breakpoint\nALTER TYPE "public"."other_enum" ADD VALUE 'other.thing';`,
      },
    ]);
    expect(read).toEqual(["a.b", "billing_x", "Billing.X"]);
    expect(offPattern(read)).toEqual(["billing_x", "Billing.X"]);
  });

  it("finds a name shared by the audit and the outbox that no list allows", () => {
    const read = finalEventTypeChecks([
      planted("9000_planted", "'billing.renewal_cancel_requested'"),
    ]);
    const names = new Set([...read.values()].flatMap(({ values }) => values));
    const shared = OUTBOX_EVENT_TYPES.filter((type) => names.has(type));
    expect(shared).toEqual(["billing.renewal_cancel_requested"]);
    expect(Object.keys(SHARED_ON_PURPOSE)).not.toContain(shared[0]);
  });

  it("finds a type in a policy of event_outbox that the domain does not list, and ignores the policy of another table", () => {
    const read = outboxTypesOfPolicies([
      {
        name: "9000_policy",
        sql: [
          `CREATE POLICY "p" ON "event_outbox" AS PERMISSIVE FOR INSERT TO "r" WITH CHECK ("event_outbox"."type" IN ('a.b', 'billing_x') AND entity_type = 'z.z');`,
          "CREATE POLICY q ON public.event_outbox FOR SELECT USING (type = 'c.d');",
          `CREATE POLICY "o" ON "other_table" FOR SELECT USING (type = 'ignored.here');`,
          "-- the hint `prose.only` is named here\nCREATE POLICY r ON public.event_outbox FOR INSERT WITH CHECK (type = 'e.f'); -- and `tail.only`",
        ].join(STATEMENT_BREAKPOINT),
      },
    ]);
    expect([...read].sort()).toEqual(["a.b", "billing_x", "c.d", "e.f"]);
  });
});
