import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * No gate switches role by itself: a bare `SET ROLE` of the gate's connection passes only where the owner is a
 * superuser (the CI service) and fails on Neon, where `neondb_owner` is not one. Every switch goes through
 * `gate-roles.ts` (`withGateRole`, `becomeGateRole`, or `setLoginRole` for the login's own right).
 *
 * The test reads every `.ts` and `.mjs` of the gate folders, tests and support files included; the only file allowed to
 * hold the statement is the helper itself, an exact list. A statement starts a string literal (quote, apostrophe or
 * backtick), so a comment that talks about SET ROLE is not one.
 */

const ROOTS = {
  "apps/web/scripts": new URL("../../../apps/web/scripts/", import.meta.url),
  "packages/db/scripts": new URL("./", import.meta.url),
} as const;
const ALLOWED = ["packages/db/scripts/gate-roles.ts"];
const ROLE_STATEMENT = /["'`]\s*(?:RE)?SET\s+(?:LOCAL\s+)?ROLE\b/gi;

function roleStatements(source: string): number {
  return source.match(ROLE_STATEMENT)?.length ?? 0;
}

function gateSources(): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const [root, url] of Object.entries(ROOTS)) {
    for (const name of readdirSync(url, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
      .filter((file) => !file.includes("node_modules"))
      .sort()) {
      sources[`${root}/${name}`] = readFileSync(new URL(name, url), "utf8");
    }
  }
  return sources;
}

function offenders(sources: Readonly<Record<string, string>>): string[] {
  return Object.entries(sources)
    .filter(
      ([file, source]) => !ALLOWED.includes(file) && roleStatements(source) > 0
    )
    .map(([file]) => file);
}

describe("role switches in the gates", () => {
  it("happen only in gate-roles.ts", () => {
    const sources = gateSources();
    expect(Object.keys(sources).length).toBeGreaterThan(90);
    for (const file of ALLOWED) {
      expect(roleStatements(sources[file] ?? "")).toBeGreaterThan(0);
    }
    expect(offenders(sources)).toEqual([]);
  });

  it("are found in each form a gate could write", () => {
    const planted: Record<string, string> = {
      "a.ts": 'await client.query("SET ROLE polaris_admin_owner");',
      "b.ts": "await client.query(`SET LOCAL ROLE $" + "{role}`);",
      "c.ts": "await client.query('RESET ROLE');",
      "d.ts": 'await client.query(" set local role x");',
      "e.mjs": "await c.query(`\n  SET ROLE $" + "{r}`);",
      "packages/db/scripts/gate-roles.ts": 'await c.query("SET ROLE x");',
    };
    expect(offenders(planted)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
      "e.mjs",
    ]);
  });

  it("are not a comment or a GRANT WITH SET", () => {
    const harmless: Record<string, string> = {
      "a.ts": "// the login can SET ROLE to the group",
      "b.ts": " * reach with SET ROLE, or inherits",
      "c.ts":
        'await c.query("GRANT x TO y WITH SET TRUE, INHERIT FALSE, ADMIN FALSE");',
      "d.ts":
        "await c.query(\"UPDATE public.platform_principals SET role = 'x'\");",
    };
    expect(offenders(harmless)).toEqual([]);
  });
});
