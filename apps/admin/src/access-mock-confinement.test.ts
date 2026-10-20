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
  "outboundService",
];

/** The files that may name a marker: the test configuration and the tests. Nothing a deploy reads is here. */
const ALLOWED = [
  /^apps\/admin\/vitest\.workers(-db)?\.config\.ts$/,
  /^apps\/admin\/src\/workerd-access\.ts$/,
  /^apps\/admin\/src\/workerd(-db)?-env\.d\.ts$/,
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
const BYPASS_FLAG = /\b(BYPASS|SKIP_AUTH|DISABLE_AUTH|NO_AUTH)\w*/i;
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
      const worker = graph.get(join(adminSrc, "worker.ts")) ?? "";
      const app = graph.get(join(adminSrc, "app.ts")) ?? "";
      // the only Access inputs are the two the wrangler file names; nothing like a bypass flag exists
      expect(worker + app).not.toMatch(BYPASS_FLAG);
      expect(worker).toContain("verifyAccessJwt(");
    });
  });
});
