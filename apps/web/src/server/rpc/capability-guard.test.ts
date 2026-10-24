import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `withCapability(identity, …)` re-issues an identity under ANOTHER capability, so a repository that checks
 * `inventory:adjust` accepts a request that was opened with `product:create`. That is safe only where the
 * capability was already proved:
 * - in `server/rpc/` and `server/use-cases/`, by `requireCapabilityInTransaction(` earlier in the SAME top-level
 *   function (the role read in the transaction, before any write);
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
const WITH_CAPABILITY_CALLS = /\bwithCapability\(/g;
const RENAMED_IMPORT = /\bwithCapability\s+as\b/;
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:async\s+)?function\s|^(?:export\s+)?const\s+\w+\s*=/gm;

/** The positions of `withCapability(` that no `requireCapabilityInTransaction(` precedes in the same top-level declaration. */
function unguardedWithCapability(source: string): number[] {
  const starts = [...source.matchAll(TOP_LEVEL_DECLARATION)].map(
    (match) => match.index
  );
  const unguarded: number[] = [];
  for (const match of source.matchAll(WITH_CAPABILITY_CALLS)) {
    const at = match.index;
    const declarationStart = starts.filter((start) => start <= at).at(-1) ?? 0;
    const before = source.slice(declarationStart, at);
    if (!before.includes("requireCapabilityInTransaction(")) {
      unguarded.push(at);
    }
  }
  return unguarded;
}

/** The files (path relative to `server/`) that break one of the rules above. */
function offenders(files: ReadonlyMap<string, string>): string[] {
  const refused: string[] = [];
  for (const [path, source] of files) {
    if (RENAMED_IMPORT.test(source)) {
      refused.push(path);
      continue;
    }
    if (!WITH_CAPABILITY_CALL.test(source)) {
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
      .filter(([, source]) => WITH_CAPABILITY_CALL.test(source))
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
    expect(unguardedWithCapability(guarded)).toEqual([]);
    expect(unguardedWithCapability(unguarded)).toHaveLength(1);
    expect(unguardedWithCapability(guardedElsewhere)).toHaveLength(1);

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
