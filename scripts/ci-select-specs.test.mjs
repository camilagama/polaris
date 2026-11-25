import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_SCREEN_SPECS,
  COVERAGE_MAP,
  DIRECTORY_SCREENS,
  SCREEN_ENTRY_POINTS,
  SCREEN_ROUTES,
  SPEC_SCREENS,
  specsForScreens,
} from "../e2e/coverage-map.mjs";
import {
  globToRegExp,
  listSpecFiles,
  selectionForRun,
  selectSpecs,
} from "./ci-select-specs.mjs";
import { gitEnvironment } from "./exact-count-list.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const web = path.join(root, "apps/web");
const SCRIPT = path.join(root, "scripts/ci-select-specs.mjs");
const SPEC_FOLDERS = ["e2e", "e2e-pwa", "e2e-real"];
const TYPESCRIPT_FILE = /\.tsx?$/;
const UNIT_TEST_IMPORT = /from\s+["'][^"']*\.test["']/;
const OFFLINE_OR_SERVER = /src\/(?:offline-poc|server)\//;
const ADMIN_REFERENCE = /apps\/admin|\.\.\/admin\/|admin\/ui/;
const PROSE_REFERENCE =
  /(?:\.\.\/)+(?:docs?|DESIGN|PRODUCT|CONTEXT|AGENTS)\b|["'`/]docs?\/|\.md["'`]/;
const MIN_SCREEN_IMPORTS = 1000;
const MIN_SPEC_APP_IMPORTS = 50;
const MIN_APP_SOURCES_SCANNED = 350;
const CONFIGS = [
  ["playwright.offline-poc.config.ts", "e2e"],
  ["playwright.pwa.config.ts", "e2e-pwa"],
  ["playwright.e2e-real.config.ts", "e2e-real"],
];

const SPECS_ON_DISK = listSpecFiles();
const glob = (pattern) => globToRegExp(pattern);
const select = (...files) => selectSpecs(files);

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(result.status).toBe(0);
  return result.stdout.split("\0").filter(Boolean);
}

/** What `playwright test --list` of each config runs: the entry spec files, as repository paths. */
function playwrightSpecs() {
  const cli = createRequire(path.join(web, "package.json")).resolve(
    "@playwright/test/cli"
  );
  const folderOfReports = mkdtempSync(path.join(tmpdir(), "ci-select-specs-"));
  try {
    return CONFIGS.flatMap(([config, folder]) => {
      const report = path.join(folderOfReports, `${folder}.json`);
      const env = { ...gitEnvironment(), PLAYWRIGHT_JSON_OUTPUT_NAME: report };
      env.CI = "";
      const result = spawnSync(
        "node",
        [cli, "test", "--config", config, "--list", "--reporter=json"],
        { cwd: web, encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 }
      );
      expect(result.status, result.stderr).toBe(0);
      const { suites } = JSON.parse(readFileSync(report, "utf8"));
      return suites.map((suite) => `apps/web/${folder}/${suite.file}`);
    });
  } finally {
    rmSync(folderOfReports, { force: true, recursive: true });
  }
}

const sourceExtensions = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function resolveImport(from, specifier, alias) {
  let base;
  if (specifier.startsWith("@/") && alias) {
    base = path.join(web, "src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(from), specifier);
  } else {
    return null;
  }
  return (
    sourceExtensions
      .map((extension) => base + extension)
      .find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile()
      ) ?? null
  );
}

/** Files reached by static and dynamic imports from `entries`, stopping at the boundary `stop` says. */
function closure(entries, { alias = true, stop = () => false } = {}) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    if (stop(file)) {
      return;
    }
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const target = resolveImport(file, match[1], alias);
      if (target) {
        visit(target);
      }
    }
  };
  for (const entry of entries) {
    visit(path.join(root, entry));
  }
  return seen;
}

const repoPath = (file) => path.relative(root, file).split(path.sep).join("/");

