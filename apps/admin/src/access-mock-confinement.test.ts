import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The simulated Cloudflare Access (T-127a, D2 of the Admin plan) lives only in the test configuration. A
 * deployment of the Admin, in staging or in production, must not be able to load it: no deployed file names the
 * test key, the test team or the helper that signs tokens, and the Worker's own import graph reaches no test file.
 * The wrangler files and the workflows are checked by name as well, since they are what a deploy reads.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const adminSrc = join(root, "apps/admin/src");

/** What only the simulation has: the signing key and its id, the test teams, the signing helper, the stub network. */
const MARKERS = [
  "TEST_ACCESS_",
  "polaris-test.cloudflareaccess.com",
  "polaris-down.cloudflareaccess.com",
  "workerd-access",
  "signAccessToken",
  "TEST_FIXTURE",
  "POLARIS_ADMIN_WORKER_",
  "outboundService",
];
/** What the deployed bundle must not carry; the generic words are left out (a dependency may say "vitest" in a comment). */
const BUNDLE_MARKERS = [
  "TEST_ACCESS_",
  "TEST_FIXTURE",
  "cloudflare:test",
  "polaris-test.cloudflareaccess.com",
  "signAccessToken",
  "workerd-access",
];

/** The files that may name a marker: the test configuration and the tests. Nothing a deploy reads is here. */
const ALLOWED = [
  /^apps\/[\w-]+\/vitest\.workers(-db)?\.config\.ts$/,
  /^apps\/admin\/src\/workerd-access\.ts$/,
  /^apps\/admin\/src\/workerd(-db)?-env\.d\.ts$/,
  // the same bindings, typed for the page's end-to-end test (browser library, tsconfig.page-e2e.json)
  /^apps\/admin\/src\/page-e2e-env\.d\.ts$/,
  /^apps\/admin\/src\/[\w-]+\.workerd(-db)?\.test\.ts$/,
  /^apps\/admin\/src\/access-mock-confinement\.test\.ts$/,
  // the gate that makes the database fixtures names the test team (it writes the principals under its issuer)
  /^packages\/db\/scripts\/verify-admin-worker-gate\.ts$/,
  /^docs?\/.*\.md$/,
];
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  ".wrangler",
  "dist",
  "node_modules",
]);
const TEST_OR_SIMULATION_FILE = /\.test\.ts$|workerd/;
const BYPASS_FLAG =
  /\b(SKIP_?AUTH|DISABLE_?AUTH|NO_?AUTH|AUTH_?BYPASS|BYPASS_?AUTH|DEV_?AUTH)\w*/i;
