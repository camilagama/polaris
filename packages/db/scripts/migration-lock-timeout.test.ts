import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const drizzleDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle"
);
const comment = /--[^\n]*/g;
// the migrator runs every pending migration in ONE transaction, so a SET LOCAL of a migration holds for the next ones
const setStatement =
  /\bSET\s+(?:LOCAL\s+|SESSION\s+)?lock_timeout\b(?:\s*(?:=|\bTO\b)\s*([^;]*))?/gi;
const setConfigCall =
  /\bset_config\s*\(\s*'lock_timeout'(?:\s*,\s*([^,)]*))?/gi;
const reset = /\bRESET\s+lock_timeout\b/gi;

const LOCK_TIMEOUT_EXPECTED =
  "'Nms' or 'Ns' between 1 ms and 30 s, as in '10s'";
const quantity = /^'(\d+)(ms|s)'$/;
const MAX_LOCK_TIMEOUT_MS = 30_000;

function validLockTimeout(value: string | null): boolean {
  const match = value === null ? null : quantity.exec(value.trim());
  if (match === null) {
    return false;
  }
  const milliseconds = Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  return milliseconds >= 1 && milliseconds <= MAX_LOCK_TIMEOUT_MS;
}

type LockTimeoutEvent =
  | { at: number; kind: "set"; value: string | null }
  | { at: number; kind: "reset" };

function lockTimeoutEvents(text: string): LockTimeoutEvent[] {
  return [
    ...[...text.matchAll(setStatement), ...text.matchAll(setConfigCall)].map(
      (match): LockTimeoutEvent => ({
        at: match.index,
        kind: "set",
        value: match[1]?.trim() ?? null,
      })
    ),
    ...[...text.matchAll(reset)].map(
      (match): LockTimeoutEvent => ({ at: match.index, kind: "reset" })
    ),
  ].sort((left, right) => left.at - right.at);
}

/** `set` or `reset`, in the order of the statements of the file, for every change of lock_timeout */
function lockTimeoutChanges(sql: string): ("set" | "reset")[] {
  return lockTimeoutEvents(sql.replace(comment, "")).map((event) => event.kind);
}

// DDL that takes a strong lock on a relation, even one created in the same migration; CREATE TABLE, functions, GRANT/REVOKE, views and COMMENT ON do not queue behind live traffic
const heavyDdl = new RegExp(
  [
    String.raw`\bALTER\s+TABLE\b`,
    String.raw`\bDROP\s+TABLE\b`,
    String.raw`\bTRUNCATE\b`,
    String.raw`\bLOCK\s+TABLE\b`,
    String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY\b)`,
    String.raw`\bDROP\s+INDEX\b(?!\s+CONCURRENTLY\b)`,
    String.raw`\bALTER\s+INDEX\b`,
    String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b`,
    String.raw`\bDROP\s+TRIGGER\b`,
    String.raw`\b(?:CREATE|ALTER|DROP)\s+POLICY\b`,
  ].join("|"),
  "gi"
);

/** why the migration breaks the lock_timeout pattern, or null when it follows it or has no heavy DDL */
function lockTimeoutViolation(sql: string): string | null {
  const text = sql.replace(comment, "");
  const events = [
    ...lockTimeoutEvents(text),
    ...[...text.matchAll(heavyDdl)].map(
      (match): { at: number; kind: "ddl" } => ({
        at: match.index,
        kind: "ddl",
      })
    ),
  ].sort((left, right) => left.at - right.at);
  if (!events.some((event) => event.kind === "ddl")) {
    return null;
  }
  let active = false;
  for (const event of events) {
    if (event.kind === "set") {
      if (!validLockTimeout(event.value)) {
        return `lock_timeout set to ${event.value ?? "no value"}; expected ${LOCK_TIMEOUT_EXPECTED}`;
      }
      active = true;
    } else if (event.kind === "reset") {
      active = false;
    } else if (!active) {
      return "heavy DDL outside a lock_timeout window (SET LOCAL before it, no RESET in between)";
    }
  }
  return active ? "lock_timeout is not reset at the end" : null;
}

// 0108 dropped tables without a lock_timeout; 0001-0110 are already applied and are not edited
const FIRST_REQUIRED = 111;

// 0095 is the one that leaked it (merged before this check); 0096 repeats the timeout for itself and resets it
const LAST_LEAKING = 95;
const migrationNumber = /^(\d{4})_/;