describe("seletor de specs pelo diff", () => {
  it("um caminho mapeado seleciona só os specs do que ele alcança", () => {
    const result = select("apps/web/src/sales/sale-cancel-panel.tsx");
    expect(result.full).toBe(false);
    expect(result.specs).toEqual(specsForScreens(["sale-detail"]));
    expect(result.specs).toContain(
      "apps/web/e2e-pwa/sale-detail-operations.e2e.ts"
    );
    expect(result.specs).not.toContain("apps/web/e2e/clientes-reflow.e2e.ts");
    expect(result.specs.length).toBeLessThan(SPECS_ON_DISK.length / 2);
  });

  it("um arquivo de tela sem lista própria usa as telas do diretório, nunca menos", () => {
    const result = select("apps/web/src/sales/uma-novidade.tsx");
    expect(result.full).toBe(false);
    expect(result.specs).toEqual(specsForScreens(DIRECTORY_SCREENS.sales));
  });

  it("vários arquivos selecionam a união dos specs", () => {
    const result = select(
      "apps/web/src/customers/customers-page.tsx",
      "apps/web/src/help/help-page.tsx"
    );
    expect(result.specs).toEqual(
      [
        ...new Set([
          ...select("apps/web/src/customers/customers-page.tsx").specs,
          ...select("apps/web/src/help/help-page.tsx").specs,
        ]),
      ].sort()
    );
  });

  it.each([
    "apps/web/src/main.tsx",
    "apps/web/src/pwa/service-worker.ts",
    "apps/web/src/observability/sentry.ts",
    "apps/web/index.html",
    "apps/web/public/_headers",
    "apps/web/scripts/precache-delta.ts",
    "apps/catalog/src/index.ts",
    "packages/db/src/schema.ts",
    "scripts/ci-changed.mjs",
    "e2e/coverage-map.mjs",
    "ci/test-durations.json",
  ])("o caminho fora do mapa %s roda a suíte toda", (file) => {
    const result = select(file);
    expect(result).toMatchObject({ full: true, specs: [] });
    expect(result.motivo).toContain("fora do mapa");
  });

  it("um caminho fora do mapa no meio de caminhos mapeados roda a suíte toda", () => {
    const result = select(
      "apps/web/src/customers/customers-page.tsx",
      "apps/web/src/main.tsx"
    );
    expect(result.full).toBe(true);
  });

  it.each([
    ["package.json", "package.json"],
    ["apps/web/package.json", "package.json"],
    ["packages/domain/package.json", "package.json"],
    ["bun.lock", "bun.lock"],
    ["apps/web/playwright.pwa.config.ts", "Playwright"],
    ["apps/web/playwright.offline-poc.config.ts", "Playwright"],
    ["apps/web/playwright.e2e-real.config.ts", "Playwright"],
    ["apps/web/vite.config.ts", "Vite"],
    ["apps/web/vite.pwa.config.ts", "Vite"],
    ["apps/web/vite.offline.config.ts", "Vite"],
    ["apps/web/vite.ui.ts", "Vite"],
    ["tsconfig.base.json", "TypeScript"],
    ["apps/web/tsconfig.json", "TypeScript"],
    ["apps/web/tsconfig.worker.json", "TypeScript"],
    ["biome.jsonc", "Biome"],
    [".github/workflows/ci.yml", ".github"],
    [".github/PULL_REQUEST_TEMPLATE.md", ".github"],
    ["apps/web/src/app-shell/app.tsx", "toda tela"],
    ["apps/web/src/lib/current-organization.ts", "toda tela"],
    ["apps/web/src/ui/button.tsx", "toda tela"],
    ["apps/web/src/offline/runtime/offline-runtime.ts", "toda tela"],
    ["apps/web/src/styles/index.css", "toda tela"],
    ["apps/web/src/ui/button.test.tsx", "toda tela"],
    ["apps/web/worker/index.ts", "Worker"],
    ["packages/contracts/src/index.ts", "contracts/domain"],
    ["packages/domain/src/money/money.ts", "contracts/domain"],
    ["apps/web/e2e/reflow.ts", "helper ou fixture"],
    ["apps/web/e2e/home/shared.ts", "helper ou fixture"],
    ["apps/web/e2e-pwa/support.ts", "helper ou fixture"],
    ["apps/web/e2e-pwa/fixtures/admin-waiting-item.json", "helper ou fixture"],
    ["apps/web/e2e-real/fixtures.ts", "helper ou fixture"],
    ["apps/web/e2e-real/seed.ts", "helper ou fixture"],
  ])("%s força a suíte toda", (file, rule) => {
    const result = select(file);
    expect(result).toMatchObject({ full: true, specs: [] });
    expect(result.motivo).toContain("força a suíte toda");
    expect(result.motivo).toContain(rule);
  });

  it("o que força a suíte toda vale mesmo ao lado de um spec ou de um caminho mapeado", () => {
    expect(
      select(
        "apps/web/src/customers/customers-page.tsx",
        "apps/web/e2e/clientes-erros.e2e.ts",
        "bun.lock"
      ).full
    ).toBe(true);
  });

  it("um spec alterado entra na própria lista", () => {
    const result = select("apps/web/e2e/clientes-erros.e2e.ts");
    expect(result).toEqual({
      full: false,
      motivo: expect.any(String),
      specs: ["apps/web/e2e/clientes-erros.e2e.ts"],
    });
  });

  it("um spec alterado soma-se aos specs do código alterado", () => {
    const result = select(
      "apps/web/src/help/help-page.tsx",
      "apps/web/e2e-real/jornadas/venda.e2e.ts"
    );
    expect(result.specs).toContain("apps/web/e2e-real/jornadas/venda.e2e.ts");
    expect(result.specs).toEqual(
      expect.arrayContaining(select("apps/web/src/help/help-page.tsx").specs)
    );
  });

  it("um spec apagado não volta na lista", () => {
    const result = select(
      "apps/web/e2e/spec-que-saiu.e2e.ts",
      "apps/web/src/help/help-page.tsx"
    );
    expect(result.specs).not.toContain("apps/web/e2e/spec-que-saiu.e2e.ts");
  });

  it("a baseline da regressão visual seleciona só o spec visual", () => {
    expect(
      select("apps/web/e2e-pwa/ui-visual.e2e.ts-snapshots/inicio-360.png").specs
    ).toEqual(["apps/web/e2e-pwa/ui-visual.e2e.ts"]);
  });

  it("o diff vazio roda a suíte toda", () => {
    for (const files of [[], [""], ["  ", "\n"]]) {
      expect(selectSpecs(files)).toMatchObject({ full: true, specs: [] });
    }
  });

  it("texto e teste unitário não selecionam spec e não rodam a suíte toda", () => {
    const result = select(
      "doc/status-implementacao.md",
      "docs/runbooks/medir-o-ci.md",
      "AGENTS.md",
      ".claude/skills/verify-polaris/features/inicio.md",
      "apps/web/src/sales/sale-cancel-panel.test.tsx"
    );
    expect(result).toMatchObject({ full: false, specs: [] });
  });

  it("o mapa injetado e a lista de specs injetada decidem", () => {
    const result = selectSpecs(["a/x.ts", "b/y.ts"], {
      map: [
        { code: ["a/**"], specs: ["apps/web/e2e/um.e2e.ts"] },
        { code: ["a/x.ts"], specs: ["apps/web/e2e/dois.e2e.ts"] },
      ],
      specFiles: ["apps/web/e2e/um.e2e.ts", "apps/web/e2e/dois.e2e.ts"],
    });
    expect(result.full).toBe(true);
    const first = selectSpecs(["a/x.ts"], {
      map: [
        { code: ["a/x.ts"], specs: ["apps/web/e2e/dois.e2e.ts"] },
        { code: ["a/**"], specs: ["apps/web/e2e/um.e2e.ts"] },
      ],
      specFiles: ["apps/web/e2e/um.e2e.ts", "apps/web/e2e/dois.e2e.ts"],
    });
    expect(first.specs).toEqual(["apps/web/e2e/dois.e2e.ts"]);
  });

  describe("linha de comando", () => {
    const run = (args, input) =>
      JSON.parse(
        spawnSync("node", [SCRIPT, ...args], {
          cwd: root,
          encoding: "utf8",
          input,
        }).stdout
      );

    it("lê os caminhos dos argumentos", () => {
      expect(run(["apps/web/src/help/help-page.tsx"])).toEqual(
        select("apps/web/src/help/help-page.tsx")
      );
    });

    it("lê os caminhos da entrada padrão", () => {
      expect(
        run([], "apps/web/src/help/help-page.tsx\napps/web/src/main.tsx\n")
      ).toMatchObject({ full: true, specs: [] });
    });

    it("sem caminho nenhum, roda a suíte toda", () => {
      expect(run([], "")).toMatchObject({ full: true, specs: [] });
    });

    it("a sabotagem de uma tela mapeada é pega pelo spec dela", () => {
      const result = run(["apps/web/src/customers/customer-form.tsx"]);
      expect(result.full).toBe(false);
      expect(result.specs).toEqual(
        expect.arrayContaining([
          "apps/web/e2e/clientes-erros.e2e.ts",
          "apps/web/e2e/clientes-reflow.e2e.ts",
        ])
      );
    });

    it("a sabotagem fora do mapa roda a suíte toda", () => {
      expect(run(["apps/web/src/pwa/service-worker.ts"])).toMatchObject({
        full: true,
        specs: [],
      });
    });
  });
});

