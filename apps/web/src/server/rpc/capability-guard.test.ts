import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `withCapability(identity, …)` re-issues an identity under ANOTHER capability, so a repository that checks
 * `inventory:adjust` accepts a request that was opened with `product:create`. That is safe only where the
 * capability was already proved:
 * - in `server/rpc/` and `server/use-cases/`, by `requireCapabilityInTransaction(` earlier in the SAME top-level
 *   function, for the same capability, outside comments (the role read in the transaction, before any write);
 * - in `server/sync/handlers/`, by the signed lease that `sync.push` required and the role the database
 *   revalidated (ADR 0033): only the handlers listed below, so a new one is a conscious decision.
 * Anywhere else under `server/`, `withCapability(` is refused, and so is importing it under another name.
 */
const SERVER = new URL("../", import.meta.url);

/** The folders whose functions must check the role before re-issuing the identity. */
const CHECKED_FOLDERS = ["rpc/", "use-cases/"];

/** The sync handlers whose capability the lease covers (ADR 0036, ADR 0037). */
const LEASE_COVERED_HANDLERS = [
  "sync/handlers/sale-confirm.ts",
  "sync/handlers/stock-commands.ts",
];

const WITH_CAPABILITY_CALL = /\bwithCapability\(/;
/** The call with its capability argument (`withCapability(identity, INVENTORY_ADJUST)` gives `INVENTORY_ADJUST`). */
const WITH_CAPABILITY_CALLS =
  /\bwithCapability\(\s*[\w.]+\s*,\s*([^),]+?)\s*\)/g;
const ANY_WITH_CAPABILITY_CALL = /\bwithCapability\(/g;
const NOT_NEWLINE = /[^\n]/g;
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const RENAMED_IMPORT = /\bwithCapability\s+as\b/;
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b|^(?:export\s+)?(?:const|let)\s+\w+\s*(?::[^=\n]+)?=/gm;
/** Strings are kept (a `//` inside one is not a comment); comments are blanked, keeping every position. */
const STRING_OR_COMMENT =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** The source with its comments turned to spaces: a call in a comment neither guards nor counts as a use. */
function withoutComments(source: string): string {
  return source.replace(
    STRING_OR_COMMENT,
    (text, literal: string | undefined) =>
      literal === undefined ? text.replace(NOT_NEWLINE, " ") : text
  );
}

function escapeRegExp(text: string): string {
  return text.replace(REGEXP_SPECIAL, "\\$&");
}

/**
 * The positions of `withCapability(identity, X)` that no `requireCapabilityInTransaction(identity, X)`, with the
 * same capability X, precedes in the same top-level declaration.
 */
function unguardedWithCapability(source: string): number[] {
  const code = withoutComments(source);
  const starts = [...code.matchAll(TOP_LEVEL_DECLARATION)].map(
    (match) => match.index
  );
  const unguarded: number[] = [];
  for (const match of code.matchAll(WITH_CAPABILITY_CALLS)) {
    const at = match.index;
    const capability = escapeRegExp(match[1] ?? "");
    const declarationStart = starts.filter((start) => start <= at).at(-1) ?? 0;
    const before = code.slice(declarationStart, at);
    const check = new RegExp(
      `\\brequireCapabilityInTransaction\\(\\s*[\\w.]+\\s*,\\s*${capability}\\s*\\)`
    );
    if (!check.test(before)) {
      unguarded.push(at);
    }
  }
  // a call the pattern above cannot read (no capability argument) is never guarded
  const readable = [...code.matchAll(WITH_CAPABILITY_CALLS)].length;
  const calls = [...code.matchAll(ANY_WITH_CAPABILITY_CALL)].length;
  if (calls > readable) {
    unguarded.push(-1);
  }
  return unguarded;
}

/** The files (path relative to `server/`) that break one of the rules above. */
function offenders(files: ReadonlyMap<string, string>): string[] {
  const refused: string[] = [];
  for (const [path, source] of files) {
    const code = withoutComments(source);
    if (RENAMED_IMPORT.test(code)) {
      refused.push(path);
      continue;
    }
    if (!WITH_CAPABILITY_CALL.test(code)) {
      continue;
    }
    if (LEASE_COVERED_HANDLERS.includes(path)) {
      continue;
    }
    const checked = CHECKED_FOLDERS.some((folder) => path.startsWith(folder));
    if (!checked || unguardedWithCapability(source).length > 0) {
      refused.push(path);
    }
  }
  return refused;
}

/** Every non-test `.ts` file under `server/`, by its path relative to it. */
function serverSources(): Map<string, string> {
  const names = readdirSync(SERVER, { encoding: "utf8", recursive: true });
  return new Map(
    names
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => [
        name.split("\\").join("/"),
        readFileSync(new URL(name, SERVER), "utf8"),
      ])
  );
}

