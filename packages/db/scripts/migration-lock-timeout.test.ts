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
});