const TEXT_FILE = /\.(c|m)?(j|t)sx?$|\.jsonc?$|\.ya?ml$|\.toml$|\.sh$|\.md$/;

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (TEXT_FILE.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** The files that name a marker and are not on the allow-list. */
function leaks(files: { path: string; text: string }[]): string[] {
  return files
    .filter(
      ({ path, text }) =>
        !ALLOWED.some((pattern) => pattern.test(path)) &&
        MARKERS.some((marker) => text.includes(marker))
    )
    .map(({ path }) => path);
}

const repository = walk(root).map((path) => ({
  path: relative(root, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

describe("the simulated Access stays in the test configuration", () => {
  it("is named by no file outside the test configuration and the tests", () => {
    expect(leaks(repository)).toEqual([]);
  });

  it("would catch a marker in a wrangler file, a workflow or the Worker (control case)", () => {
    for (const path of [
      "apps/admin/wrangler.jsonc",
      ".github/workflows/deploy-staging.yml",
      "apps/admin/src/worker.ts",
      "apps/admin/src/app.ts",
      // the exception for the page's end-to-end types is that exact file: a neighbour of its name is not excused
      "apps/admin/src/page-e2e-env.ts",
      "apps/admin/src/ui/page-e2e-env.d.ts",
      "apps/admin/ui/page-e2e-env.d.ts",
      "apps/admin/src/page-e2e-env.d.ts.bak",
    ]) {
      for (const marker of MARKERS) {
        expect(leaks([{ path, text: `x ${marker} y` }])).toEqual([path]);
      }
    }
  });

  it("knows the files that make up the simulation (a rename must not shrink the check)", () => {
    const paths = new Set(repository.map(({ path }) => path));
    for (const expected of [
      "apps/admin/vitest.workers.config.ts",
      "apps/admin/vitest.workers-db.config.ts",
      "apps/admin/src/workerd-access.ts",
      "apps/admin/src/worker.workerd.test.ts",
      "apps/admin/src/worker.workerd-db.test.ts",
      "apps/admin/src/page.workerd-db.test.ts",
      "apps/admin/src/page-e2e-env.d.ts",
    ]) {
      expect(paths.has(expected), expected).toBe(true);
    }
    // the scan sees the simulation where it lives: each marker is in at least one of those files
    for (const marker of MARKERS) {
      expect(
        repository.some(
          ({ path, text }) =>
            ALLOWED.some((pattern) => pattern.test(path)) &&
            text.includes(marker)
        ),
        marker
      ).toBe(true);
    }
  });

  it("has every wrangler file and workflow free of the markers, by name", () => {
    const deployed = repository.filter(
      ({ path }) =>
        path.endsWith("wrangler.jsonc") || path.startsWith(".github/workflows/")
    );
    expect(deployed.length).toBeGreaterThanOrEqual(4);
    for (const { path, text } of deployed) {
      for (const marker of MARKERS) {
        expect(text.includes(marker), `${path} names ${marker}`).toBe(false);
      }
    }
  });

  describe("the Worker's own import graph", () => {
    const IMPORT = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

    function graphOf(entry: string): Map<string, string> {
      const seen = new Map<string, string>();
      const pending = [entry];
      while (pending.length > 0) {
        const file = pending.pop() as string;
        if (seen.has(file)) {
          continue;
        }
        const text = readFileSync(file, "utf8");
        seen.set(file, text);
        for (const [, specifier] of text.matchAll(IMPORT)) {
          const target = resolve(dirname(file), specifier as string);
          // the page's script and sheet are Text modules, not code the Worker runs (src/ui/ui-guard.test.ts reads them)
          if (target.endsWith(".txt")) {
            continue;
          }
          pending.push(target.endsWith(".ts") ? target : `${target}.ts`);
        }
      }
      return seen;
    }

    const graph = graphOf(join(adminSrc, "worker.ts"));

    it("reaches the routes (the walk is not empty)", () => {
      const names = [...graph.keys()].map((file) => relative(adminSrc, file));
      expect(names).toEqual(
        expect.arrayContaining(["worker.ts", "app.ts", "access-jwt.ts"])
      );
    });

    it("reaches no test file, no simulation helper and no test runtime", () => {
      for (const [file, text] of graph) {
        const name = relative(adminSrc, file);
        expect(name).not.toMatch(TEST_OR_SIMULATION_FILE);
        for (const forbidden of [
          "vitest",
          "cloudflare:test",
          "cloudflare:workers",
          "workerd-access",
          ...MARKERS,
        ]) {
          expect(text.includes(forbidden), `${name} names ${forbidden}`).toBe(
            false
          );
        }
      }
    });

    it("reads no variable that skips the verification of the token", () => {
      // the only Access inputs are the two the wrangler file names; nothing like a bypass flag exists
      for (const [file, text] of graph) {
        expect(text, relative(adminSrc, file)).not.toMatch(BYPASS_FLAG);
      }
      expect(graph.get(join(adminSrc, "worker.ts"))).toContain(
        "verifyAccessJwt("
      );
    });
  });

  describe("the deployable artifact and the app directory", () => {
    const dist = join(root, "apps/admin/dist");
    let built: string[] = [];
    try {
      built = readdirSync(dist).filter((name) => name.endsWith(".js"));
    } catch {
      // not built yet: `bun run build` runs before the tests in CI, and the check then has a bundle to read
    }

    it.skipIf(built.length === 0)(
      "has a bundle (made by `wrangler deploy --dry-run`) without the simulation",
      () => {
        for (const name of built) {
          const text = readFileSync(join(dist, name), "utf8");
          for (const marker of BUNDLE_MARKERS) {
            expect(text.includes(marker), `${name} carries ${marker}`).toBe(
              false
            );
          }
        }
      }
    );

    it("has no local variables file that a deploy or a local run could read", () => {
      const variableFiles = readdirSync(join(root, "apps/admin")).filter(
        (name) => name.startsWith(".dev.vars") || name.startsWith(".env")
      );
      expect(variableFiles).toEqual([]);
    });
  });
});
