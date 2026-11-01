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
const setLocal =
  /\bSET\s+(?:LOCAL\s+|SESSION\s+)?lock_timeout\b|\bset_config\s*\(\s*'lock_timeout'/gi;
const reset = /\bRESET\s+lock_timeout\b/gi;

/** `set` or `reset`, in the order of the statements of the file, for every change of lock_timeout */
function lockTimeoutChanges(sql: string): ("set" | "reset")[] {
  const text = sql.replace(comment, "");
  return [
    ...[...text.matchAll(setLocal)].map((match) => ({
      at: match.index,
      kind: "set" as const,
    })),
    ...[...text.matchAll(reset)].map((match) => ({
      at: match.index,
      kind: "reset" as const,
    })),
  ]
    .sort((left, right) => left.at - right.at)
    .map((change) => change.kind);
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
  const ddlAt = [...text.matchAll(heavyDdl)].map((match) => match.index);
  const [firstDdl] = ddlAt;
  const lastDdl = ddlAt.at(-1);
  if (firstDdl === undefined || lastDdl === undefined) {
    return null;
  }
  const firstSet = [...text.matchAll(setLocal)][0]?.index;
  if (firstSet === undefined || firstSet > firstDdl) {
    return "heavy DDL without a lock_timeout set before it";
  }
  const lastReset = [...text.matchAll(reset)].at(-1)?.index;
  if (lastReset !== undefined && lastReset < lastDdl) {
    return "heavy DDL after the RESET lock_timeout";
  }
  if (lockTimeoutChanges(sql).at(-1) !== "reset") {
    return "lock_timeout is not reset at the end";
  }
  return null;
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
      "comece com SET LOCAL lock_timeout = '10s'; e termine com RESET lock_timeout; (padrão das 0095–0107)"
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
});