describe("lock_timeout across the migrations of one run", () => {
  const files = readdirSync(drizzleDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  it("is reset by every migration after 0095 that sets it, and by the end of the chain", () => {
    let state: "default" | "set" = "default";
    const leaking: string[] = [];
    for (const name of files) {
      const changes = lockTimeoutChanges(
        readFileSync(path.join(drizzleDirectory, name), "utf8")
      );
      const number = Number(migrationNumber.exec(name)?.[1]);
      if (number > LAST_LEAKING && changes.at(-1) === "set") {
        leaking.push(name);
      }
      for (const change of changes) {
        state = change === "set" ? "set" : "default";
      }
    }
    expect(
      leaking,
      "these migrations set lock_timeout and do not end with RESET lock_timeout: it would hold for the migrations of the same run"
    ).toEqual([]);
    expect(
      state,
      "the last migration of the chain leaves lock_timeout set"
    ).toBe("default");
  });

  it("sees a SET LOCAL without a RESET, a session SET and set_config, and ignores comments", () => {
    expect(lockTimeoutChanges("SET LOCAL lock_timeout = '10s';")).toEqual([
      "set",
    ]);
    expect(lockTimeoutChanges("SET lock_timeout TO '1s';")).toEqual(["set"]);
    expect(
      lockTimeoutChanges("SELECT set_config('lock_timeout', '1s', true);")
    ).toEqual(["set"]);
    expect(
      lockTimeoutChanges(
        "-- SET LOCAL lock_timeout = '1s'\nSET LOCAL lock_timeout = '10s';\nRESET lock_timeout;"
      )
    ).toEqual(["set", "reset"]);
  });

  it("requires SET LOCAL lock_timeout before the first heavy DDL and RESET at the end, from 0111 on", () => {
    const offenders = files
      .filter(
        (name) => Number(migrationNumber.exec(name)?.[1]) >= FIRST_REQUIRED
      )
      .flatMap((name) => {
        const violation = lockTimeoutViolation(
          readFileSync(path.join(drizzleDirectory, name), "utf8")
        );
        return violation === null ? [] : [`${name}: ${violation}`];
      });
    expect(
      offenders,
      "comece com SET LOCAL lock_timeout = '10s'; e termine com RESET lock_timeout; (padrão das 0095–0107); valor entre 1 ms e 30 s"
    ).toEqual([]);
  });

  it("judges the lock_timeout pattern of a migration that has heavy DDL", () => {
    expect(
      lockTimeoutViolation("ALTER TABLE x ADD COLUMN y int;")
    ).not.toBeNull();
    expect(
      lockTimeoutViolation(
        "ALTER TABLE x ADD COLUMN y int;\nSET LOCAL lock_timeout = '10s';\nRESET lock_timeout;"
      )
    ).not.toBeNull();
    expect(
      lockTimeoutViolation(
        "SET LOCAL lock_timeout = '10s';\nALTER TABLE x ADD COLUMN y int;\nRESET lock_timeout;"
      )
    ).toBeNull();
    expect(
      lockTimeoutViolation(
        "SET LOCAL lock_timeout = '10s';\nALTER TABLE x ADD COLUMN y int;"
      )
    ).not.toBeNull();
    expect(
      lockTimeoutViolation(
        "SET LOCAL lock_timeout = '10s';\nALTER TABLE a ADD COLUMN y int;\nRESET lock_timeout;\nALTER TABLE b ADD COLUMN y int;"
      )
    ).not.toBeNull();
    expect(
      lockTimeoutViolation(
        "SET LOCAL lock_timeout = '10s';\nALTER TABLE a ADD COLUMN y int;\nRESET lock_timeout;\nALTER TABLE b ADD COLUMN y int;\nSET LOCAL lock_timeout = '10s';\nALTER TABLE c ADD COLUMN y int;\nRESET lock_timeout;"
      )
    ).toContain("outside a lock_timeout window");
    expect(
      lockTimeoutViolation(
        "SET LOCAL lock_timeout = '10s';\nALTER TABLE a ADD COLUMN y int;\nRESET lock_timeout;\nSET LOCAL lock_timeout = '5s';\nALTER TABLE c ADD COLUMN y int;\nRESET lock_timeout;"
      )
    ).toBeNull();
    expect(
      lockTimeoutViolation("CREATE INDEX CONCURRENTLY i ON x (y);")
    ).toBeNull();
    expect(
      lockTimeoutViolation("DROP INDEX CONCURRENTLY IF EXISTS i;")
    ).toBeNull();
    expect(
      lockTimeoutViolation("CREATE UNIQUE INDEX i ON x (y);")
    ).not.toBeNull();
    expect(
      lockTimeoutViolation("-- ALTER TABLE x ADD COLUMN y int;\nSELECT 1;")
    ).toBeNull();
    expect(lockTimeoutViolation("CREATE TABLE novo (id int);")).toBeNull();
    for (const statement of [
      "DROP TABLE x;",
      "TRUNCATE x;",
      "LOCK TABLE x IN ACCESS EXCLUSIVE MODE;",
      "alter index i rename to j;",
      "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW EXECUTE FUNCTION f();",
      "DROP TRIGGER t ON x;",
      "CREATE POLICY p ON x USING (true);",
      "ALTER POLICY p ON x USING (true);",
      "DROP POLICY p ON x;",
    ]) {
      expect(lockTimeoutViolation(statement), statement).not.toBeNull();
    }
  });

  it("accepts only 'Nms' or 'Ns' between 1 ms and 30 s as the lock_timeout value", () => {
    const wrap = (setting: string) =>
      `${setting}\nALTER TABLE x ADD COLUMN y int;\nRESET lock_timeout;`;
    for (const setting of [
      "SET LOCAL lock_timeout = '10s';",
      "SET lock_timeout TO '1ms';",
      "SET SESSION lock_timeout = '30s';",
      "SET LOCAL lock_timeout = '30000ms';",
      "SELECT set_config('lock_timeout', '10s', true);",
    ]) {
      expect(lockTimeoutViolation(wrap(setting)), setting).toBeNull();
    }
    for (const setting of [
      "SET LOCAL lock_timeout = 0;",
      "SET LOCAL lock_timeout = '0';",
      "SET LOCAL lock_timeout = '0s';",
      "SET LOCAL lock_timeout = -1;",
      "SET LOCAL lock_timeout = '-1s';",
      "SET LOCAL lock_timeout = '1min';",
      "SET LOCAL lock_timeout = '1h';",
      "SET LOCAL lock_timeout = '31s';",
      "SET LOCAL lock_timeout = '30001ms';",
      "SET LOCAL lock_timeout = '10';",
      "SET LOCAL lock_timeout = 10000;",
      "SET LOCAL lock_timeout TO DEFAULT;",
      "SELECT set_config('lock_timeout', '0', true);",
      "SELECT set_config('lock_timeout', '1h', true);",
    ]) {
      expect(lockTimeoutViolation(wrap(setting)), setting).toContain(
        `expected ${LOCK_TIMEOUT_EXPECTED}`
      );
    }
  });
});
