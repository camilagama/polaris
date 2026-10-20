import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Better Auth's `testUtils` (which mints sessions without a sign-in) and the e2e harness live only in the test
 * configuration (T-125a): the Worker's import graph never reaches them, the deployed bundle does not carry them, and
 * nothing a deploy reads (wrangler.jsonc environments, workflows) names the e2e variables. Control cases prove
 * that each check would catch a leak.
 */
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");

const IMPORT_MARKERS = [/\btestUtils\b/, /better-auth\/plugins(?!\/)/, /e2e-real\//, /@playwright\/test/];
const BUNDLE_MARKERS = ['"test-utils"', "createTestCookie", "E2E_RUN_SECRET", "e2e-real/"];
const E2E_VARIABLES = /\bE2E_(RUN_ID|RUN_SECRET|LOGIN_PASSWORD_\w+|T0)\b|POLARIS_E2E_DATABASE_URL/;
const importPattern = /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** The local files the given entry imports, transitively (relative imports; packages are checked by marker). */
export function importGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string) => {
    if (seen.has(file)) {
      return;
    }
    const source = readFileSync(file, "utf8");
    seen.set(file, source);
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? "";
      if (!specifier.startsWith(".")) {
        continue;
      }
      const base = resolve(dirname(file), specifier);
      const candidate = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(
        (path) => existsSync(path) && !path.endsWith("/") && readdirSafe(path) === null
      );
      if (candidate) {
        visit(candidate);
      }
    }
  };
  visit(entry);
  return seen;
}

function readdirSafe(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

/** The files of a graph that name a test-only import, or a specifier that is one. */
export function leaks(graph: Map<string, string>): string[] {
  const found: string[] = [];
  for (const [file, source] of graph) {
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? "";
      if (IMPORT_MARKERS.some((marker) => marker.test(specifier))) {
        found.push(`${relative(repositoryRoot, file)}: ${specifier}`);
      }
    }
    if (/\btestUtils\s*\(/.test(source)) {
      found.push(`${relative(repositoryRoot, file)}: testUtils()`);
    }
  }
  return found;
}

export function bundleLeaks(source: string): string[] {
  return BUNDLE_MARKERS.filter((marker) => source.includes(marker));
}

/** Names of the e2e variables in what a deploy reads: the wrangler environments and the workflows. */
export function deployLeaks(wranglerSource: string, workflows: string[]): string[] {
  const found: string[] = [];
  const environments = wranglerSource.slice(wranglerSource.indexOf('"env"'));
  if (E2E_VARIABLES.test(environments)) {
    found.push("wrangler.jsonc env");
  }
  if (/\btestUtils\b|test-utils/.test(wranglerSource)) {
    found.push("wrangler.jsonc testUtils");
  }
  for (const workflow of workflows) {
    if (/E2E_RUN_SECRET|E2E_LOGIN_PASSWORD/.test(workflow)) {
      found.push("workflow");
    }
  }
  return found;
}

function workerBundles(): string[] {
  const bundles: string[] = [];
  const add = (directory: string) => {
    for (const entry of readdirSafe(directory) ?? []) {
      const path = join(directory, entry);
      if (entry.endsWith(".js")) {
        bundles.push(path);
      } else if (readdirSafe(path) !== null) {
        add(path);
      }
    }
  };
  add(join(appRoot, "dist/polaris_web_local"));
  for (const project of readdirSafe(join(appRoot, "dist-e2e")) ?? []) {
    add(join(appRoot, "dist-e2e", project, "polaris_web_local"));
  }
  return bundles;
}

describe("testUtils and the e2e harness stay out of the deployed Worker", () => {
  it("the Worker's import graph reaches no test-only module", () => {
    const graph = importGraph(join(appRoot, "worker/index.ts"));
    expect(graph.size).toBeGreaterThan(50);
    expect(leaks(graph)).toEqual([]);
  });

  it("no server file outside the tests imports testUtils, the harness or Playwright", () => {
    const found: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|test-cases\.ts$|test-support\.ts$/.test(entry.name)) {
          found.push(...leaks(new Map([[path, readFileSync(path, "utf8")]])));
        }
      }
    };
    walk(join(appRoot, "src/server"));
    expect(found).toEqual([]);
  });

  it("the Better Auth handler passes no plugin of its own", () => {
    expect(readFileSync(join(appRoot, "src/server/auth/handler.ts"), "utf8")).not.toMatch(/\bplugins\s*:/);
  });

  it("the bundles of the Worker, when built, carry no marker of testUtils or of the harness", () => {
    for (const bundle of workerBundles()) {
      expect(bundleLeaks(readFileSync(bundle, "utf8")), relative(appRoot, bundle)).toEqual([]);
    }
  });

  it("the environments of wrangler.jsonc and the workflows do not name the e2e variables", () => {
    const workflows = join(repositoryRoot, ".github/workflows");
    expect(
      deployLeaks(
        readFileSync(join(appRoot, "wrangler.jsonc"), "utf8"),
        (readdirSafe(workflows) ?? []).map((file) => readFileSync(join(workflows, file), "utf8"))
      )
    ).toEqual([]);
  });

  it("the e2e build uses the top level of wrangler.jsonc, never an environment", () => {
    for (const project of readdirSafe(join(appRoot, "dist-e2e")) ?? []) {
      const generated = join(appRoot, "dist-e2e", project, "polaris_web_local/wrangler.json");
      if (existsSync(generated)) {
        const config = JSON.parse(readFileSync(generated, "utf8")) as { name: string; targetEnvironment?: string };
        expect(config.name, project).toBe("polaris-web-local");
        expect(config.targetEnvironment, project).toBeUndefined();
      }
    }
    expect(readFileSync(join(appRoot, "e2e-real/run-environment.ts"), "utf8")).not.toMatch(/CLOUDFLARE_ENV\s*[:=]/);
  });

  describe("control cases: each check catches a leak", () => {
    it("in the Worker's imports", () => {
      const directory = mkdtempSync(join(tmpdir(), "e2e-confinement-"));
      try {
        writeFileSync(join(directory, "index.ts"), 'import { app } from "./app";\nexport default app;\n');
        writeFileSync(join(directory, "app.ts"), 'import { testUtils } from "better-auth/plugins";\nexport const app = testUtils();\n');
        expect(leaks(importGraph(join(directory, "index.ts")))).toHaveLength(2);
        writeFileSync(join(directory, "app.ts"), 'import { openJourney } from "../e2e-real/fixtures";\nexport const app = openJourney;\n');
        expect(leaks(importGraph(join(directory, "index.ts")))).toHaveLength(1);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    });

    it("in a wrangler.jsonc and a workflow", () => {
      const wrangler = '{ "name": "x", "env": { "staging": { "vars": { "E2E_RUN_SECRET": "x" } } } }';
      expect(deployLeaks(wrangler, [])).toEqual(["wrangler.jsonc env"]);
      expect(deployLeaks('{ "name": "x", "env": {} }', ["env:\n  E2E_LOGIN_PASSWORD_HYPERDRIVE: x"])).toEqual(["workflow"]);
    });

    it("in a bundle", () => {
      expect(bundleLeaks('var p={id:"test-utils",init(){}};')).toEqual(['"test-utils"']);
    });
  });
});
