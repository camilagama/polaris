import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the Workers tests with a database add (T-121b: the Web and the Catalog Workers) lives only in the test
 * configuration: the fixture bindings, the variables the gates hand over, the test origin, the `cloudflare:test`
 * helpers. A deployment of either Worker, in staging or in production, must not be able to load any of it: no
 * deployed file names it, and the import graph of each Worker reaches no test file and no test runtime. The wrangler
 * files and the workflows are checked by name as well, since they are what a deploy reads. Same idea as the check of
 * the simulated Access of the Admin (apps/admin/src/access-mock-confinement.test.ts).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What only the simulation has. */
const MARKERS = [
  "TEST_WEB_FIXTURE",
  "TEST_CATALOG_FIXTURE",
  "POLARIS_WEB_WORKER_",
  "POLARIS_CATALOG_WORKER_",
  "https://catalogo.test",
  "no network in the harness",
];
/** What the deployed bundle must not carry; the generic words are left out (a dependency may say "vitest" in a comment). */
const BUNDLE_MARKERS = [
  "TEST_WEB_FIXTURE",
  "TEST_CATALOG_FIXTURE",
  "cloudflare:test",
  "https://catalogo.test",
];
/** The test runtimes a Worker must not import. */
const FORBIDDEN_SPECIFIERS = [
  /^vitest(\/|$)/,
  /^cloudflare:test$/,
  /^@cloudflare\/vitest-plugin/,
];

/** The files that may name a marker: the test configuration, the tests, the gates that feed them, the docs. */
const ALLOWED = [
  /^apps\/(admin|web|catalog)\/vitest\.workers(-db)?\.config\.ts$/,
  /^apps\/web\/worker\/index\.workerd-db\.test\.ts$/,
  /^apps\/web\/worker\/workerd-db-env\.d\.ts$/,
  /^apps\/catalog\/src\/server\/[\w-]+\.workerd-db\.test\.ts$/,
  /^apps\/catalog\/src\/workerd-db-env\.d\.ts$/,
  /^vitest\.(web|catalog)-worker\.config\.ts$/,
  /^packages\/db\/scripts\/verify-(web|catalog)-worker-gate\.ts$/,
  /^scripts\/workerd-db-confinement\.test\.mjs$/,
  /^docs?\/.*\.md$/,
];
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  ".wrangler",
  "dist",
  "dist-bare",
  "node_modules",
]);
const TEXT_FILE = /\.(c|m)?(j|t)sx?$|\.jsonc?$|\.ya?ml$|\.toml$|\.sh$|\.md$/;
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function walk(directory) {
  const found = [];
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
function leaks(files) {
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

/** Every file a Worker reaches through relative imports, and every module specifier it names. */
function graphOf(entry) {
  const files = new Map();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    const specifiers = [...text.matchAll(IMPORT)].map(
      ([, specifier]) => specifier
    );
    files.set(file, { specifiers, text });
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const base = resolve(dirname(file), specifier);
      const target = EXTENSIONS.map((extension) => `${base}${extension}`).find(
        (candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate)
      );
      if (target) {
        pending.push(target);
      }
    }
  }
  return files;
}

const WORKERS = [
  {
    app: "web",
    entries: ["apps/web/worker/index.ts"],
    needs: ["index.ts", "app.ts"],
  },
  {
    app: "catalog",
    entries: [
      "apps/catalog/src/server.ts",
      "apps/catalog/src/server/catalog.ts",
      "apps/catalog/src/server/media.ts",
    ],
    needs: ["server.ts", "catalog.ts", "media.ts", "security.ts"],
  },
];

describe("the Workers test fixtures stay in the test configuration", () => {
  it("is named by no file outside the test configuration, the tests and the gates", () => {
    expect(leaks(repository)).toEqual([]);
  });

  it("would catch a marker in a wrangler file, a workflow or a Worker (control case)", () => {
    for (const path of [
      "apps/web/wrangler.jsonc",
      "apps/catalog/wrangler.jsonc",
      ".github/workflows/deploy-staging.yml",
      "apps/web/worker/index.ts",
      "apps/web/src/server/app.ts",
      "apps/catalog/src/server.ts",
      "apps/catalog/src/server/catalog.ts",
    ]) {
      for (const marker of MARKERS) {
        expect(leaks([{ path, text: `x ${marker} y` }])).toEqual([path]);
      }
    }
  });

  it("knows the files that make up the simulation (a rename must not shrink the check)", () => {
    const paths = new Set(repository.map(({ path }) => path));
    for (const expected of [
      "apps/web/vitest.workers-db.config.ts",
      "apps/web/worker/index.workerd-db.test.ts",
      "apps/web/worker/workerd-db-env.d.ts",
      "apps/catalog/vitest.workers-db.config.ts",
      "apps/catalog/src/server/catalog.workerd-db.test.ts",
      "apps/catalog/src/workerd-db-env.d.ts",
      "vitest.web-worker.config.ts",
      "vitest.catalog-worker.config.ts",
      "packages/db/scripts/verify-web-worker-gate.ts",
      "packages/db/scripts/verify-catalog-worker-gate.ts",
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

  describe.each(WORKERS)(
    "the import graph of the $app Worker",
    ({ app, entries, needs }) => {
      const graph = new Map();
      for (const entry of entries) {
        for (const [file, content] of graphOf(join(root, entry))) {
          graph.set(file, content);
        }
      }

      it("reaches the Worker's own code (the walk is not empty)", () => {
        const names = [...graph.keys()].map((file) => file.split("/").pop());
        expect(names).toEqual(expect.arrayContaining(needs));
        expect(graph.size).toBeGreaterThan(needs.length);
      });

      it("reaches no test file, no test declaration and no test runtime", () => {
        for (const [file, { specifiers, text }] of graph) {
          const name = relative(root, file);
          expect(name).not.toMatch(/\.test\.|workerd-db|workerd\.test/);
          for (const specifier of specifiers) {
            for (const forbidden of FORBIDDEN_SPECIFIERS) {
              expect(specifier, `${name} imports ${specifier}`).not.toMatch(
                forbidden
              );
            }
          }
          for (const marker of MARKERS) {
            expect(text.includes(marker), `${name} names ${marker}`).toBe(
              false
            );
          }
        }
        expect(app).toBeTruthy();
      });
    }
  );

  describe("the deployable artifacts and the app directories", () => {
    for (const app of ["web", "catalog"]) {
      const dist = join(root, "apps", app, "dist");
      const built = existsSync(dist)
        ? walk(dist).filter((path) => /\.(c|m)?js$/.test(path))
        : [];
      // not built yet: `bun run build` runs before the tests in CI, and the check then has a bundle to read
      it.skipIf(built.length === 0)(
        `has a ${app} build without the simulation`,
        () => {
          for (const path of built) {
            const text = readFileSync(path, "utf8");
            for (const marker of BUNDLE_MARKERS) {
              expect(
                text.includes(marker),
                `${relative(root, path)} carries ${marker}`
              ).toBe(false);
            }
          }
        }
      );

      it(`has no local variables file in apps/${app} that a deploy or a local run could read`, () => {
        const variableFiles = readdirSync(join(root, "apps", app)).filter(
          (name) => name.startsWith(".dev.vars") || name.startsWith(".env")
        );
        expect(variableFiles).toEqual([]);
      });
    }
  });
});
