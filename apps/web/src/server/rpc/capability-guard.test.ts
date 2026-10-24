import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `withCapability(identity, …)` re-issues an identity under ANOTHER capability, so a repository that checks
 * `inventory:adjust` accepts a request that was opened with `product:create`. In the RPC handlers that is safe
 * only after the role was checked for that capability in the same transaction
 * (`requireCapabilityInTransaction`, before any write). The sync handlers are different: their lease already
 * required the capability. This guard keeps a handler in `server/rpc/` from using the one without the other.
 */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:async\s+)?function\s|^(?:export\s+)?const\s+\w+\s*=/gm;

/** The positions of `withCapability(` that no `requireCapabilityInTransaction(` precedes in the same top-level declaration. */
function unguardedWithCapability(source: string): number[] {
  const starts = [...source.matchAll(TOP_LEVEL_DECLARATION)].map(
    (match) => match.index
  );
  const unguarded: number[] = [];
  for (const match of source.matchAll(/\bwithCapability\(/g)) {
    const at = match.index;
    const declarationStart = starts.filter((start) => start <= at).at(-1) ?? 0;
    const before = source.slice(declarationStart, at);
    if (!before.includes("requireCapabilityInTransaction(")) {
      unguarded.push(at);
    }
  }
  return unguarded;
}

describe("withCapability in the RPC handlers", () => {
  it("is never used before requireCapabilityInTransaction in the same function", () => {
    const directory = new URL("./", import.meta.url);
    const files = readdirSync(directory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
    );
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter(
      (name) =>
        unguardedWithCapability(readFileSync(new URL(name, directory), "utf8"))
          .length > 0
    );
    expect(offenders).toEqual([]);
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
    expect(unguardedWithCapability(guarded)).toEqual([]);
    expect(unguardedWithCapability(unguarded)).toHaveLength(1);
    expect(unguardedWithCapability(guardedElsewhere)).toHaveLength(1);
  });
});
