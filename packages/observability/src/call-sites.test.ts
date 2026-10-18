import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalNameFor } from "./fields";

/**
 * Lint for the call sites (ADR 0091): the logger type refuses a forbidden alias
 * in an object literal, but a spread of a loose record or a helper that takes
 * `Record<string, string>` (the Admin's `report`) slips past it. This reads the
 * backend sources and fails when a call that writes log fields names one.
 */

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

const sourceFilePattern = /\.(?:ts|tsx)$/;
const testFilePattern = /\.test\./;

const sourceRoots = [
  "apps/admin/src",
  "apps/catalog/src",
  "apps/web/src/server",
  "apps/web/worker",
  "packages/billing/src",
  "packages/db/src",
];

/** Calls whose object argument becomes log fields. */
const callPattern =
  /\b(?:logger\.(?:debug|info|warn|error)|logServerEvent|startWideEvent|withWideEvent|wide\.set|report)\(/g;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        files.push(...sourceFiles(full));
      }
    } else if (
      sourceFilePattern.test(entry.name) &&
      !testFilePattern.test(entry.name)
    ) {
      files.push(full);
    }
  }
  return files;
}

/** The text between the parentheses that open at `open`, skipping string literals. */
function argumentsText(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  return source.slice(open + 1);
}

/** Object-literal keys written in `text`: `{ key: v }`, `{ key }` and `{ "key": v }`. */
function keysIn(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(
    /[{,]\s*(?:"(\w+)"|'(\w+)'|(\w+))\s*(?=[:,}])/g
  )) {
    const key = match[1] ?? match[2] ?? match[3];
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return keys;
}

interface Violation {
  alias: string;
  canonical: string;
  line: number;
}

function aliasesUsedIn(source: string): Violation[] {
  const violations: Violation[] = [];
  for (const call of source.matchAll(callPattern)) {
    const open = (call.index ?? 0) + call[0].length - 1;
    for (const key of keysIn(argumentsText(source, open))) {
      const canonical = canonicalNameFor(key);
      if (canonical !== undefined) {
        violations.push({
          alias: key,
          canonical,
          line: source.slice(0, open).split("\n").length,
        });
      }
    }
  }
  return violations;
}

describe("call sites", () => {
  it("find the forbidden aliases in a snippet (the scanner is not vacuous)", () => {
    const snippet = [
      'logger.info("a", { orgId: id, durationMs: 1 });',
      'logger.error("b", { ...x, errorName, "user_id": 1 });',
      'report("c", { name: error.name, request_id: "x" });',
      'logger.info("fine", { organizationId, requestId, outcome: "success" });',
    ].join("\n");

    expect(aliasesUsedIn(snippet).map((v) => v.alias)).toEqual([
      "orgId",
      "errorName",
      "user_id",
      "request_id",
    ]);
  });

  it("use no forbidden alias in the backend", () => {
    let scanned = 0;
    const violations: string[] = [];
    for (const sourceRoot of sourceRoots) {
      for (const file of sourceFiles(path.join(root, sourceRoot))) {
        const source = readFileSync(file, "utf8");
        scanned += [...source.matchAll(callPattern)].length;
        // `report(` is the Admin's helper only; elsewhere the name is unrelated.
        const isAdmin = file.includes(
          `${path.sep}apps${path.sep}admin${path.sep}`
        );
        const text = isAdmin ? source : source.replaceAll(/\breport\(/g, "_(");
        for (const violation of aliasesUsedIn(text)) {
          violations.push(
            `${path.relative(root, file)}:${violation.line} uses \`${violation.alias}\`, use \`${violation.canonical}\``
          );
        }
      }
    }

    expect(scanned).toBeGreaterThan(10);
    expect(violations).toEqual([]);
  });
});
