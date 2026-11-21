import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  check,
  configFacts,
  globToRegExp,
  metricsOf,
  parseList,
  parseNameStatus,
  render,
  testKind,
  weakenings,
  withoutComments,
} from "./check-protegidos.ts";

const LIST = [
  "# comentário",
  "",
  "apps/web/e2e/*.e2e.ts",
  "apps/web/src/server/auth/*.test.ts",
  "packages/db/scripts/**",
  "",
].join("\n");

const SESSION_TEST = `import { expect, it } from "vitest";
it("recusa a sessão revogada", () => {
  expect(refuse("revoked")).toBe(true);
  expect(refuse("expired")).toBe(true);
});
it("aceita a sessão viva", () => {
  expect(refuse("live")).toBe(false);
});
`;

const GATE = `import assert from "node:assert";
assert(await run("select 1") === 1);
assert(await run("select 2") === 2);
`;

const E2E = `import { expect, test } from "@playwright/test";
test("sai do aparelho", async ({ page }) => {
  await expect(page.getByRole("button")).toBeVisible();
});
`;

const PLAYWRIGHT_CONFIG = `export default defineConfig({
  projects: [
    { name: "desktop", testIgnore: ["**/phone.e2e.ts"] },
  ],
  retries: inCI ? 1 : 0,
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
});
`;

const CHANGES_KIND_OR_LEAVES_LIST = /muda o tipo|a lista não cobre/;
const FIRST_TEST = /test\("sai[\s\S]*$/;

const BASE_FILES = {
  "apps/web/e2e/sair.e2e.ts": E2E,
  "apps/web/playwright.config.ts": PLAYWRIGHT_CONFIG,
  "apps/web/src/other.ts": "export const x = 1;\n",
  "apps/web/src/server/auth/sessions.test.ts": SESSION_TEST,
  "packages/db/scripts/gate-a.ts": GATE,
  "tests/protegidos.txt": LIST,
};

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_AUTHOR_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
    },
  });

const folders = [];

function write(cwd, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      unlinkSync(join(cwd, path));
    } else {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
  }
}

/** A real repository: `main` holds the base files, the branch `pr` holds each change as one commit. */
function repository(change, { message = "muda", baseFiles = BASE_FILES } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "protegidos-"));
  folders.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "commit.gpgsign", "false");
  write(cwd, baseFiles);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  git(cwd, "switch", "-q", "-c", "pr");
  change(cwd, (path) => git(cwd, "mv", path.from, path.to));
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return cwd;
}

const run = (cwd) => render(check({ base: "main", cwd, head: "HEAD" }));
const outcomeOf = (change, options) => run(repository(change, options));

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { force: true, recursive: true });
  }
});

