import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADVICE,
  checkRepository,
  checkSource,
  collectFiles,
  extractComments,
  stripComments,
  findViolations,
} from "./verify-no-history-comments.mjs";

// the opening of a template expression, spelled out so the fixtures below are not strings that look like one
const OPEN = "${";

const kinds = (source) =>
  checkSource(source).map((violation) => violation.kind);

describe("forbidden patterns in a comment", () => {
  it.each([
    ["// feito na t268", "id de tarefa"],
    ["// spike t092: nomes e tipos", "id de tarefa"],
    ["// tarefa t1234", "id de tarefa"],
    ["// (Rodrigo, 25/10)", "nome de pessoa ou bot"],
    ["// pedido do Léo", "nome de pessoa ou bot"],
    ["// Leo Moura pediu", "nome de pessoa ou bot"],
    ["// texto do Petković", "nome de pessoa ou bot"],
    ["// texto do Petkovic", "nome de pessoa ou bot"],
    ["// Filipe", "nome de pessoa ou bot"],
    ["// Everton disse", "nome de pessoa ou bot"],
    ["// Diego revisou", "nome de pessoa ou bot"],
    ["// o Arrascaeta decidiu", "nome de pessoa ou bot"],
    ["// Juan mediu", "nome de pessoa ou bot"],
    ["// Bruno", "nome de pessoa ou bot"],
    ["// Adriano", "nome de pessoa ou bot"],
    ["// Jorginho", "nome de pessoa ou bot"],
    ["// rodada 2 do Léo", "vocabulário de revisão"],
    ["// Rodada 12", "vocabulário de revisão"],
    ["// vale corrigir", "vocabulário de revisão"],
    ["// bloqueia o merge", "vocabulário de revisão"],
    ["// menor 3", "vocabulário de revisão"],
    ["// VC2", "vocabulário de revisão"],
    ["// PR-12", "vocabulário de revisão"],
    ["// achado do reviewer", "vocabulário de revisão"],
    ["// decisão de 19/10", "data"],
    ["// decisão de 19/10/2026", "data"],
    ["// em 5/3/26", "data"],
    ["// emenda de 01/10", "data"],
  ])("%s", (source, kind) => {
    expect(kinds(source)).toContain(kind);
  });

  it("reports the file line, the kind and the match", () => {
    expect(checkSource("const a = 1;\n\n// nota (t268)\n")).toEqual([
      { kind: "id de tarefa", line: 3, match: "t268" },
    ]);
  });

  it("says what to do", () => {
    expect(ADVICE).toBe(
      "Deixe só o porquê técnico; autoria e histórico ficam no git, no PR ou no ADR."
    );
  });
});

describe("allowed patterns in a comment", () => {
  it.each([
    "// ADR 0103, emenda",
    "// ADR 0081",
    "// plan PR12",
    "// PR123 do plano",
    "// AC-23 do corte",
    "// AC-9",
    "// GHSA-xxxx-yyyy-zzzz",
    "// https://example.com/docs/12/10/page",
    "/** see https://github.com/org/repo/issues/12/10 */",
    "// a razão de 3/4 do espaço",
    "// o ponto 24/7 e 1/2",
    "// caminho a/b/c",
    "// o ID t12 e a tarefa",
    "// uma fatia de 100/200 itens",
    "// tabelas t1 e t2",
    '// a data "24/10/2026" no rótulo e `01/10` no campo',
    "// Brunoso, Juanita, Diegos e Bloqueio",
    "// o texto bloqueado e desbloqueia",
    "// rodadas de teste e uma rodada qualquer",
    "// menores de idade e o menor valor",
  ])("%s", (source) => {
    expect(checkSource(source)).toEqual([]);
  });
});

