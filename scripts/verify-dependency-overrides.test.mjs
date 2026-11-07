import { describe, expect, it } from "vitest";
import {
  checkRepository,
  documentedOverrides,
  isRegistryVersion,
  overrideKeys,
  overrideProblems,
  sourceProblems,
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

const FOREIGN_SOURCES = {
  "after a valid range": [
    "^1.0.0 || github:evil/undici",
    "valor que não é versão",
  ],
  alias: ["npm:evil-undici@7.30.1", "alias para outro pacote"],
  catalog: ["catalog:", "valor que não é versão"],
  empty: ["", "valor que não é versão"],
  file: ["file:./vendor/undici", "caminho local"],
  git: ["git://github.com/evil/undici.git", "repositório git"],
  "git+https": [
    "git+https://github.com/evil/undici.git#main",
    "repositório git",
  ],
  "git+ssh": ["git+ssh://git@github.com/evil/undici.git", "repositório git"],
  github: ["github:evil/undici", "repositório git"],
  "github in capitals": ["GitHub:evil/undici", "repositório git"],
  http: ["http://example.com/undici.tgz", "endereço de tarball"],
  jsr: ["jsr:@evil/undici@1", "valor que não é versão"],
  "leading space": [" github:evil/undici", "valor que não é versão"],
  link: ["link:../undici", "caminho local"],
  reference: ["$undici", "referência a dependência direta"],
  shorthand: ["evil/undici", "valor que não é versão"],
  ssh: ["git@github.com:evil/undici.git", "valor que não é versão"],
  tag: ["latest", "valor que não é versão"],
  url: ["https://example.com/undici-7.30.1.tgz", "endereço de tarball"],
  workspace: ["workspace:*", "caminho local"],
};

describe("isRegistryVersion", () => {
  it.each([
    "7.30.1",
    "0.35.5",
    "4.6.7-rc.1",
    "^7.30.1",
    "~1.20.5",
    ">=7.30.1",
    ">=1.0.0 <2.0.0",
    "1.2.3 - 2.3.4",
    "^1 || ^2.1",
    "7.x",
    ">=1.2.3 <2",
    ">= 1.2.3",
    "v1.2.3",
  ])("accepts %s", (value) => {
    expect(isRegistryVersion(value)).toBe(true);
  });

  it.each(Object.values(FOREIGN_SOURCES).map(([value]) => value))(
    "refuses %j",
    (value) => {
      expect(isRegistryVersion(value)).toBe(false);
    }
  );
});

describe("sourceProblems", () => {
  it.each(Object.entries(FOREIGN_SOURCES))(
    "refuses a %s override, naming the package and the reason",
    (_kind, [value, reason]) => {
      const found = sourceProblems({ overrides: { undici: value } });
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("undici");
      expect(found[0]).toContain(JSON.stringify(value));
      expect(found[0]).toContain(reason);
      expect(found[0]).toContain("não versão do registro");
    }
  );

  it("refuses a foreign source under a parent, naming both", () => {
    const found = sourceProblems({
      overrides: { miniflare: { undici: "git+https://example.com/u.git" } },
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("miniflare > undici");
  });

  it("reaches a foreign source more than one level down", () => {
    const found = sourceProblems({
      overrides: { a: { b: { c: "git+https://example.com/c.git" } } },
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("a > b > c");
    expect(found[0]).toContain("repositório git");
  });

  it("refuses a foreign source in resolutions", () => {
    expect(
      sourceProblems({ resolutions: { tmp: "file:./tmp" } }).join("\n")
    ).toContain("resolution de tmp");
  });

  it("refuses a value that is not text", () => {
    expect(sourceProblems({ overrides: { tmp: 7 } }).join("\n")).toContain(
      "um valor que não é texto"
    );
  });

  it("accepts an exact version and a range", () => {
    expect(
      sourceProblems({
        overrides: { miniflare: { undici: "^7.30.1" }, zod: "4.6.7" },
      })
    ).toEqual([]);
  });
});

describe("overrideProblems with a foreign source", () => {
  it("fails even when the row of the table exists and matches", () => {
    const runbook = TABLE.replace("`zod: 4.6.7`", "`zod: npm:evil-zod@4.6.7`");
    const found = problems(
      { overrides: { ...ROOT.overrides, zod: "npm:evil-zod@4.6.7" } },
      runbook
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("alias para outro pacote");
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