describe("a change that weakens a protected test", () => {
  it("fails on a .skip added to a protected file", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/src/server/auth/sessions.test.ts": SESSION_TEST.replace(
          'it("aceita',
          'it.skip("aceita'
        ),
      })
    );
    expect(code).toBe(1);
    expect(text).toContain("apps/web/src/server/auth/sessions.test.ts");
    expect(text).toContain("ganhou 1 .skip");
  });

  it("fails on a case skipped through the context of the test", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/src/server/auth/sessions.test.ts": SESSION_TEST.replace(
          'it("aceita a sessão viva", () => {',
          'it("aceita a sessão viva", (ctx) => { ctx.skip();'
        ),
      })
    );
    expect(code).toBe(1);
    expect(text).toContain("ganhou 1 .skip");
  });

  it("fails on a case skipped through the options of the test", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/src/server/auth/sessions.test.ts": SESSION_TEST.replace(
          'it("aceita a sessão viva", ',
          'it("aceita a sessão viva", { skip: true }, '
        ),
      })
    );
    expect(code).toBe(1);
    expect(text).toContain("ganhou 1 .skip");
  });

  it("fails on a protected file that is deleted", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, { "apps/web/src/server/auth/sessions.test.ts": null })
    );
    expect(code).toBe(1);
    expect(text).toContain("sessions.test.ts: apagado");
  });

  it("fails on a protected file renamed out of the list", () => {
    const { code, text } = outcomeOf((_cwd, move) =>
      move({
        from: "apps/web/src/server/auth/sessions.test.ts",
        to: "apps/web/src/server/auth/sessions.spec.ts",
      })
    );
    expect(code).toBe(1);
    expect(text).toContain(
      "renomeado para apps/web/src/server/auth/sessions.spec.ts"
    );
  });

  it("lets a protected file be renamed to a place the list still covers", () => {
    const { code, text } = outcomeOf((_cwd, move) =>
      move({
        from: "apps/web/e2e/sair.e2e.ts",
        to: "apps/web/e2e/sair-do-aparelho.e2e.ts",
      })
    );
    expect(text).not.toContain("problema");
    expect(code).toBe(0);
  });

  it("fails on a retry above zero", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/e2e/sair.e2e.ts": `${E2E}test.describe.configure({ retries: 2 });\n`,
      })
    );
    expect(code).toBe(1);
    expect(text).toContain("ganhou retry/retries acima de zero");
  });

  it("fails on an expect fewer", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/src/server/auth/sessions.test.ts": SESSION_TEST.replace(
          '  expect(refuse("expired")).toBe(true);\n',
          ""
        ),
      })
    );
    expect(code).toBe(1);
    expect(text).toContain("perdeu chamadas expect/assert (de 3 para 2)");
  });

  it("fails on an assert fewer in a database gate, whose folder is protected as a class", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "packages/db/scripts/gate-a.ts": GATE.replace(
          'assert(await run("select 2") === 2);\n',
          ""
        ),
      })
    );
    expect(code).toBe(1);
    expect(text).toContain(
      "packages/db/scripts/gate-a.ts: perdeu chamadas expect/assert"
    );
  });

  it("fails on a test case removed and on a quarantine marker", () => {
    const { text } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/e2e/sair.e2e.ts": `${E2E.replace(
          FIRST_TEST,
          ""
        )}// quarentena até a corrida ser achada\n`,
      })
    );
    expect(text).toContain("perdeu casos it/test");
    expect(text).toContain("marca de quarentena");
  });

  it("passes when the file gains asserts and cases", () => {
    const { code } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/src/server/auth/sessions.test.ts": `${SESSION_TEST}it("novo", () => {\n  expect(1).toBe(1);\n});\n`,
      })
    );
    expect(code).toBe(0);
  });

  it("passes on a change outside every protected file", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, { "apps/web/src/other.ts": "export const x = 2;\n" })
    );
    expect(code).toBe(0);
    expect(text).toContain("nenhum teste protegido enfraquecido");
  });
});

describe("the list", () => {
  it("fails on a line the list lost", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "tests/protegidos.txt": LIST.replace(
          "apps/web/src/server/auth/*.test.ts\n",
          ""
        ),
      })
    );
    expect(code).toBe(1);
    expect(text).toContain(
      "perdeu a linha `apps/web/src/server/auth/*.test.ts`"
    );
    expect(text).toContain("sessions.test.ts: saiu da lista");
  });

  it("fails on a glob that matches no file (orphan)", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "tests/protegidos.txt": `${LIST}apps/web/e2e/nao-existe-*.e2e.ts\n`,
      })
    );
    expect(code).toBe(1);
    expect(text).toContain(
      "o glob `apps/web/e2e/nao-existe-*.e2e.ts` não casa com nenhum arquivo"
    );
  });

  it("fails when the list is deleted", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, { "tests/protegidos.txt": null })
    );
    expect(code).toBe(1);
    expect(text).toContain("a lista foi apagada");
  });

  it("lets the list grow", () => {
    const { code } = outcomeOf((cwd) =>
      write(cwd, { "tests/protegidos.txt": `${LIST}apps/web/src/other.ts\n` })
    );
    expect(code).toBe(0);
  });
});

