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
const setLocal = /\bSET\s+LOCAL\s+lock_timeout\b/gi;
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

describe("lock_timeout across the migrations of one run", () => {
  it("is not left set by the last migration that sets it", () => {
    const files = readdirSync(drizzleDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    let state: "default" | "set" = "default";
    let setBy = "";
    for (const name of files) {
      for (const change of lockTimeoutChanges(
        readFileSync(path.join(drizzleDirectory, name), "utf8")
      )) {
        state = change === "set" ? "set" : "default";
        setBy = change === "set" ? name : "";
      }
    }
    expect(
      state,
      `${setBy} sets lock_timeout and no migration after it resets it: it would hold for the migrations of the same run (end with RESET lock_timeout)`
    ).toBe("default");
  });

  it("sees a SET LOCAL without a RESET, and ignores comments", () => {
    expect(lockTimeoutChanges("SET LOCAL lock_timeout = '10s';")).toEqual([
      "set",
    ]);
    expect(
      lockTimeoutChanges(
        "-- SET LOCAL lock_timeout = '1s'\nSET LOCAL lock_timeout = '10s';\nRESET lock_timeout;"
      )
    ).toEqual(["set", "reset"]);
  });
});
