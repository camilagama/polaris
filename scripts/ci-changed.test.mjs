import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyChanges,
  DATABASE_IRRELEVANT,
  fullSuiteRequested,
  OPERATIONS_FILES,
  reloadSentinelRuns,
} from "./ci-changed.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED_FOLDERS = new Set([
  "node_modules",
  "dist",
  "dist-bare",
  "dist-fixture",
  "coverage",
  "playwright-report",
  "test-results",
  ".wrangler",
  ".turbo",
]);

function sourceFiles(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_FOLDERS.has(entry.name) ? [] : sourceFiles(full);
    }
    return SOURCE_FILE.test(entry.name) ? [full] : [];
  });
}

/** Module specifiers of static, dynamic, re-exported and required imports. */
function importSpecifiers(source) {
  const found = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:\.resolve)?\s*\(\s*|\bvi\.(?:do)?[mM]ock\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    found.push(match[1]);
  }
  return found;
}

/** True when `specifier`, written in `file`, reaches the Admin app. */
function reachesAdminApp(file, specifier) {
  if (
    specifier === "@polaris/admin" ||
    specifier.startsWith("@polaris/admin/")
  ) {
    return true;
  }
  if (!specifier.startsWith(".")) {
    return false;
  }
  const target = path.relative(
    root,
    path.resolve(path.dirname(file), specifier)
  );
  return target === "apps/admin" || target.startsWith("apps/admin/");
}

const CONFIG_FILE =
  /^(?:tsconfig.*\.json|vite.*\.[cm]?ts|vitest.*\.[cm]?ts|wrangler.*\.jsonc?|playwright.*\.[cm]?ts|turbo\.json)$/;
const ADMIN_TEXT = /apps\/admin|@polaris\/admin|\.\.\/admin(?:[/"'`]|$)/;

/** Config files (tsconfig paths and references, Vite aliases, wrangler bindings) that name the Admin app. */
function adminConfigReferences() {
  const hits = [];
  const workspaces = [
    "apps/web",
    "apps/catalog",
    ...readdirSync(path.join(root, "packages")).map(
      (name) => `packages/${name}`
    ),
  ];
  for (const workspace of workspaces) {
    for (const entry of readdirSync(path.join(root, workspace), {
      withFileTypes: true,
    })) {
      if (
        entry.isFile() &&
        CONFIG_FILE.test(entry.name) &&
        ADMIN_TEXT.test(
          readFileSync(path.join(root, workspace, entry.name), "utf8")
        )
      ) {
        hits.push(`${workspace}/${entry.name}`);
      }
    }
  }
  return hits;
}

/** Every file outside apps/admin that imports the Admin app, or declares it as a dependency. */
function adminDependents() {
  const folders = ["apps/web", "apps/catalog", "packages"];
  const hits = [];
  for (const folder of folders) {
    for (const file of sourceFiles(path.join(root, folder))) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (reachesAdminApp(file, specifier)) {
          hits.push(`${path.relative(root, file)} -> ${specifier}`);
        }
      }
    }
  }
  const manifests = [
    "apps/web/package.json",
    "apps/catalog/package.json",
    ...readdirSync(path.join(root, "packages")).map(
      (name) => `packages/${name}/package.json`
    ),
  ];
  for (const manifest of manifests) {
    if (
      readFileSync(path.join(root, manifest), "utf8").includes("@polaris/admin")
    ) {
      hits.push(`${manifest} -> @polaris/admin`);
    }
  }
  return hits;
}