describe("globs", () => {
  it("** atravessa pastas e * não", () => {
    expect(glob("a/**").test("a/b/c.ts")).toBe(true);
    expect(glob("a/*.ts").test("a/b/c.ts")).toBe(false);
    expect(glob("a/*.ts").test("a/c.ts")).toBe(true);
    expect(glob("a/**/*.ts").test("a/c.ts")).toBe(true);
    expect(glob("*.md").test("docs/x.md")).toBe(false);
    expect(glob("*.md").test("AGENTS.md")).toBe(true);
    expect(glob("a/b.ts").test("a/bxts")).toBe(false);
  });
});

describe("guarda do mapa de cobertura", () => {
  const tracked = trackedFiles();
  const realSpecs = playwrightSpecs();

  it("lê os specs de verdade: nenhuma lista vazia passa em branco", () => {
    for (const [, folder] of CONFIGS) {
      const own = realSpecs.filter((spec) =>
        spec.startsWith(`apps/web/${folder}/`)
      );
      expect(own.length, folder).toBeGreaterThan(20);
    }
    expect(Object.keys(SPEC_SCREENS).length).toBe(realSpecs.length);
  });

  it("todo spec que o Playwright lista está em alguma entrada do mapa", () => {
    const uncovered = realSpecs.filter(
      (spec) =>
        !COVERAGE_MAP.some((pair) =>
          pair.specs.some((pattern) => glob(pattern).test(spec))
        )
    );
    expect(
      uncovered,
      "spec sem entrada: acrescente-o a SPEC_SCREENS em e2e/coverage-map.mjs com as telas que ele abre"
    ).toEqual([]);
  });

  it("SPEC_SCREENS tem exatamente os specs que o Playwright lista", () => {
    expect(Object.keys(SPEC_SCREENS).sort()).toEqual([...realSpecs].sort());
  });

  it("os specs do disco são os que o Playwright lista", () => {
    expect(SPECS_ON_DISK).toEqual([...realSpecs].sort());
  });

  it("todo spec citado existe", () => {
    for (const pair of COVERAGE_MAP) {
      for (const pattern of pair.specs) {
        const found = SPECS_ON_DISK.filter((spec) => glob(pattern).test(spec));
        expect(found.length, `${pattern} não casa spec nenhum`).toBeGreaterThan(
          0
        );
      }
    }
  });

  it("todo glob de código do mapa casa com algum arquivo que existe", () => {
    for (const pair of COVERAGE_MAP) {
      for (const pattern of pair.code) {
        const matcher = glob(pattern);
        expect(
          tracked.some((file) => matcher.test(file)),
          `${pattern} não casa arquivo nenhum`
        ).toBe(true);
      }
    }
  });

  it("nenhuma tela ou diretório do mapa aponta para o que não existe", () => {
    for (const screen of Object.keys(DIRECTORY_SCREENS)) {
      expect(existsSync(path.join(web, "src", screen)), screen).toBe(true);
    }
    for (const [screen, entries] of Object.entries(SCREEN_ENTRY_POINTS)) {
      for (const entry of entries) {
        expect(existsSync(path.join(root, entry)), `${screen}: ${entry}`).toBe(
          true
        );
      }
    }
    const known = new Set(Object.keys(SCREEN_ENTRY_POINTS));
    for (const screens of [
      ...Object.values(DIRECTORY_SCREENS),
      ...Object.values(SPEC_SCREENS).filter(Array.isArray),
    ]) {
      for (const screen of screens) {
        expect(known.has(screen), `tela ${screen} sem entrada`).toBe(true);
      }
    }
  });

  it("o mapa não dá lista de telas aos diretórios que forçam a suíte toda", () => {
    for (const forcing of ["app-shell", "lib", "ui", "offline", "styles"]) {
      expect(Object.keys(DIRECTORY_SCREENS)).not.toContain(forcing);
    }
  });

  it("toda tela que importa um arquivo de código o tem entre os specs dela", () => {
    const missing = [];
    const importedByScreen = {};
    for (const [screen, entries] of Object.entries(SCREEN_ENTRY_POINTS)) {
      const expected = specsForScreens([screen]);
      const entryFiles = new Set(
        entries.map((entry) => path.join(root, entry))
      );
      importedByScreen[screen] = 0;
      for (const file of closure(entries)) {
        const relative = repoPath(file);
        if (relative.includes(".test.")) {
          continue;
        }
        if (!entryFiles.has(file)) {
          importedByScreen[screen] += 1;
        }
        const result = select(relative);
        if (result.full) {
          continue;
        }
        const lacking = expected.filter((spec) => !result.specs.includes(spec));
        if (lacking.length > 0) {
          missing.push(`${relative} (tela ${screen}): falta ${lacking[0]}`);
        }
      }
    }
    for (const [screen, imported] of Object.entries(importedByScreen)) {
      expect(
        imported,
        `${screen}: a varredura não achou arquivo nenhum importado pelo ponto de entrada da tela (a regex IMPORT perdeu o formato?)`
      ).toBeGreaterThanOrEqual(1);
    }
    expect(
      Object.values(importedByScreen).reduce((sum, n) => sum + n, 0),
      "arquivos de código importados pelas telas e conferidos: abaixo do piso, a varredura de imports deixou de ler o código"
    ).toBeGreaterThan(MIN_SCREEN_IMPORTS);
    expect(
      missing,
      "o arquivo é importado pela tela mas não a seleciona: ponha-o em FILE_SCREENS ou acrescente a tela a DIRECTORY_SCREENS (e2e/coverage-map.mjs)"
    ).toEqual([]);
  });

  it("todo spec que importa código do app o tem entre os que o código seleciona", () => {
    const missing = [];
    let appFilesReached = 0;
    for (const spec of realSpecs) {
      const reached = closure([spec], {
        alias: true,
        stop: (file) => file.startsWith(path.join(web, "src")),
      });
      for (const file of reached) {
        if (!file.startsWith(path.join(web, "src"))) {
          continue;
        }
        appFilesReached += 1;
        const result = select(repoPath(file));
        if (!(result.full || result.specs.includes(spec))) {
          missing.push(`${spec} importa ${repoPath(file)}`);
        }
      }
    }
    expect(
      appFilesReached,
      "arquivos de apps/web/src alcançados pelos imports dos specs: abaixo do piso, a varredura de imports deixou de ler os specs"
    ).toBeGreaterThan(MIN_SPEC_APP_IMPORTS);
    expect(missing).toEqual([]);
  });

  it("cada spec declara pelo menos as telas que os endereços do próprio arquivo abrem", () => {
    const wrong = [];
    for (const spec of realSpecs) {
      const declared = SPEC_SCREENS[spec];
      if (!Array.isArray(declared)) {
        continue;
      }
      const reached = closure([spec], {
        alias: false,
        stop: (file) => file.includes("/src/"),
      });
      const text = [...reached]
        .filter((file) => !file.includes("/src/"))
        .map((file) => readFileSync(file, "utf8"))
        .join("\n");
      for (const [screen, patterns] of Object.entries(SCREEN_ROUTES)) {
        if (
          patterns.some((pattern) => pattern.test(text)) &&
          !declared.includes(screen)
        ) {
          wrong.push(`${spec}: abre ${screen}`);
        }
      }
    }
    expect(
      wrong,
      "o spec abre a tela mas SPEC_SCREENS não diz: acrescente-a (ou troque por 'all' se ele anda por todas)"
    ).toEqual([]);
  });

  it("nenhum arquivo do código do app importa um teste unitário", () => {
    const offenders = [];
    let scanned = 0;
    for (const file of tracked) {
      if (
        !(
          file.startsWith("apps/web/src/") &&
          TYPESCRIPT_FILE.test(file) &&
          !file.includes(".test.")
        )
      ) {
        continue;
      }
      scanned += 1;
      if (UNIT_TEST_IMPORT.test(readFileSync(path.join(root, file), "utf8"))) {
        offenders.push(file);
      }
    }
    expect(
      scanned,
      "arquivos de código de apps/web/src varridos: abaixo do piso, a lista de arquivos do git deixou de trazê-los"
    ).toBeGreaterThan(MIN_APP_SOURCES_SCANNED);
    expect(offenders).toEqual([]);
  });

  it("só o spec do Admin lê arquivos do Admin", () => {
    const readers = [];
    const visit = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") {
            visit(full);
          }
        } else if (
          TYPESCRIPT_FILE.test(entry.name) &&
          ADMIN_REFERENCE.test(readFileSync(full, "utf8"))
        ) {
          readers.push(repoPath(full));
        }
      }
    };
    for (const folder of SPEC_FOLDERS) {
      visit(path.join(web, folder));
    }
    expect(readers).toEqual([
      "apps/web/e2e-pwa/admin-waiting-alignment.e2e.ts",
    ]);
  });

  it("toda página que o app e o laboratório de telas importam está no fecho de alguma tela do mapa", () => {
    const reached = closure(Object.values(SCREEN_ENTRY_POINTS).flat());
    const mapped = new Set(Object.keys(DIRECTORY_SCREENS));
    const orphans = [];
    for (const host of [
      "apps/web/src/app-shell/app.tsx",
      "apps/web/src/offline-poc/screens-lab.tsx",
    ]) {
      for (const file of closure([host], {
        stop: (candidate) => candidate !== path.join(root, host),
      })) {
        const relative = path.relative(path.join(web, "src"), file);
        if (mapped.has(relative.split(path.sep)[0]) && !reached.has(file)) {
          orphans.push(`${repoPath(file)} (importado por ${host})`);
        }
      }
    }
    expect(
      orphans,
      "página sem tela em SCREEN_ENTRY_POINTS: acrescente a entrada dela em e2e/coverage-map.mjs"
    ).toEqual([]);
  });

  it("a peça do shell que a galeria serve só importa de diretórios que forçam a suíte toda", () => {
    const piece = "apps/web/src/offline-poc/screens-lab-shell-pieces.tsx";
    const inside = [
      ...closure([piece], {
        stop: (candidate) => candidate !== path.join(root, piece),
      }),
    ]
      .map(repoPath)
      .filter(
        (file) => file !== piece && file.startsWith("apps/web/src/offline-poc/")
      );
    expect(inside).toEqual([]);
  });

  it("nenhuma entrada de FILE_SCREENS cobre o que os pares de offline-poc e do servidor decidem", () => {
    const narrow = COVERAGE_MAP.filter((pair) => pair.screens);
    for (const pair of narrow) {
      for (const pattern of pair.code) {
        expect(pattern).not.toMatch(OFFLINE_OR_SERVER);
      }
    }
  });

  it("nenhum arquivo das pastas de e2e lê texto de docs", () => {
    const readers = [];
    const visit = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") {
            visit(full);
          }
        } else if (
          TYPESCRIPT_FILE.test(entry.name) &&
          PROSE_REFERENCE.test(readFileSync(full, "utf8"))
        ) {
          readers.push(repoPath(full));
        }
      }
    };
    for (const folder of SPEC_FOLDERS) {
      visit(path.join(web, folder));
    }
    expect(readers).toEqual([]);
  });

  it("os specs 'all' são os que andam por todas as telas ou não se prendem a uma", () => {
    expect(ALL_SCREEN_SPECS.length).toBeGreaterThan(0);
    expect(ALL_SCREEN_SPECS).toContain("apps/web/e2e/reflow-rotas.e2e.ts");
    expect(ALL_SCREEN_SPECS).toContain(
      "apps/web/e2e-pwa/ui-guardrails/telas-01.e2e.ts"
    );
  });
});