describe("the config of the runner", () => {
  it("fails on a filter that reaches a protected file", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/playwright.config.ts": PLAYWRIGHT_CONFIG.replace(
          '["**/phone.e2e.ts"]',
          '["**/phone.e2e.ts", "**/sair.e2e.ts"]'
        ),
      })
    );
    expect(code).toBe(1);
    expect(text).toContain(
      "apps/web/e2e/sair.e2e.ts: apps/web/playwright.config.ts ganhou o filtro `**/sair.e2e.ts`"
    );
  });

  it("fails when the config stops including a protected file", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/playwright.config.ts": PLAYWRIGHT_CONFIG.replace(
          '"**/*.e2e.ts"',
          '"**/ui-*.e2e.ts"'
        ),
      })
    );
    expect(code).toBe(1);
    expect(text).toContain("deixou de incluí-lo");
  });

  it("fails when the retries of a config that runs protected files go up", () => {
    const { code, text } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/playwright.config.ts": PLAYWRIGHT_CONFIG.replace(
          "inCI ? 1 : 0",
          "inCI ? 2 : 0"
        ),
      })
    );
    expect(code).toBe(1);
    expect(text).toContain("retry/retries sobe de 1 para 2");
  });

  it("passes on a filter that reaches only unprotected files", () => {
    const { code } = outcomeOf((cwd) =>
      write(cwd, {
        "apps/web/playwright.config.ts": PLAYWRIGHT_CONFIG.replace(
          '["**/phone.e2e.ts"]',
          '["**/phone.e2e.ts", "**/lab.e2e.ts"]'
        ),
      })
    );
    expect(code).toBe(0);
  });
});

describe("the acceptance trailer", () => {
  const skipped = (cwd) =>
    write(cwd, {
      "apps/web/e2e/sair.e2e.ts": E2E.replace("test(", "test.skip("),
    });

  it("releases the change and says what it released", () => {
    const { code, text } = outcomeOf(skipped, {
      message: "tira o teste\n\nProtegido-Aceito-Por: Rodrigo",
    });
    expect(code).toBe(0);
    expect(text).toContain("LIBERADA(S) por Protegido-Aceito-Por: Rodrigo");
    expect(text).toContain(
      "liberado: apps/web/e2e/sair.e2e.ts: ganhou 1 .skip"
    );
  });

  it("does not release with the trailer of another person", () => {
    const { code } = outcomeOf(skipped, {
      message: "tira o teste\n\nProtegido-Aceito-Por: Fulano",
    });
    expect(code).toBe(1);
  });

  it("does not release with a name that only starts like the accepted one", () => {
    for (const name of ["Rodrigo-nao", "Rodrigo Silva", "Rodrigoo"]) {
      const { code } = outcomeOf(skipped, {
        message: `tira o teste\n\nProtegido-Aceito-Por: ${name}`,
      });
      expect(code, name).toBe(1);
    }
  });

  it("does not release with the words only in the body", () => {
    const { code } = outcomeOf(skipped, {
      message:
        "tira o teste\n\nProtegido-Aceito-Por: Rodrigo\n\ndepois do trailer vem texto",
    });
    expect(code).toBe(1);
  });

  it("does not release with a trailer that came in with the base", () => {
    const cwd = mkdtempSync(join(tmpdir(), "protegidos-"));
    folders.push(cwd);
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "commit.gpgsign", "false");
    write(cwd, BASE_FILES);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "base");
    git(cwd, "switch", "-q", "-c", "pr");
    skipped(cwd);
    git(cwd, "commit", "-q", "-a", "-m", "tira o teste");
    git(cwd, "switch", "-q", "main");
    write(cwd, { "apps/web/src/other.ts": "export const x = 3;\n" });
    git(
      cwd,
      "commit",
      "-q",
      "-a",
      "-m",
      "outro PR\n\nProtegido-Aceito-Por: Rodrigo"
    );
    git(cwd, "switch", "-q", "pr");
    expect(run(cwd).code).toBe(1);
  });
});

