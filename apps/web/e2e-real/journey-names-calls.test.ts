import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = import.meta.dirname;
const OWN_FILES = new Set(["journey-names.ts", "journey-names.test.ts"]);
const CALL = /\bjourneyName\(/g;
const SOURCE_FILE = /\.(?:ts|tsx|mjs|js)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(path);
    }
    return SOURCE_FILE.test(entry.name) &&
      !OWN_FILES.has(entry.name) &&
      entry.name !== "journey-names-calls.test.ts"
      ? [path]
      : [];
  });
}

/** The text between the parentheses of each `journeyName(` call. */
function journeyNameCalls(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(CALL)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      }
      index += 1;
    }
    calls.push(source.slice(start, index - 1));
  }
  return calls;
}

const lacksRepetition = (call: string) => !call.includes("repeatEachIndex");

describe("journeyName calls in the e2e suites", () => {
  it("pass the repetition index, or --repeat-each inserts the same user twice", () => {
    const offenders = sourceFiles(ROOT).flatMap((file) =>
      journeyNameCalls(readFileSync(file, "utf8"))
        .filter(lacksRepetition)
        .map((call) => `${file.slice(ROOT.length + 1)}: ${call.trim()}`)
    );
    expect(offenders).toEqual([]);
  });

  it("sees the calls it must judge (the scan is not empty)", () => {
    const total = sourceFiles(ROOT).flatMap((file) =>
      journeyNameCalls(readFileSync(file, "utf8"))
    ).length;
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it("rejects a call without the index and accepts one with it, nested parentheses included", () => {
    const bad = 'x(journeyName("pilha", "a", testInfo.retry))';
    const good =
      'x(journeyName(f("pilha"), "a", testInfo.retry, testInfo.repeatEachIndex))';
    expect(journeyNameCalls(bad).filter(lacksRepetition)).toHaveLength(1);
    expect(journeyNameCalls(good).filter(lacksRepetition)).toHaveLength(0);
  });
});
