import { describe, expect, it } from "vitest";
import {
  checkRepository,
  documentedOverrides,
  overrideKeys,
  overrideProblems,
} from "./verify-dependency-overrides.mjs";

// the walk reads the whole tree; a loaded runner can pass the default 5 s
const REPOSITORY_WALK_TIMEOUT_MS = 20_000;

const TABLE = `# Auditoria

## Overrides vigentes

| Override | Desde | Motivo | Remover quando |
| --- | --- | --- | --- |
| \`zod: 4.6.7\` (raiz) | 23/10/2026 | aviso | o plugin pedir faixa |
| \`undici: 7.30.1\` só sob \`miniflare\` | 24/10/2026 | aviso | miniflare pedir >= 7.30.1 |

## Outra seção

| \`fora: 1.0.0\` | x | y | z |
`;

const ROOT = {
  overrides: { miniflare: { undici: "7.30.1" }, zod: "4.6.7" },
};

const problems = (rootPackage, runbook = TABLE, workspacePackages = {}) =>
  overrideProblems({ rootPackage, runbook, workspacePackages });

describe("overrideKeys", () => {
  it("names a root override and an override under a parent", () => {
    expect(overrideKeys(ROOT)).toEqual([
      "undici@7.30.1 só sob miniflare",
      "zod@4.6.7",
    ]);
  });
});

describe("overrideKeys with more than one level", () => {
  it("names the deep override so it can never match a row", () => {
    expect(overrideKeys({ overrides: { a: { b: { c: "1.0.0" } } } })).toEqual([
      "b em mais de um nível sob a",
    ]);
  });
});

describe("documentedOverrides", () => {
  it("reads only the rows of the section", () => {
    expect([...documentedOverrides(TABLE).rows.keys()]).toEqual([
      "zod@4.6.7",
      "undici@7.30.1 só sob miniflare",
    ]);
  });
});

describe("overrideProblems", () => {
  it("accepts overrides that match the table", () => {
    expect(problems(ROOT)).toEqual([]);
  });

  it("refuses an override without a row, saying where to write it", () => {
    const found = problems({
      overrides: { ...ROOT.overrides, tmp: "0.2.7" },
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("tmp@0.2.7");
    expect(found[0]).toContain("docs/runbooks/dependency-audit.md");
    expect(found[0]).toContain("Remover quando");
  });

  it("refuses a version bump that did not update the row", () => {
    expect(
      problems({ overrides: { miniflare: { undici: "7.30.1" }, zod: "4.6.8" } })
    ).toHaveLength(2);
  });

  it("refuses the same package under another parent", () => {
    expect(
      problems({ overrides: { cheerio: { undici: "7.30.1" }, zod: "4.6.7" } })
        .length
    ).toBe(2);
  });

  it("refuses a row whose override is gone", () => {
    expect(problems({ overrides: { zod: "4.6.7" } }).join("\n")).toContain(
      "tire a linha"
    );
  });

  it("refuses a row with an empty removal condition", () => {
    const runbook = TABLE.replace("| o plugin pedir faixa |", "|  |");
    expect(problems(ROOT, runbook).join("\n")).toContain(
      'sem "Remover quando"'
    );
  });

  it("refuses a runbook without the section", () => {
    expect(problems(ROOT, "# nada\n").join("\n")).toContain(
      'falta a seção "## Overrides vigentes"'
    );
  });

  it("refuses resolutions in the root that are not in the table", () => {
    expect(
      problems({ ...ROOT, resolutions: { tmp: "0.2.7" } }).join("\n")
    ).toContain("tmp@0.2.7");
  });

  it("refuses overrides in a workspace package, where Bun ignores them", () => {
    expect(
      problems(ROOT, TABLE, {
        "apps/web/package.json": { overrides: { zod: "4.6.7" } },
      }).join("\n")
    ).toContain("apps/web/package.json");
  });
});

describe("the repository", () => {
  it(
    "has every root override in the runbook table, and nothing else",
    () => {
      expect(checkRepository()).toEqual([]);
    },
    REPOSITORY_WALK_TIMEOUT_MS
  );
});
