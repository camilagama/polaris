import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADVICE,
  IGNORED_FOLDERS,
  checkRepository,
  checkSource,
  collectFiles,
  extractComments,
  stripComments,
  findViolations,
} from "./verify-no-history-comments.mjs";

// the opening of a template expression, spelled out so the fixtures below are not strings that look like one
const OPEN = "${";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const sourceFile = /\.(?:ts|tsx|mjs|js)$/;

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
    ["// [bloqueia] sem teste", "vocabulário de revisão"],
    ["// (bloqueia)", "vocabulário de revisão"],
    ["// Bloqueia o PR", "vocabulário de revisão"],
    ["// não bloqueia o PR", "vocabulário de revisão"],
    ["// menor 3", "vocabulário de revisão"],
    ["// VC2", "vocabulário de revisão"],
    ["// PR-12", "vocabulário de revisão"],
    ["// achado do reviewer", "vocabulário de revisão"],
    ["// decisão de 19/10", "data"],
    ["// decisão de 19/10/2026", "data"],
    ["// em 5/3/26", "data"],
    ["// emenda de 01/10", "data"],
    ["// decisão de 2026-10-28", "data"],
    ["// (Rodrigo, 2026-10-28)", "data"],
    ["// medido em 2027-01-05T10:00:00Z", "data"],
    ["// condição do PR 296", "número de PR"],
    ["// feito no #374", "número de PR"],
    ["// (#1234)", "número de PR"],
    ["// pull request 374", "número de PR"],
    ["// Pull Request #374", "número de PR"],
    ["// o pull request 12 mudou", "número de PR"],
    ["// as pull requests 374 e 375", "número de PR"],
    ["// pull request nº 374", "número de PR"],
    ["// PRs 374 e 375", "número de PR"],
    ["// Severidade: `bloqueia`", "vocabulário de revisão"],
    ["// **bloqueia**: falta teste", "vocabulário de revisão"],
    ["// bloqueia: sem teste", "vocabulário de revisão"],
    ["/**\n * bloqueia - sem teste\n */", "vocabulário de revisão"],
    ["// bloqueia o merge.", "vocabulário de revisão"],
    ["// bloqueia o merge do PR até o teste", "vocabulário de revisão"],
    ["// o achado bloqueia o PR", "vocabulário de revisão"],
    ["// PR #296", "número de PR"],
    ["// T399-3 do desenho", "id de tarefa"],
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
    "// o lock bloqueia a escrita até o commit",
    "// bloqueia o botão enquanto envia",
    "// bloqueia as outras abas e o merge do estado local",
    "// a revisão bloqueia",
    "// bloqueia o merge do estado local",
    "// o lock bloqueia a entrega do webhook",
    "// bloqueia a aprovação do pagamento até o webhook",
    "// a fila bloqueia o merge das linhas até o fim da página",
    "// o lock bloqueia: ninguém escreve",
    "// 2026-10 é o período e 2026 o ano",
    "// meses 2026-13-01 e 2026-10-32 não existem",
    "// versão 12026-10-28 e 2026-10-281",
    '// a data "2026-10-28" no rótulo e `2026-10-28` no campo',
    "// a cor `#374` e #000, #111, #123456, #fff, #2563eb",
    "// o chunk #12 e a issue #23113 do WebKit",
    "// a seção #root e o item &#1234;",
    "// a pull request aberta e as pull requests",
    "// pull request sem número",
    "// os pull requests de teste e a pull request",
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

  it.each([
    "const a = <p><b>x</b> {/* t123 */}</p>;",
    "const a = <b>x</b>; // t123",
    "const a = <p>Don't</p>; // t123",
    "n++ / 2; // t123",
    "const f = (x) => /a\\/b/.test(x); // t123",
    "const s = 'x\\\n y'; // t123",
  ])("reads the comment after %s", (source) => {
    expect(checkSource(source)).toEqual([
      { line: expect.any(Number), kind: "id de tarefa", match: "t123" },
    ]);
  });

  it("counts the line after a line continuation inside a string", () => {
    expect(checkSource("const s = 'x\\\n y'; // t123")[0].line).toBe(2);
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

  it("reads every source file of the tree, tests, e2e, scripts and configs included, and nothing else", () => {
    const base = mkdtempSync(path.join(tmpdir(), "history-comments-"));
    try {
      const bad = "// t268\n";
      const scanned = [
        "apps/web/src/a.ts",
        "apps/web/src/deep/b.tsx",
        "apps/web/src/c.test.ts",
        "apps/web/worker/d.ts",
        "apps/admin/src/e.ts",
        "apps/admin/ui/f.ts",
        "packages/db/src/g.ts",
        "packages/db/scripts/h.mjs",
        "apps/web/e2e/i.e2e.ts",
        "apps/web/e2e-pwa/j.e2e.ts",
        "apps/web/e2e-real/jornadas/k.e2e.ts",
        "apps/web/scripts/l.ts",
        "apps/web/pwa/m.ts",
        "apps/web/real-devices/n.ts",
        "apps/web/poc/o.ts",
        "apps/web/public/p.js",
        "apps/web/vite.config.ts",
        "apps/web/playwright.pwa.config.ts",
        "apps/catalog/e2e/q.e2e.ts",
        "scripts/r.mjs",
        "scripts/r.test.mjs",
        "vitest.config.ts",
      ];
      const ignored = [
        "apps/web/src/s.css",
        "apps/web/src/t.d.ts",
        "apps/web/src/u.md",
        "apps/web/src/node_modules/v.ts",
        "apps/web/node_modules/w.ts",
        "apps/web/dist/x.js",
        "apps/web/dist-bare/y.js",
        "apps/web/dist-e2e/z.js",
        "apps/web/dist-fixture/aa.js",
        "apps/web/.wrangler/bb.js",
        "apps/web/.e2e-state/cc.js",
        "apps/web/test-results/dd.js",
        "apps/web/playwright-report/ee.js",
        "apps/admin/src/ui/generated/ff.js",
        "packages/db/drizzle/gg.ts",
        ".codex-worktrees/hh/scripts/ii.mjs",
        "coverage/jj.js",
        ".turbo/kk.js",
        ".git/ll.js",
      ];
      for (const relative of [...scanned, ...ignored]) {
        write(base, relative, bad);
      }
      expect(
        collectFiles(base).map((file) => path.relative(base, file))
      ).toEqual([...scanned].sort());
      expect(checkRepository(base)).toHaveLength(scanned.length);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });
});

describe("the repository", () => {
  it("ignores exactly these folders, at any depth", () => {
    expect([...IGNORED_FOLDERS].sort()).toEqual([
      ".codex-worktrees",
      ".e2e-state",
      ".git",
      ".turbo",
      ".wrangler",
      "coverage",
      "dist",
      "dist-bare",
      "dist-e2e",
      "dist-fixture",
      "drizzle",
      "generated",
      "node_modules",
      "playwright-report",
      "test-results",
      "worktrees",
    ]);
  });

  const tracked = () =>
    execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter((file) => sourceFile.test(file))
      .filter((file) => !file.endsWith(".d.ts"));

  it("scans the real tree: the roots of before, the paths added since, and every tracked source file", () => {
    const files = collectFiles().map((file) => path.relative(root, file));
    for (const known of [
      "apps/web/worker/index.ts",
      "apps/web/src/app-shell/app-shell.tsx",
      "apps/admin/src/worker.ts",
      "apps/admin/ui/app.ts",
      "apps/catalog/src/server/catalog.workerd-db.test.ts",
      "apps/catalog/e2e/csp.e2e.ts",
      "apps/catalog/playwright.config.ts",
      "packages/domain/src/index.ts",
      "packages/db/scripts/gate-clock.ts",
      "apps/web/e2e/app-shell.e2e.ts",
      "apps/web/e2e-pwa/ui-screens.ts",
      "apps/web/e2e-real/confinement.test.ts",
      "apps/web/scripts/ui-supply-chain.ts",
      "apps/web/pwa/precache-budget.ts",
      "apps/web/real-devices/suite.ts",
      "apps/web/vite.config.ts",
      "apps/web/playwright.pwa.config.ts",
      "scripts/verify-no-history-comments.mjs",
      "vitest.config.ts",
    ]) {
      expect(files).toContain(known);
    }
    expect(files.some((file) => file.endsWith(".test.ts"))).toBe(true);
    expect(
      files.filter((file) =>
        file.split("/").some((folder) => IGNORED_FOLDERS.has(folder))
      )
    ).toEqual([]);
    expect(files.filter((file) => !sourceFile.test(file))).toEqual([]);
    const tree = new Set(files);
    expect(tracked().filter((file) => !tree.has(file))).toEqual([]);
  });

  it("has no comment with history", () => {
    const failures = checkRepository().map(
      ({ file, line, kind, match }) => `${file}:${line} ${kind} "${match}"`
    );
    expect(failures).toEqual([]);
  });
});