describe("renames inside a folder the list covers", () => {
  it("fails when a gate or a test stops being discoverable by its extension or marker", () => {
    for (const [from, to] of [
      ["packages/db/scripts/gate-a.ts", "packages/db/scripts/gate-a.ts.off"],
      [
        "apps/web/src/server/auth/sessions.test.ts",
        "apps/web/src/server/auth/sessions.ts",
      ],
    ]) {
      const { code, text } = outcomeOf((_cwd, move) => move({ from, to }));
      expect(code, `${from} -> ${to}`).toBe(1);
      expect(text).toMatch(CHANGES_KIND_OR_LEAVES_LIST);
    }
  });

  it("lets a gate move to another folder the list covers", () => {
    const { code } = outcomeOf((cwd, move) => {
      mkdirSync(join(cwd, "packages/db/scripts/sub"), { recursive: true });
      move({
        from: "packages/db/scripts/gate-a.ts",
        to: "packages/db/scripts/sub/gate-a.ts",
      });
    });
    expect(code).toBe(0);
  });
});

describe("the config of the runner, testDir and real files", () => {
  const WITH_TEST_DIR = {
    ...BASE_FILES,
    "apps/web/playwright.config.ts": `export default defineConfig({
  testDir: "./e2e",
  projects: [{ name: "a", testIgnore: ["x.e2e.ts"] }],
  testMatch: "*.e2e.ts",
});
`,
  };

  it("reads testMatch and testIgnore against the testDir of the config", () => {
    const { code, text } = outcomeOf(
      (cwd) =>
        write(cwd, {
          "apps/web/playwright.config.ts": `export default defineConfig({
  testDir: "./e2e",
  projects: [{ name: "a", testIgnore: ["x.e2e.ts", "sair.e2e.ts"] }],
  testMatch: "*.e2e.ts",
});
`,
        }),
      { baseFiles: WITH_TEST_DIR }
    );
    expect(code).toBe(1);
    expect(text).toContain("ganhou o filtro `sair.e2e.ts`");
  });

  it("keeps a folder wildcard inside a glob out of the comment stripper", () => {
    expect(
      withoutComments('include: ["src/**/*.test.ts"], // c\n/* b */ x')
    ).toBe('include: ["src/**/*.test.ts"], \n x');
    const facts = configFacts(
      'export default { test: { include: ["packages/**/*.test.{ts,tsx}", "apps/**/*.test.ts"] } };'
    );
    expect(facts.includes).toEqual([
      "packages/**/*.test.{ts,tsx}",
      "apps/**/*.test.ts",
    ]);
  });

  it("reads the real configs of the repository: includes, testDir and the retries the CI sets", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const read = (path) => configFacts(readFileSync(join(root, path), "utf8"));
    const vitest = read("vitest.config.ts");
    expect(vitest.includes).toContain("packages/**/*.test.{ts,tsx}");
    expect(vitest.includes).toContain("scripts/**/*.test.mjs");
    const pwa = read("apps/web/playwright.pwa.config.ts");
    expect(pwa.includes).toContain("**/*.e2e.ts");
    expect(pwa.testDir).toBe("./e2e-pwa");
    expect(pwa.retrySum).toBe(1);
    const real = read("apps/web/playwright.e2e-real.config.ts");
    expect(real.testDir).toBe("./e2e-real");
    expect(real.includes.length).toBeGreaterThan(0);
    expect(
      globToRegExp("apps/web/e2e-real/pilha/isolamento.e2e.ts").test(
        "apps/web/e2e-real/pilha/isolamento.e2e.ts"
      )
    ).toBe(true);
  });
});

