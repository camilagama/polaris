import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `withCapability(identity, …)` re-issues an identity under ANOTHER capability, so a repository that checks
 * `inventory:adjust` accepts a request that was opened with `product:create`. That is safe only where the
 * capability was already proved, so the name is an allow list over the whole repository (the `src` folder of every
 * package under `apps/` and `packages/`, tests included, comments ignored). It is accepted only:
 * - in its definition, `packages/db/src/tenant-transaction.ts`;
 * - in `apps/web/src/server/rpc/` and `use-cases/`, after `requireCapabilityInTransaction(` earlier in the SAME
 *   top-level function, for the same capability, outside comments (the role read in the transaction, before any
 *   write);
 * - in the two handlers of `apps/web/src/server/sync/handlers/` listed below, by the signed lease that `sync.push`
 *   required and the role the database revalidated (ADR 0033): a new handler is a conscious decision.
 * Any other file that names it is refused, and so is importing it under another name. `apps/admin` and
 * `apps/catalog` do not import `@polaris/db/tenant-transaction` at all (ADR 0035, amendment of 24/10/2026).
 */
const REPO = new URL("../../../../../", import.meta.url);
const SCAN_PARENTS = ["apps", "packages"];
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const WITH_CAPABILITY_NAME = /\bwithCapability\b/;
const TENANT_TRANSACTION_MODULE = /@polaris\/db\/tenant-transaction/;

/** Where `withCapability` is defined. */
const DEFINITION = "packages/db/src/tenant-transaction.ts";

/** This file holds the cases of the guard as text, so it names the helper without using it. */
const THIS_GUARD = "apps/web/src/server/rpc/capability-guard.test.ts";

/** The folders whose functions must check the role before re-issuing the identity. */
const CHECKED_FOLDERS = [
  "apps/web/src/server/rpc/",
  "apps/web/src/server/use-cases/",
];

/** The sync handlers whose capability the lease covers (ADR 0036, ADR 0037). */
const LEASE_COVERED_HANDLERS = [
  "apps/web/src/server/sync/handlers/sale-confirm.ts",
  "apps/web/src/server/sync/handlers/stock-commands.ts",
];

/** The apps that must not reach the module that holds the helper. */
const WITHOUT_TENANT_TRANSACTION = ["apps/admin/src/", "apps/catalog/src/"];

/** The call with its capability argument (`withCapability(identity, INVENTORY_ADJUST)` gives `INVENTORY_ADJUST`). */
const WITH_CAPABILITY_CALLS =
  /\bwithCapability\(\s*[\w.]+\s*,\s*([^),]+?)\s*\)/g;
const ANY_WITH_CAPABILITY_CALL = /\bwithCapability\(/g;
const WITH_CAPABILITY_NAMES = /\bwithCapability\b/g;
/** `import { a, withCapability } from "…"`: naming it here is not using it. */
const IMPORT_CLAUSE = /\bimport\s*\{[^}]*\}\s*from\s*(?:"[^"]*"|'[^']*')/g;
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

/** The files (path relative to the repository) that break one of the rules above. */
function offenders(files: ReadonlyMap<string, string>): string[] {
  const refused: string[] = [];
  for (const [path, source] of files) {
    if (path === DEFINITION || path === THIS_GUARD) {
      continue;
    }
    const code = withoutComments(source);
    if (!WITH_CAPABILITY_NAME.test(code)) {
      continue;
    }
    if (RENAMED_IMPORT.test(code)) {
      refused.push(path);
      continue;
    }
    const checked = CHECKED_FOLDERS.some((folder) => path.startsWith(folder));
    if (!checked) {
      if (!LEASE_COVERED_HANDLERS.includes(path)) {
        refused.push(path);
      }
      continue;
    }
    // where the folder is checked, every mention is the import or a guarded call: an alias or a re-export is not
    if (namedOutsideCalls(code) || unguardedWithCapability(source).length > 0) {
      refused.push(path);
    }
  }
  return refused;
}