/** The operation scripts the browser gate skips (the proof is the import-graph test below). */
const EXPECTED_OPERATIONS_FILES = [
  "scripts/smoke-staging.mjs",
  "scripts/smoke-staging.test.mjs",
  "scripts/verify-staging-isolation.mjs",
  "scripts/verify-staging-isolation.test.mjs",
  "scripts/verify-no-lab-in-build.mjs",
  "scripts/verify-no-lab-in-build.test.mjs",
  "scripts/verify-no-map-published.mjs",
  "scripts/verify-no-map-published.test.mjs",
  "scripts/verify-migration-compat.mjs",
  "scripts/verify-migration-compat.test.mjs",
  "scripts/verify-adr-numbers.test.mjs",
  "scripts/admin-production-guard.test.mjs",
  "scripts/verify-production-build.mjs",
  "scripts/verify-production-build.test.mjs",
  "scripts/verify-production-workflow.mjs",
  "scripts/verify-production-workflow.test.mjs",
  "scripts/verify-deployed-sha.mjs",
  "scripts/verify-deployed-sha.test.mjs",
  "scripts/verify-backup-workflow.mjs",
  "scripts/verify-backup-workflow.test.mjs",
  "ops/backup/recipients-production.txt",
  "ops/backup/recipients-staging.txt",
  "scripts/lib/wrangler-config.mjs",
  "scripts/lib/wrangler-config.test.mjs",
  "scripts/gate5-real-devices.sh",
  "scripts/e2e-flaky-report.mjs",
  "scripts/e2e-flaky-report.test.mjs",
  "scripts/check-protegidos.ts",
  "scripts/check-protegidos.test.mjs",
  "tests/protegidos.txt",
  ".github/workflows/deploy-staging.yml",
];

/** True when `specifier`, written in `file`, resolves to the repository path `target`. */
function resolvesTo(file, specifier, target) {
  return (
    specifier.startsWith(".") &&
    path.relative(root, path.resolve(path.dirname(file), specifier)) === target
  );
}

const WRANGLER_MODULE = "scripts/lib/wrangler-config.mjs";

/** True when `source`, the text of `file`, imports the neutral wrangler module by a relative path. */
function importsWranglerModule(file, source) {
  return importSpecifiers(source).some((specifier) =>
    resolvesTo(file, specifier, WRANGLER_MODULE)
  );
}