describe("what counts as a comment", () => {
  it("does not flag a string with a task id", () => {
    expect(checkSource("const id = \"t123\"; const name = 'Rodrigo';")).toEqual(
      []
    );
  });

  it("does not flag a template literal, with or without an expression", () => {
    const source = `const a = \`t123 Rodrigo 25/10\`;\nconst b = \`x ${OPEN}y} // t123 ${OPEN}z} Léo\`;\n`;
    expect(checkSource(source)).toEqual([]);
  });

  it("reads a comment after a template with a nested expression", () => {
    const source = `const a = \`a ${OPEN}f(\`b ${OPEN}c}\`)} d\`; // t123\n`;
    expect(checkSource(source)).toEqual([
      { line: 1, kind: "id de tarefa", match: "t123" },
    ]);
  });

  it("does not flag a string that holds comment markers", () => {
    expect(
      checkSource('const url = "// t123"; const b = "/* Rodrigo */";')
    ).toEqual([]);
  });

  it("reads a comment that follows a string on the same line", () => {
    expect(checkSource('const id = "t123"; // t456')).toEqual([
      { kind: "id de tarefa", line: 1, match: "t456" },
    ]);
  });

  it("does not take a regex literal with slashes or quotes for a comment", () => {
    const source = [
      "const a = /\\/\\/ t123/;",
      "const b = /[/] Rodrigo/u.test(x);",
      "const c = x.replace(/\"'/g, ''); // t456",
    ].join("\n");
    expect(checkSource(source)).toEqual([
      { kind: "id de tarefa", line: 3, match: "t456" },
    ]);
  });

  it("tells a division from a regex", () => {
    expect(checkSource("const a = b / c; // t123 // Rodrigo")).toHaveLength(2);
  });

  it("reads block and JSDoc comments, one entry per line", () => {
    const source =
      "/**\n * Primeira linha.\n * Segunda (Petković, 24/10).\n */\nexport const a = 1;\n";
    expect(extractComments(source)).toContainEqual({
      line: 3,
      text: " * Segunda (Petković, 24/10).",
    });
    expect(checkSource(source).map(({ line }) => line)).toEqual([3, 3]);
  });

  it("keeps the line numbers across a multi-line template", () => {
    const source = "const a = `x\ny\nz`;\n// t123\n";
    expect(checkSource(source)).toEqual([
      { kind: "id de tarefa", line: 4, match: "t123" },
    ]);
  });

  it("reads JSX comments", () => {
    expect(checkSource("<div>{/* Rodrigo, 25/10 */}</div>")).toHaveLength(2);
  });

  it("is not swallowed by an apostrophe in JSX text", () => {
    const source = "<p>Don't stop</p>;\n// t123\n";
    expect(checkSource(source)).toEqual([
      { kind: "id de tarefa", line: 2, match: "t123" },
    ]);
  });

  it("finds each rule on a comment text", () => {
    expect(
      findViolations(" t268, Rodrigo e vale corrigir em 25/10")
    ).toHaveLength(4);
  });
});

describe("stripComments", () => {
  it("keeps the code and drops line, block and JSDoc comments but not strings", () => {
    const source =
      'const a = "// x"; // y\n/** z\n * w */\nconst b = /\\/ q/; /* v */ const c = 1;\n';
    expect(stripComments(source)).toBe(
      'const a = "// x"; \n\nconst b = /\\/ q/;  const c = 1;\n'
    );
  });
});

describe("scanned files", () => {
  const write = (base, relative, content) => {
    const file = path.join(base, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  it("reads src and worker of apps, src and scripts of packages, tests included, and nothing else", () => {
    const base = mkdtempSync(path.join(tmpdir(), "history-comments-"));
    try {
      const bad = "// t268\n";
      for (const relative of [
        "apps/web/src/a.ts",
        "apps/web/src/deep/b.tsx",
        "apps/web/src/c.test.ts",
        "apps/web/worker/d.ts",
        "apps/admin/src/e.ts",
        "packages/db/src/f.ts",
        "packages/db/scripts/g.mjs",
        "packages/db/scripts/h.test.mjs",
      ]) {
        write(base, relative, bad);
      }
      for (const relative of [
        "apps/web/e2e/i.e2e.ts",
        "apps/web/src/j.css",
        "apps/web/src/k.d.ts",
        "apps/web/src/node_modules/l.ts",
        "apps/web/poc/m.ts",
        "packages/db/drizzle/n.ts",
        "scripts/o.mjs",
        "docs/p.ts",
      ]) {
        write(base, relative, bad);
      }
      expect(
        collectFiles(base).map((file) => path.relative(base, file))
      ).toEqual([
        "apps/admin/src/e.ts",
        "apps/web/src/a.ts",
        "apps/web/src/c.test.ts",
        "apps/web/src/deep/b.tsx",
        "apps/web/worker/d.ts",
        "packages/db/scripts/g.mjs",
        "packages/db/scripts/h.test.mjs",
        "packages/db/src/f.ts",
      ]);
      expect(checkRepository(base)).toHaveLength(8);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });
});

describe("the repository", () => {
  it("has no comment with history", () => {
    const failures = checkRepository().map(
      ({ file, line, kind, match }) => `${file}:${line} ${kind} "${match}"`
    );
    expect(failures).toEqual([]);
  });
});