describe("withCapability under server/", () => {
  it("is used only after requireCapabilityInTransaction in the same function, or in a handler the lease covers", () => {
    const files = serverSources();
    expect(
      [...files.keys()].filter((path) =>
        CHECKED_FOLDERS.some((folder) => path.startsWith(folder))
      ).length
    ).toBeGreaterThan(0);
    // the scan reaches the use case and the handlers it is meant to hold
    const users = [...files]
      .filter(([, source]) =>
        WITH_CAPABILITY_CALL.test(withoutComments(source))
      )
      .map(([path]) => path)
      .sort();
    expect(users).toEqual([
      ...LEASE_COVERED_HANDLERS,
      "use-cases/create-product-with-opening-stock.ts",
    ]);
    expect(offenders(files)).toEqual([]);
  });

  it("tells a guarded use from an unguarded one", () => {
    const guarded = `
export async function create(tx, identity) {
  requireCapabilityInTransaction(identity, "inventory:adjust");
  return stock(tx, withCapability(identity, "inventory:adjust"));
}
`;
    const unguarded = `
export async function create(tx, identity) {
  return stock(tx, withCapability(identity, "inventory:adjust"));
}
`;
    const guardedElsewhere = `
export async function other(identity) {
  requireCapabilityInTransaction(identity, "inventory:adjust");
}
export async function create(tx, identity) {
  return stock(tx, withCapability(identity, "inventory:adjust"));
}
`;
    const renamed = `
import { withCapability as elevate } from "@polaris/db/tenant-transaction";
export async function create(tx, identity) {
  return stock(tx, elevate(identity, "inventory:adjust"));
}
`;
    // the check of another capability does not guard this one
    const otherCapability = `
export async function create(tx, identity) {
  requireCapabilityInTransaction(identity, "product:create");
  return stock(tx, withCapability(identity, "inventory:adjust"));
}
`;
    // a declaration with a type, or a default export, is a function of its own
    const typedElsewhere = `
export function other(identity) {
  requireCapabilityInTransaction(identity, "inventory:adjust");
}
const create: Handler = async (tx, identity) =>
  stock(tx, withCapability(identity, "inventory:adjust"));
export default function later(tx, identity) {
  return stock(tx, withCapability(identity, "inventory:adjust"));
}
`;
    // a check in a comment is no check
    const commented = `
export async function create(tx, identity) {
  // requireCapabilityInTransaction(identity, "inventory:adjust");
  /* requireCapabilityInTransaction(identity, "inventory:adjust"); */
  return stock(tx, withCapability(identity, "inventory:adjust"));
}
`;
    expect(unguardedWithCapability(guarded)).toEqual([]);
    expect(unguardedWithCapability(unguarded)).toHaveLength(1);
    expect(unguardedWithCapability(guardedElsewhere)).toHaveLength(1);
    expect(unguardedWithCapability(otherCapability)).toHaveLength(1);
    expect(unguardedWithCapability(typedElsewhere)).toHaveLength(2);
    expect(unguardedWithCapability(commented)).toHaveLength(1);
    // a use only in a comment is no use
    expect(
      offenders(new Map([["sync/push.ts", "// withCapability(identity, x)\n"]]))
    ).toEqual([]);

    expect(
      offenders(
        new Map([
          ["use-cases/guarded.ts", guarded],
          ["rpc/guarded.ts", guarded],
          ["sync/handlers/stock-commands.ts", unguarded],
        ])
      )
    ).toEqual([]);
    expect(
      offenders(
        new Map([
          ["use-cases/unguarded.ts", unguarded],
          ["use-cases/guarded-elsewhere.ts", guardedElsewhere],
          ["rpc/unguarded.ts", unguarded],
          // a handler outside the closed list, even one that checks the role
          ["sync/handlers/new-command.ts", guarded],
          // outside the folders the rule knows
          ["sync/push.ts", guarded],
          ["use-cases/renamed.ts", renamed],
        ])
      )
    ).toEqual([
      "use-cases/unguarded.ts",
      "use-cases/guarded-elsewhere.ts",
      "rpc/unguarded.ts",
      "sync/handlers/new-command.ts",
      "sync/push.ts",
      "use-cases/renamed.ts",
    ]);
  });
});