describe("selectionForRun (o job do PR)", () => {
  const diff = (files) => () => files;
  const run = (overrides = {}) =>
    selectionForRun({
      base: "HEAD^1",
      changed: diff(["apps/web/src/sales/x.ts"]),
      env: {},
      head: "HEAD",
      select: (files) => ({ full: false, motivo: "m", specs: files }),
      ...overrides,
    });

  it("seleciona pelo diff num PR comum", () => {
    expect(run()).toEqual({
      full: false,
      motivo: "m",
      specs: ["apps/web/src/sales/x.ts"],
    });
  });

  it("roda tudo com CI_FULL, em dispatch e em push, sem ler o diff", () => {
    const never = () => {
      throw new Error("não devia ler o diff");
    };
    for (const env of [
      { CI_FULL: "true" },
      { GITHUB_EVENT_NAME: "workflow_dispatch" },
      { GITHUB_EVENT_NAME: "push" },
    ]) {
      const result = run({ changed: never, env });
      expect(result.full).toBe(true);
      expect(result.specs).toEqual([]);
    }
  });

  it("CI_FULL=false não pede a suíte toda", () => {
    expect(run({ env: { CI_FULL: "false" } }).full).toBe(false);
  });

  it("roda tudo quando o git falha", () => {
    const result = run({
      changed: () => {
        throw new Error("git diff HEAD^1 HEAD saiu com 128");
      },
    });
    expect(result.full).toBe(true);
    expect(result.motivo).toContain("falha ao selecionar");
    expect(result.motivo).toContain("128");
  });

  it("roda tudo quando o seletor falha", () => {
    const result = run({
      select: () => {
        throw new Error("mapa quebrado");
      },
    });
    expect(result).toMatchObject({ full: true, specs: [] });
    expect(result.motivo).toContain("mapa quebrado");
  });

  it("usa o seletor de verdade: arquivo fora do mapa roda tudo, tela mapeada roda os specs dela", () => {
    expect(
      selectionForRun({
        base: "a",
        changed: diff(["apps/web/src/zzz-fora-do-mapa/x.ts"]),
        env: {},
        head: "b",
      }).full
    ).toBe(true);
    expect(
      selectionForRun({
        base: "a",
        changed: diff(["docs/runbooks/medir-o-ci.md"]),
        env: {},
        head: "b",
      })
    ).toMatchObject({ full: false, specs: [] });
  });
});

describe("--diff na linha de comando", () => {
  const cli = (args, env = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...gitEnvironment(), ...env },
    });

  it("sai com 0 e a suíte toda quando o git não acha as revisões", () => {
    const result = cli(["--diff", "nao-existe-1", "nao-existe-2"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ full: true, specs: [] });
  });

  it("sai com 0 e a suíte toda sem os argumentos", () => {
    const result = cli(["--diff"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).full).toBe(true);
  });

  it("grava a seleção em --out", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "t1517-out-"));
    try {
      const out = path.join(dir, "selection.json");
      const result = cli(["--diff", "x", "y", "--out", out], {
        CI_FULL: "true",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(
        JSON.parse(result.stdout)
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