/** Whether `withCapability` is named other than in an import clause or as `withCapability(`. */
function namedOutsideCalls(code: string): boolean {
  const mentions = code
    .replace(IMPORT_CLAUSE, "")
    .match(WITH_CAPABILITY_NAMES)?.length;
  const calls = code.match(ANY_WITH_CAPABILITY_CALL)?.length ?? 0;
  return (mentions ?? 0) > calls;
}

/** The files of the apps that must not import the module that holds the helper, in any form. */
function tenantTransactionImporters(
  files: ReadonlyMap<string, string>
): string[] {
  return [...files]
    .filter(
      ([path, source]) =>
        WITHOUT_TENANT_TRANSACTION.some((folder) => path.startsWith(folder)) &&
        TENANT_TRANSACTION_MODULE.test(withoutComments(source))
    )
    .map(([path]) => path);
}

/** Every source file (tests included) of the `src` folder of each package under `apps/` and `packages/`, by its path relative to the repository. */
function repositorySources(): Map<string, string> {
  const files = new Map<string, string>();
  for (const parent of SCAN_PARENTS) {
    for (const entry of readdirSync(new URL(`${parent}/`, REPO), {
      withFileTypes: true,
    })) {
      const root = `${parent}/${entry.name}/src/`;
      if (!(entry.isDirectory() && existsSync(new URL(root, REPO)))) {
        continue;
      }
      const names = readdirSync(new URL(root, REPO), {
        encoding: "utf8",
        recursive: true,
      });
      for (const name of names) {
        const path = `${root}${name.split("\\").join("/")}`;
        if (SOURCE_FILE.test(name) && statSync(new URL(path, REPO)).isFile()) {
          files.set(path, readFileSync(new URL(path, REPO), "utf8"));
        }
      }
    }
  }
  return files;
}