describe("helpers", () => {
  it("reads globs: ** crosses folders and may match none, * and ? stay in one segment, braces choose", () => {
    expect(globToRegExp("a/**/*.test.ts").test("a/b/c/x.test.ts")).toBe(true);
    expect(globToRegExp("a/**/*.test.ts").test("a/x.test.ts")).toBe(true);
    expect(globToRegExp("a/*.test.ts").test("a/b/x.test.ts")).toBe(false);
    expect(globToRegExp("a/x?.ts").test("a/xy.ts")).toBe(true);
    expect(globToRegExp("a/*.test.{ts,tsx}").test("a/x.test.tsx")).toBe(true);
    expect(globToRegExp("a/*.test.{ts,tsx}").test("a/x.test.js")).toBe(false);
    expect(globToRegExp("a/b.c").test("a/bxc")).toBe(false);
    expect(
      globToRegExp("packages/db/scripts/**").test("packages/db/scripts/x/y.ts")
    ).toBe(true);
  });

  it("tells the kind of file a runner discovers", () => {
    expect(testKind("a/b/x.test.ts")).toBe(".test.ts");
    expect(testKind("a/x.workerd-db.test.ts")).toBe(".test.ts");
    expect(testKind("a/x.e2e.ts")).toBe(".e2e.ts");
    expect(testKind("packages/db/scripts/gate-a.ts")).toBe(".ts");
    expect(testKind("packages/db/scripts/gate-a.ts.off")).toBe(".off");
  });

  it("ignores comments and blank lines of the list", () => {
    expect(parseList("# a\n\n x \n#b\ny")).toEqual(["x", "y"]);
  });

  it("does not count a skip in a comment or in a string", () => {
    const metrics = metricsOf(
      '// it.skip("x")\nconst text = "test.only(";\nit("y", () => { expect(1).toBe(1); });\n'
    );
    expect(metrics.skips).toBe(0);
    expect(metrics.cases).toBe(1);
    expect(metrics.assertions).toBe(1);
  });

  it("counts a skip made through the context, a destructured skip and the skip option", () => {
    const forms = [
      'it("a", (ctx) => { ctx.skip(); });',
      'it("a", (context) => { context.skip(); });',
      'it("a", ({ skip }) => { skip(); });',
      'it("a", { skip: true }, () => {});',
      'it("a", { skip: process.env.CI }, () => {});',
      'it("a", { todo: true }, () => {});',
      'it("a", { fails: true }, () => {});',
      'test("a", async ({ page }, testInfo) => { testInfo.fixme(); });',
    ];
    for (const form of forms) {
      expect(metricsOf(form).skips, form).toBe(1);
    }
    expect(metricsOf('it.skip("a", { skip: true }, () => {});').skips).toBe(2);
    expect(metricsOf('it.skip("a", () => {});').skips).toBe(1);
  });

  it("does not count a skip that is off, in a string or in a comment", () => {
    for (const quiet of [
      'it("a", { skip: false }, () => {});',
      'it("a", { skip: 0 }, () => {});',
      'it("a", () => { const page = { skip: undefined }; });',
      'it("a", () => { // ctx.skip()\n });',
      'it("a", () => { const text = "ctx.skip()"; });',
    ]) {
      expect(metricsOf(quiet).skips, quiet).toBe(0);
    }
  });

  it("counts the forms of skip and of retry", () => {
    expect(
      metricsOf('test.describe.only("a", () => {}); xit("b"); testInfo.skip();')
        .skips
    ).toBe(3);
    expect(
      weakenings(metricsOf("retries: 0"), metricsOf("retries: 0"))
    ).toEqual([]);
    expect(metricsOf("{ retry: true }").retryCount).toBe(1);
  });

  it("reads the includes and the filters of a config", () => {
    const facts = configFacts(PLAYWRIGHT_CONFIG);
    expect(facts.includes).toEqual(["**/*.e2e.ts"]);
    expect([...facts.filters]).toEqual(["**/phone.e2e.ts"]);
    expect(facts.retrySum).toBe(1);
  });

  it("reads renames of git diff -z", () => {
    expect(parseNameStatus("R090\0a.ts\0b.ts\0M\0c.ts\0D\0d.ts\0")).toEqual([
      { from: "a.ts", path: "b.ts", status: "R" },
      { path: "c.ts", status: "M" },
      { path: "d.ts", status: "D" },
    ]);
  });
});
