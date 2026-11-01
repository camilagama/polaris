import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOC_PATHS_LIST } from "./verify-doc-paths.list.mjs";
import {
  ADVICE,
  checkRepository,
  missingPaths,
  namedPaths,
} from "./verify-doc-paths.mjs";

describe("namedPaths", () => {
  it("reads repository paths between backticks and relative links", () => {
    expect(
      namedPaths(
        "Veja `apps/web/src/a.ts:12-20`, `docs/x.md#seção`, [b](../b.md) e `scripts/c.mjs`."
      )
    ).toEqual(["apps/web/src/a.ts", "docs/x.md", "scripts/c.mjs", "../b.md"]);
  });

  it.each([
    "`apps/web/dist/client/_headers`",
    "`apps/web/.wrangler/state`",
    "`apps/web/test-results/e2e-real/`",
    "`apps/web/.dev.vars`",
    "`packages/domain/reports/`",
    "`apps/web/src/**/*.tsx`",
    "`docs/adr/0NNN-<nome>.md`",
    "`apps/{web,admin}/x.ts`",
    "`apps/web/$ARQ`",
    "[site](https://example.com/a)",
    "[âncora](#seção)",
    "[rota](/termos)",
    "`node_modules/x`",
    "sem crase apps/web/src/a.ts",
  ])("ignores %s", (markdown) => {
    expect(namedPaths(markdown)).toEqual([]);
  });
});

describe("missingPaths", () => {
  const files = {
    "apps/web/scripts/serve.mjs": "",
    "apps/web/src/a.ts": "",
    "DESIGN.md": "`apps/web/src/velho.ts` e `apps/web/src/velho.ts:3`\n",
    "docs/runbooks/x.md":
      "`apps/web/src/a.ts`, `scripts/serve.mjs` (do app), [y](y.md), [z](../../docs/runbooks/y.md)\n",
    "docs/runbooks/y.md": "",
  };

  const withTree = (run) => {
    const base = mkdtempSync(path.join(tmpdir(), "doc-paths-"));
    try {
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
        writeFileSync(path.join(base, file), text);
      }
      return run(base);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  };

  it("resolves from the root, the document folder and a workspace, and counts what is missing", () => {
    expect(withTree(missingPaths)).toEqual({
      "DESIGN.md → apps/web/src/velho.ts": 2,
    });
  });

  it("refuses a document that still names a deleted file and says how to find the others", () => {
    expect(withTree((base) => checkRepository(base, {}))).toEqual([
      `DESIGN.md → apps/web/src/velho.ts: 2 referência(s) a um caminho que não existe no repositório. ${ADVICE}`,
    ]);
    expect(ADVICE).toContain("rg -n");
  });
});

describe("the repository", () => {
  it("is exact: every entry of the list matches the tree", () => {
    expect(checkRepository()).toEqual([]);
    expect(Object.keys(DOC_PATHS_LIST).length).toBeGreaterThan(0);
  });
});