describe("withCapability in the repository", () => {
  const files = repositorySources();

  it("is named only where the capability was already proved", () => {
    // the scan reaches every root it is meant to hold
    for (const root of [
      "apps/web/src/server/rpc/",
      "apps/catalog/src/",
      "apps/admin/src/",
      "packages/db/src/",
    ]) {
      expect(
        [...files.keys()].filter((path) => path.startsWith(root)).length
      ).toBeGreaterThan(0);
    }
    expect(files.size).toBeGreaterThan(0);
    // the use case and the handlers it is meant to hold, the definition and the cases of this guard
    const users = [...files]
      .filter(([, source]) =>
        WITH_CAPABILITY_NAME.test(withoutComments(source))
      )
      .map(([path]) => path)
      .sort();
    expect(users).toEqual(
      [
        THIS_GUARD,
        ...LEASE_COVERED_HANDLERS,
        "apps/web/src/server/use-cases/create-product-with-opening-stock.ts",
        DEFINITION,
      ].sort()
    );
    expect(offenders(files)).toEqual([]);
  });

  it("keeps apps/admin and apps/catalog away from @polaris/db/tenant-transaction", () => {
    expect(tenantTransactionImporters(files)).toEqual([]);
  });

  it("sees an import, a call, a renamed import and an alias anywhere else, and not a comment", () => {
    expect(
      offenders(
        new Map([
          [
            "apps/admin/src/a.ts",
            'import { withCapability } from "@polaris/db/tenant-transaction";',
          ],
          [
            "apps/catalog/src/b.ts",
            "const next = withCapability(identity, X);",
          ],
          [
            "packages/domain/src/c.tsx",
            'import { withCapability as elevate } from "@polaris/db/tenant-transaction";',
          ],
          [
            "apps/web/src/server/sync/push.ts",
            "const elevate = ns.withCapability;",
          ],
          [
            "apps/web/src/server/rpc/d.test.ts",
            "// withCapability(identity, X)\n/* withCapability */",
          ],
        ])
      )
    ).toEqual([
      "apps/admin/src/a.ts",
      "apps/catalog/src/b.ts",
      "packages/domain/src/c.tsx",
      "apps/web/src/server/sync/push.ts",
    ]);
    expect(
      offenders(
        new Map([
          [
            "apps/web/src/other.ts",
            "const next = ns.withCapability(identity, X);",
          ],
        ])
      )
    ).toEqual(["apps/web/src/other.ts"]);
    expect(
      tenantTransactionImporters(
        new Map([
          [
            "apps/admin/src/a.ts",
            'import { x } from "@polaris/db/tenant-transaction";',
          ],
          [
            "apps/catalog/src/b.ts",
            'const m = await import("@polaris/db/tenant-transaction");',
          ],
          [
            "apps/catalog/src/c.ts",
            '// import { x } from "@polaris/db/tenant-transaction";',
          ],
          [
            "apps/web/src/server/d.ts",
            'import { x } from "@polaris/db/tenant-transaction";',
          ],
        ])
      )
    ).toEqual(["apps/admin/src/a.ts", "apps/catalog/src/b.ts"]);
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
    // where the folder is checked, naming the helper without calling it is no use either
    const alias = `
import { withCapability } from "@polaris/db/tenant-transaction";
export async function create(tx, identity) {
  requireCapabilityInTransaction(identity, "inventory:adjust");
  const elevate = withCapability;
  return stock(tx, elevate(identity, "inventory:adjust"));
}
`;
    const viaCall = `
export async function create(tx, identity) {
  requireCapabilityInTransaction(identity, "inventory:adjust");
  return stock(tx, withCapability.call(null, identity, "inventory:adjust"));
}
`;
    const reexport = `export { withCapability } from "@polaris/db/tenant-transaction";`;
    const guardedWithImport = `
import { requireCapabilityInTransaction, withCapability } from "@polaris/db/tenant-transaction";
${guarded}`;
    expect(
      offenders(
        new Map([
          ["apps/web/src/server/use-cases/alias.ts", alias],
          ["apps/web/src/server/rpc/via-call.ts", viaCall],
          ["apps/web/src/server/rpc/reexport.ts", reexport],
          ["apps/web/src/server/use-cases/ok.ts", guardedWithImport],
        ])
      )
    ).toEqual([
      "apps/web/src/server/use-cases/alias.ts",
      "apps/web/src/server/rpc/via-call.ts",
      "apps/web/src/server/rpc/reexport.ts",
    ]);
    // a use only in a comment is no use
    expect(
      offenders(
        new Map([
          [
            "apps/web/src/server/sync/push.ts",
            "// withCapability(identity, x)\n",
          ],
        ])
      )
    ).toEqual([]);

    expect(
      offenders(
        new Map([
          ["apps/web/src/server/use-cases/guarded.ts", guarded],
          ["apps/web/src/server/rpc/guarded.ts", guarded],
          ["apps/web/src/server/sync/handlers/stock-commands.ts", unguarded],
        ])
      )
    ).toEqual([]);
    expect(
      offenders(
        new Map([
          ["apps/web/src/server/use-cases/unguarded.ts", unguarded],
          [
            "apps/web/src/server/use-cases/guarded-elsewhere.ts",
            guardedElsewhere,
          ],
          ["apps/web/src/server/rpc/unguarded.ts", unguarded],
          // a handler outside the closed list, even one that checks the role
          ["apps/web/src/server/sync/handlers/new-command.ts", guarded],
          // outside the folders the rule knows
          ["apps/web/src/server/sync/push.ts", guarded],
          ["apps/web/src/server/use-cases/renamed.ts", renamed],
        ])
      )
    ).toEqual([
      "apps/web/src/server/use-cases/unguarded.ts",
      "apps/web/src/server/use-cases/guarded-elsewhere.ts",
      "apps/web/src/server/rpc/unguarded.ts",
      "apps/web/src/server/sync/handlers/new-command.ts",
      "apps/web/src/server/sync/push.ts",
      "apps/web/src/server/use-cases/renamed.ts",
    ]);
  });
});