/** Text that names `target` by a relative path (`../../scripts/x.mjs`, `new URL("../scripts/x.mjs", ...)`). */
function namesByRelativePath(text, target) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\.\\./)+${escaped}`).test(text);
}

/** Where the browser gate's own code lives: the specs it runs, the client it builds and serves, the shared packages. */
const GATE_SURFACE = [
  /^apps\/web\/(e2e|e2e-pwa|pwa|poc|public|src)\//,
  /^apps\/web\/(playwright|vite)[^/]*\.[cm]?ts$/,
  /^apps\/catalog\/(e2e|src)\//,
  /^apps\/catalog\/(playwright|vite)[^/]*\.[cm]?ts$/,
  /^packages\/(?!db\/)/,
];

/** Files that name `target` by its bare file name (`spawn("scripts/x.mjs")`, `join(root, ".github/workflows", "x.yml")`). */
function namesByBareName(text, target) {
  return text.includes(path.basename(target));
}

/** Every file of apps/web (Playwright configs included), apps/catalog and packages/ that reaches a file of `targets`. */
function operationsDependents(targets) {
  const hits = [];
  const workspaces = [
    "apps/web",
    "apps/catalog",
    ...readdirSync(path.join(root, "packages")).map(
      (name) => `packages/${name}`
    ),
  ];
  for (const workspace of workspaces) {
    const files = sourceFiles(path.join(root, workspace));
    for (const entry of readdirSync(path.join(root, workspace), {
      withFileTypes: true,
    })) {
      if (
        entry.isFile() &&
        (CONFIG_FILE.test(entry.name) || entry.name === "package.json")
      ) {
        files.push(path.join(root, workspace, entry.name));
      }
    }
    for (const file of files) {
      const relative = path.relative(root, file);
      const text = readFileSync(file, "utf8");
      const specifiers = SOURCE_FILE.test(file) ? importSpecifiers(text) : [];
      const onSurface =
        GATE_SURFACE.some((pattern) => pattern.test(relative)) ||
        relative.endsWith("/package.json");
      for (const target of targets) {
        if (
          specifiers.some((specifier) => resolvesTo(file, specifier, target)) ||
          namesByRelativePath(text, target) ||
          (onSurface && namesByBareName(text, target))
        ) {
          hits.push(`${relative} -> ${target}`);
        }
      }
    }
  }
  return hits;
}

const GATE_SCRIPT_FILE = /\.[cm]?[jt]s$/;
const TEST_FILE = /\.test\./;
const GATE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']|new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g;
const MODULE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  "/index.ts",
  "/index.tsx",
];

function resolveGateImport(from, specifier) {
  let base = null;
  if (specifier.startsWith("@/")) {
    base = path.join(root, "apps/web/src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(from), specifier);
  }
  if (base === null) {
    return null;
  }
  return (
    MODULE_SUFFIXES.map((suffix) => base + suffix).find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile()
    ) ?? null
  );
}

const GATE_ENTRY_FOLDERS = [
  "apps/web/scripts",
  "packages/db/scripts",
  "apps/web/worker",
  "apps/web/src/server",
  "apps/admin/src",
  "apps/catalog/src",
];

function gateEntryFiles() {
  return GATE_ENTRY_FOLDERS.flatMap((folder) =>
    readdirSync(path.join(root, folder), { recursive: true })
      .filter(
        (file) =>
          GATE_SCRIPT_FILE.test(file) &&
          (folder.endsWith("/scripts") ? !TEST_FILE.test(file) : true)
      )
      .map((file) => path.join(root, folder, file))
  );
}

/**
 * Non-server files of apps/web/src that `entries` import, directly or not. The entries are what the PostgreSQL job
 * runs: the gate scripts, and the Worker, server and `*.workerd-db.test.*` files its Worker gates load.
 */
function clientFilesReachedFrom(entries) {
  const queue = [...entries];
  const seen = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    if (!SOURCE_FILE.test(file)) {
      continue;
    }
    for (const match of readFileSync(file, "utf8").matchAll(GATE_IMPORT)) {
      const target = resolveGateImport(file, match[1] ?? match[2]);
      if (target !== null) {
        queue.push(target);
      }
    }
  }
  return [...seen]
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter(
      (file) =>
        file.startsWith("apps/web/src/") &&
        !file.startsWith("apps/web/src/server/") &&
        !TEST_FILE.test(file)
    )
    .sort();
}

function clientFilesReachedByGates() {
  return clientFilesReachedFrom(gateEntryFiles());
}

describe("which pull requests reach the PostgreSQL gates", () => {
  const RUNS = [
    "packages/db/src/media-repository.ts",
    "packages/db/drizzle/0051_x.sql",
    "packages/domain/src/money.ts",
    "apps/web/src/server/routes/media.ts",
    "apps/admin/src/server/billing.ts",
    "apps/catalog/src/server/routes.ts",
    "apps/web/worker/index.ts",
    "package.json",
    "bun.lock",
    ".github/workflows/ci.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ];
  const UNKNOWN = [
    "packages/observability/src/log.ts",
    "apps/web/scripts/verify-offline-e2e-gate.ts",
    "apps/web/src/offline/outbox/outbox.ts",
    "apps/web/src/lib/format.ts",
    "apps/web/src/home/home-inventory.ts",
    "apps/web/src/catalog/thumbnail-cache.ts",
    "apps/web/src/pwa/update-model.ts",
    "apps/web/e2e/x.e2e.ts",
    "apps/catalog/src/page.ts",
    "scripts/ci-changed.mjs",
    "wrangler.jsonc",
    "novo-arquivo-qualquer.txt",
  ];
  const SKIPS = [
    "docs/adr/0059-x.md",
    "doc/status-implementacao.md",
    "DESIGN.md",
    "apps/web/src/ui/button.tsx",
    "apps/web/src/screens/home/home-screen.tsx",
    "apps/web/src/home/home-page.tsx",
    "apps/web/src/styles/index.css",
  ];

  it.each(RUNS)("runs for %s", (file) => {
    expect(classifyChanges([file]).database).toBe(true);
    expect(classifyChanges(["docs/a.md", file]).database).toBe(true);
  });

  it.each(UNKNOWN)("runs for the unclassified path %s", (file) => {
    expect(classifyChanges([file]).database).toBe(true);
  });

  it.each(SKIPS)("skips for %s", (file) => {
    expect(classifyChanges([file]).database).toBe(false);
  });

  it("skips for a pull request of screen code only", () => {
    expect(classifyChanges(SKIPS).database).toBe(false);
  });

  it("runs when one path in the list is outside the skippable ones", () => {
    expect(
      classifyChanges([...SKIPS, "apps/web/src/server/x.ts"]).database
    ).toBe(true);
    expect(classifyChanges([...SKIPS, "outro/arquivo.sql"]).database).toBe(
      true
    );
  });

  it("does not let server/ hide behind a client-looking name", () => {
    expect(classifyChanges(["apps/web/src/serverless/x.ts"]).database).toBe(
      false
    );
    expect(classifyChanges(["apps/web/src/server/x.tsx"]).database).toBe(true);
    expect(classifyChanges(["apps/web/src/server.ts"]).database).toBe(false);
  });

  it("runs when the changed files are unknown", () => {
    expect(classifyChanges(null).database).toBe(true);
  });

  it("keeps every client file a PostgreSQL gate imports out of the skippable paths", () => {
    const reached = clientFilesReachedByGates();
    expect(reached.length).toBeGreaterThan(10);
    expect(
      reached.filter((file) => DATABASE_IRRELEVANT.some((p) => p.test(file)))
    ).toEqual([]);
    expect(reached).toContain("apps/web/src/offline/outbox/outbox.ts");
  });

  it("flags a screen file that a gate entry would start importing", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "ci-changed-"));
    const entry = path.join(folder, "entry.ts");
    writeFileSync(
      entry,
      'import { Button } from "@/ui/button";\nexport const x = Button;\n'
    );
    const reached = clientFilesReachedFrom([entry]);
    rmSync(folder, { recursive: true });
    expect(
      reached.filter((file) => DATABASE_IRRELEVANT.some((p) => p.test(file)))
    ).toEqual(["apps/web/src/ui/button.tsx"]);
  });
});

describe("which CI jobs a change affects", () => {
  it("treats bunfig.toml as a dependency change (the install policy lives there)", () => {
    expect(classifyChanges(["bunfig.toml"]).dependencies).toBe(true);
  });

  it("runs everything when the changed files are unknown", () => {
    expect(classifyChanges(null)).toEqual({
      browser: true,
      dependencies: true,
      e2e: true,
      database: true,
    });
  });

  it("skips the browser gate and the audit for prose only", () => {
    expect(
      classifyChanges([
        "docs/adr/0059-x.md",
        "doc/status-implementacao.md",
        "DESIGN.md",
        "",
      ])
    ).toEqual({
      browser: false,
      dependencies: false,
      e2e: false,
      database: false,
    });
  });

  it("skips the browser gate for the database package, whose code the web client never bundles", () => {
    expect(
      classifyChanges([
        "packages/db/src/media-repository.ts",
        "packages/db/scripts/verify-x-gate.ts",
        "packages/db/drizzle/0051_x.sql",
      ])
    ).toEqual({
      browser: false,
      dependencies: false,
      e2e: true,
      database: true,
    });
  });

  it("skips the browser gate for the web app's server, Worker and gate scripts, which it never runs", () => {
    expect(
      classifyChanges([
        "apps/web/src/server/routes/media.ts",
        "apps/web/src/server/media-reconciler.test.ts",
        "apps/web/worker/index.ts",
        "apps/web/scripts/verify-offline-e2e-gate.ts",
      ])
    ).toEqual({
      browser: false,
      dependencies: false,
      e2e: true,
      database: true,
    });
    // the client next to them is still covered
    expect(
      classifyChanges([
        "apps/web/src/server/routes/media.ts",
        "apps/web/src/lib/media-upload.ts",
      ]).browser
    ).toBe(true);
  });

  it("runs the browser gate when the web app, a shared package or the workflow changes", () => {
    for (const file of [
      "apps/web/src/catalog/product-media-panel.tsx",
      "packages/domain/src/billing/entitlements.ts",
      "packages/contracts/src/index.ts",
      ".github/workflows/ci.yml",
      "scripts/ci-changed.mjs",
    ]) {
      expect(classifyChanges(["docs/a.md", file]).browser).toBe(true);
    }
  });

  it("runs the audit when dependencies can change, wherever the manifest is", () => {
    for (const file of [
      "package.json",
      "bun.lock",
      "apps/web/package.json",
      "packages/db/package.json",
      ".bun-version",
      ".github/workflows/ci.yml",
    ]) {
      expect(classifyChanges([file]).dependencies).toBe(true);
    }
    expect(classifyChanges(["apps/web/src/x.ts"]).dependencies).toBe(false);
    expect(
      classifyChanges([".github/workflows/e2e-real.yml"]).dependencies
    ).toBe(false);
  });

  it("treats a lockfile change as relevant to the browser gate even next to database changes", () => {
    expect(
      classifyChanges(["packages/db/package.json", "bun.lock"]).browser
    ).toBe(true);
  });

  it("skips the browser gate for the Admin app, which neither the web client nor the catalog imports", () => {
    expect(
      classifyChanges([
        "apps/admin/src/app.ts",
        "apps/admin/src/app.test.ts",
        "apps/admin/wrangler.jsonc",
        "apps/admin/package.json",
      ])
    ).toEqual({
      browser: false,
      dependencies: true,
      e2e: false,
      database: true,
    });
    expect(classifyChanges(["apps/admin/src/app.ts"])).toEqual({
      browser: false,
      dependencies: false,
      e2e: false,
      database: true,
    });
  });

  it("keeps running the browser gate for what the Admin change does not cover", () => {
    // the sibling apps and the shared packages are still bundled by the gate
    for (const file of [
      "apps/web/src/lib/x.ts",
      "apps/catalog/src/x.ts",
      "packages/domain/src/x.ts",
      "apps/administrative/src/x.ts",
      "apps/admin-extra/src/x.ts",
      "bun.lock",
    ]) {
      expect(classifyChanges([file]).browser).toBe(true);
    }
  });

  it("runs the e2e journeys for the web app, its packages, the lockfile and the job, never for prose, the Admin or the catalog", () => {
    for (const file of [
      "apps/web/src/sales/sale-page.tsx",
      "apps/web/src/server/rpc/router.ts",
      "apps/web/worker/index.ts",
      "apps/web/e2e-real/jornadas/venda.e2e.ts",
      "apps/web/wrangler.jsonc",
      "packages/db/drizzle/0089_x.sql",
      "packages/contracts/src/index.ts",
      "packages/domain/src/money/money.ts",
      "bun.lock",
      ".node-version",
      ".github/workflows/ci.yml",
      "scripts/e2e-flaky-report.mjs",
    ]) {
      expect(classifyChanges(["docs/a.md", file]).e2e, file).toBe(true);
    }
    for (const file of [
      "docs/runbooks/e2e-real.md",
      "apps/web/e2e-real/README.md",
      "apps/admin/src/app.ts",
      "apps/catalog/src/x.ts",
      "doc/status-implementacao.md",
    ]) {
      expect(classifyChanges([file]).e2e, file).toBe(false);
    }
  });

  it("skips the browser gate for the operation scripts and the staging deploy workflow", () => {
    expect(OPERATIONS_FILES).toEqual(EXPECTED_OPERATIONS_FILES);
    for (const file of EXPECTED_OPERATIONS_FILES) {
      expect(classifyChanges(["docs/a.md", file]).browser, file).toBe(false);
      expect(classifyChanges([file]).browser, file).toBe(false);
    }
    expect(
      classifyChanges(EXPECTED_OPERATIONS_FILES).browser,
      "all together"
    ).toBe(false);
  });

  it("skips the browser gate for a change only in the neutral wrangler module, an operations verifier or a backup recipients file", () => {
    for (const file of [
      "scripts/lib/wrangler-config.mjs",
      "scripts/lib/wrangler-config.test.mjs",
      "scripts/verify-production-build.mjs",
      "scripts/verify-production-workflow.mjs",
      "scripts/verify-deployed-sha.mjs",
      "scripts/verify-backup-workflow.mjs",
      "scripts/verify-backup-workflow.test.mjs",
      "ops/backup/recipients-production.txt",
      "ops/backup/recipients-staging.txt",
    ]) {
      expect(classifyChanges([file]), file).toEqual({
        browser: false,
        dependencies: false,
        e2e: false,
        database: true,
      });
    }
  });

  it("keeps running the browser gate for what can change what it proves", () => {
    for (const file of [
      "scripts/generate-color-tokens.mjs",
      "scripts/generate-color-tokens.test.mjs",
      "scripts/ci-changed.mjs",
      "scripts/ci-changed.test.mjs",
      "scripts/workerd-harness.mjs",
      "scripts/workerd-harness.test.mjs",
      "scripts/verify-import-boundaries.mjs",
      "scripts/a-new-script.mjs",
      ".github/workflows/ci.yml",
      "scripts/smoke-staging.mjs.bak",
      "scripts/sub/smoke-staging.mjs",
    ]) {
      expect(classifyChanges(["docs/a.md", file]).browser, file).toBe(true);
    }
  });

  it("runs the browser gate when an operation script comes with a relevant change", () => {
    expect(
      classifyChanges(["scripts/smoke-staging.mjs", "apps/web/src/lib/x.ts"])
        .browser
    ).toBe(true);
  });

  it("leaves the e2e job as it was: the flaky report and the workflows still run it, the other operation scripts do not", () => {
    for (const file of [
      "scripts/e2e-flaky-report.mjs",
      ".github/workflows/deploy-staging.yml",
    ]) {
      expect(classifyChanges([file]).e2e, file).toBe(true);
    }
    for (const file of EXPECTED_OPERATIONS_FILES.filter(
      (name) =>
        name !== "scripts/e2e-flaky-report.mjs" &&
        name !== ".github/workflows/deploy-staging.yml"
    )) {
      expect(classifyChanges([file]).e2e, file).toBe(false);
    }
  });

  it("runs the browser gate when an Admin change comes with a relevant one", () => {
    expect(
      classifyChanges(["apps/admin/src/app.ts", "apps/web/src/lib/x.ts"])
        .browser
    ).toBe(true);
    expect(
      classifyChanges([
        "apps/admin/src/app.ts",
        "packages/db/src/x.ts",
        "docs/a.md",
      ]).browser
    ).toBe(false);
    expect(
      classifyChanges(["apps/admin/src/app.ts", "packages/ui/src/x.tsx"])
        .browser
    ).toBe(true);
  });
});

// The proof behind the apps/admin entry in BROWSER_IRRELEVANT: the browser gate
// builds apps/web and apps/catalog (and the packages they use), so skipping it
// for apps/admin is only sound while none of them reaches the Admin app. If this
// fails, remove the entry instead of weakening the test.
describe("the Admin app is outside the browser gate's import graph", () => {
  it("is imported by nothing in apps/web, apps/catalog or packages/", () => {
    expect(adminDependents()).toEqual([]);
  });

  it("is named by no tsconfig, Vite, Vitest, Playwright or wrangler config of those workspaces", () => {
    expect(adminConfigReferences()).toEqual([]);
  });

  it("recognises the ways an import can reach the Admin app", () => {
    const file = path.join(root, "apps/web/src/lib/x.ts");
    expect(importSpecifiers('import { a } from "@polaris/admin";')).toEqual([
      "@polaris/admin",
    ]);
    expect(importSpecifiers('export * from "../../../admin/src/app";')).toEqual(
      ["../../../admin/src/app"]
    );
    expect(
      importSpecifiers('const m = await import("@polaris/admin/x");')
    ).toEqual(["@polaris/admin/x"]);
    expect(importSpecifiers('import "../../admin/src/side-effect";')).toEqual([
      "../../admin/src/side-effect",
    ]);
    expect(importSpecifiers('require.resolve("@polaris/admin")')).toEqual([
      "@polaris/admin",
    ]);
    expect(importSpecifiers('vi.mock("../../../admin/src/app")')).toEqual([
      "../../../admin/src/app",
    ]);
    expect(ADMIN_TEXT.test('"paths": { "@a/*": ["../admin/src/*"] }')).toBe(
      true
    );
    expect(ADMIN_TEXT.test('"extends": "../../apps/admin/tsconfig.json"')).toBe(
      true
    );
    expect(ADMIN_TEXT.test('"../admin-extra/x"')).toBe(false);
    expect(reachesAdminApp(file, "@polaris/admin")).toBe(true);
    expect(reachesAdminApp(file, "@polaris/admin/src/app")).toBe(true);
    expect(reachesAdminApp(file, "../../../admin/src/app")).toBe(true);
    expect(reachesAdminApp(file, "../../../admin")).toBe(true);
    // the domain's own "admin/*" subpaths and sibling folders are not the app
    expect(reachesAdminApp(file, "@polaris/domain/admin/access-log")).toBe(
      false
    );
    expect(reachesAdminApp(file, "./admin/x")).toBe(false);
    expect(reachesAdminApp(file, "../../../admin-extra/x")).toBe(false);
  });
});

// The proof behind OPERATIONS_FILES: the gate builds apps/web and apps/catalog
// (and the packages they use) and runs the Playwright configs of apps/web, so
// skipping it for these files is only sound while none of those reaches them.
// If this fails, take the file out of OPERATIONS_FILES instead of weakening it.
describe("the operation scripts are outside the browser gate's import graph", () => {
  it("lists only files that exist (a renamed script must leave the list)", () => {
    for (const file of OPERATIONS_FILES) {
      expect(existsSync(path.join(root, file)), file).toBe(true);
    }
  });

  it("is reached by no source, config or manifest of apps/web, apps/catalog or packages/", () => {
    expect(operationsDependents(OPERATIONS_FILES)).toEqual([]);
  });

  it("lists every script, in any subfolder, that imports the neutral wrangler module", () => {
    const importers = sourceFiles(path.join(root, "scripts"))
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .filter((file) => importsWranglerModule(file, readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file).split(path.sep).join("/"));
    expect(importers.length).toBeGreaterThanOrEqual(7);
    expect(importers).toContain("scripts/lib/wrangler-config.test.mjs");
    for (const file of importers) {
      expect(OPERATIONS_FILES, file).toContain(file);
    }
  });

  it("recognises a relative import of the wrangler module in every form and folder", () => {
    const reaches = (file, source) =>
      importsWranglerModule(path.join(root, file), source);
    expect(
      reaches("scripts/a.mjs", 'import { x } from "./lib/wrangler-config.mjs";')
    ).toBe(true);
    expect(
      reaches("scripts/a.mjs", "import { x } from './lib/wrangler-config.mjs';")
    ).toBe(true);
    expect(
      reaches("scripts/a.mjs", 'export * from "./lib/wrangler-config.mjs";')
    ).toBe(true);
    expect(
      reaches(
        "scripts/sub/a.mjs",
        "const m = await import('../lib/wrangler-config.mjs');"
      )
    ).toBe(true);
    expect(reaches("scripts/lib/a.js", 'import("./wrangler-config.mjs")')).toBe(
      true
    );
    expect(
      reaches(
        "scripts/sub/deep/a.ts",
        "export { y } from '../../lib/wrangler-config.mjs'"
      )
    ).toBe(true);
    expect(
      reaches("scripts/sub/a.cjs", "require('../lib/wrangler-config.mjs')")
    ).toBe(true);
    // the same file name in another folder is another module
    expect(
      reaches("scripts/sub/a.mjs", 'import "./lib/wrangler-config.mjs"')
    ).toBe(false);
    expect(
      reaches("scripts/a.mjs", 'import "./other/lib/wrangler-config.mjs"')
    ).toBe(false);
    expect(reaches("scripts/a.mjs", 'import "wrangler-config.mjs"')).toBe(
      false
    );
  });

  it("does see the workerd harness, which the Vitest configs of apps/web import (so it stays out of the list)", () => {
    expect(OPERATIONS_FILES).not.toContain("scripts/workerd-harness.mjs");
    expect(operationsDependents(["scripts/workerd-harness.mjs"])).toContain(
      "apps/web/vitest.workers-db.config.ts -> scripts/workerd-harness.mjs"
    );
  });

  it("recognises the ways a file can name an operation script", () => {
    expect(
      namesByBareName(
        'spawn("bun", ["scripts/smoke-staging.mjs"])',
        "scripts/smoke-staging.mjs"
      )
    ).toBe(true);
    expect(
      namesByBareName(
        'join(root, ".github/workflows", "deploy-staging.yml")',
        ".github/workflows/deploy-staging.yml"
      )
    ).toBe(true);
    expect(
      namesByBareName("scripts/smoke.mjs", "scripts/smoke-staging.mjs")
    ).toBe(false);
    const file = path.join(root, "apps/web/playwright.x.config.ts");
    expect(
      resolvesTo(
        file,
        "../../scripts/smoke-staging.mjs",
        "scripts/smoke-staging.mjs"
      )
    ).toBe(true);
    expect(
      resolvesTo(
        file,
        "./scripts/smoke-staging.mjs",
        "scripts/smoke-staging.mjs"
      )
    ).toBe(false);
    expect(
      resolvesTo(file, "scripts/smoke-staging.mjs", "scripts/smoke-staging.mjs")
    ).toBe(false);
    expect(
      namesByRelativePath(
        'new URL("../../scripts/smoke-staging.mjs", import.meta.url)',
        "scripts/smoke-staging.mjs"
      )
    ).toBe(true);
    expect(
      namesByRelativePath(
        '"test": "node ../../scripts/gate5-real-devices.sh"',
        "scripts/gate5-real-devices.sh"
      )
    ).toBe(true);
    // the Worker scripts of apps/web have their own scripts/ folder
    expect(
      namesByRelativePath(
        'import "../scripts/serve-static.mjs"',
        "scripts/smoke-staging.mjs"
      )
    ).toBe(false);
    expect(
      namesByRelativePath(
        "run it with scripts/gate5-real-devices.sh",
        "scripts/gate5-real-devices.sh"
      )
    ).toBe(false);
  });
});

describe("the sentinel of reloads with the worker", () => {
  it("runs when the worker, its build, the first scripts of the page or the spec change, and when the paths are unknown", () => {
    for (const file of [
      "apps/web/src/pwa/sw.ts",
      "apps/web/src/pwa/register.ts",
      "apps/web/pwa/service-worker-plugin.ts",
      "apps/web/index.html",
      "apps/web/vite.config.ts",
      "apps/web/vite.pwa.config.ts",
      "apps/web/vite.ui.ts",
      "apps/web/public/boot-retry.js",
      "apps/web/public/theme-init.js",
      "apps/web/e2e-pwa/recarga-com-worker.e2e.ts",
    ]) {
      expect(reloadSentinelRuns(["docs/a.md", file]), file).toBe(true);
    }
    expect(reloadSentinelRuns(null)).toBe(true);
  });

  it("does not run for the rest of the app", () => {
    expect(
      reloadSentinelRuns([
        "apps/web/src/lib/theme.ts",
        "apps/web/public/manifest.webmanifest",
        "apps/web/e2e-pwa/boot-retry.e2e.ts",
        "apps/web/src/pwa-other/x.ts",
        "apps/web/vite.config.ts.bak",
        "apps/web/vite.offline.config.ts",
        "apps/web/vite.ui.tsx",
      ])
    ).toBe(false);
    expect(reloadSentinelRuns([])).toBe(false);
  });
});

describe("the full suite on demand", () => {
  it("is requested by every manual dispatch, even with `full` off, and by the label the workflow reports", () => {
    for (const CI_FULL of [undefined, "true", "false"]) {
      expect(
        fullSuiteRequested({ GITHUB_EVENT_NAME: "workflow_dispatch", CI_FULL })
      ).toBe(true);
    }
    expect(
      fullSuiteRequested({ GITHUB_EVENT_NAME: "pull_request", CI_FULL: "true" })
    ).toBe(true);
  });

  it("leaves pull requests and pushes as they were without the label", () => {
    expect(fullSuiteRequested({ GITHUB_EVENT_NAME: "pull_request" })).toBe(
      false
    );
    expect(
      fullSuiteRequested({ GITHUB_EVENT_NAME: "pull_request", CI_FULL: "" })
    ).toBe(false);
    expect(
      fullSuiteRequested({
        GITHUB_EVENT_NAME: "pull_request",
        CI_FULL: "false",
      })
    ).toBe(false);
    expect(fullSuiteRequested({ GITHUB_EVENT_NAME: "push" })).toBe(false);
    expect(fullSuiteRequested({})).toBe(false);
  });

  it("makes the script print every area as needed, whatever the commit changed", () => {
    const result = spawnSync("node", ["scripts/ci-changed.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: "pull_request",
        CI_FULL: "true",
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "browser=true",
      "dependencies=true",
      "e2e=true",
      "database=true",
      "reloads=true",
    ]);
  });
});
