import { spawnSync } from "node:child_process";
import { readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const biome = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.exe" : "biome"
);

const domainMessage =
  "packages/domain must stay framework- and infrastructure-independent.";
const contractsMessage =
  "packages/contracts must not import database or driver implementation.";
const dbMessage =
  "packages/db must not depend on the web app, the UI or the HTTP layer.";
const catalogMessage =
  "The public catalog must not import tenant data, billing, auth or a database driver: it reads only through the public catalog reader.";
const adminMessage =
  "The Admin app must not import tenant data, billing, auth or a database driver: it reaches the database only through its own repositories.";
const browserMessage =
  "Browser code must not import the database, the server layer or server-only libraries.";

const forbiddenImport = (specifier, extra = "") =>
  `import ${extra}${JSON.stringify(specifier)};\nexport const forbiddenImport = 1;\n`;

const cases = [
  ["react", ["packages", "domain", "src"], domainMessage],
  ["hono", ["packages", "domain", "src"], domainMessage],
  ["drizzle-orm/pg-core", ["packages", "domain", "src"], domainMessage],
  ["@orpc/server", ["packages", "domain", "src"], domainMessage],
  ["cloudflare:workers", ["packages", "domain", "src"], domainMessage],
  ["better-auth", ["packages", "domain", "src"], domainMessage],
  ["@polaris/db/client", ["packages", "domain", "src"], domainMessage],
  ["evlog", ["packages", "domain", "src"], domainMessage],
  ["evlog/workers", ["packages", "domain", "src"], domainMessage],
  [
    "@polaris/observability/logger",
    ["packages", "domain", "src"],
    domainMessage,
  ],
  [
    "../../observability/src/logger",
    ["packages", "domain", "src"],
    domainMessage,
  ],
  [
    "../../../observability/src/logger",
    ["packages", "domain", "src", "events"],
    domainMessage,
  ],
  [
    "../../../../packages/observability/src/logger",
    ["packages", "domain", "src", "events"],
    domainMessage,
  ],
  ["@polaris/db", ["packages", "contracts", "src"], contractsMessage],
  ["drizzle-orm", ["packages", "contracts", "src"], contractsMessage],
  ["pg", ["packages", "contracts", "src"], contractsMessage],
  ["react", ["packages", "db", "src"], dbMessage],
  ["hono", ["packages", "db", "src"], dbMessage],
  ["@orpc/server", ["packages", "db", "src"], dbMessage],
  ["@polaris/db/client", ["apps", "web", "src", "lib"], browserMessage],
  ["drizzle-orm", ["apps", "web", "src", "sales"], browserMessage],
  ["better-auth", ["apps", "web", "src", "catalog"], browserMessage],
  ["../server/app", ["apps", "web", "src", "lib"], browserMessage],
  ["evlog", ["apps", "web", "src", "lib"], browserMessage],
  [
    "@polaris/observability/logger",
    ["apps", "web", "src", "lib"],
    browserMessage,
  ],
  ["@polaris/db/client", ["apps", "catalog", "src"], catalogMessage],
  [
    "@polaris/db/tenant-transaction",
    ["apps", "catalog", "src"],
    catalogMessage,
  ],
  ["@polaris/billing", ["apps", "catalog", "src"], catalogMessage],
  ["better-auth", ["apps", "catalog", "src"], catalogMessage],
  ["pg", ["apps", "catalog", "src"], catalogMessage],
  ["@polaris/db/client", ["apps", "admin", "src"], adminMessage],
  ["@polaris/db/tenant-transaction", ["apps", "admin", "src"], adminMessage],
  [
    "@polaris/db/public-catalog-repository",
    ["apps", "admin", "src"],
    adminMessage,
  ],
  ["@polaris/billing", ["apps", "admin", "src"], adminMessage],
  ["better-auth", ["apps", "admin", "src"], adminMessage],
  ["pg", ["apps", "admin", "src"], adminMessage],
].map(([specifier, workspace, expected]) => ({
  expected,
  source: forbiddenImport(specifier),
  specifier,
  workspace,
}));

const fixturePrefix = "__boundary_fixture_";

// A crashed run can leave a fixture behind and break the next typecheck, so
// every run first sweeps stale fixtures out of the folders it writes to.
async function sweep() {
  const folders = new Set(
    cases.map((testCase) => path.join(root, ...testCase.workspace))
  );
  for (const folder of folders) {
    // biome-ignore lint/performance/noAwaitInLoops: a handful of folders, swept one at a time
    const names = await readdir(folder).catch(() => []);
    for (const name of names) {
      if (name.startsWith(fixturePrefix)) {
        // biome-ignore lint/performance/noAwaitInLoops: stale fixtures are removed one at a time
        await unlink(path.join(folder, name)).catch(() => undefined);
      }
    }
  }
}

await sweep();

// Sequential on purpose: parallel fixtures race with builds and typechecks.
let index = 0;
for (const testCase of cases) {
  index += 1;
  const fixture = path.join(
    root,
    ...testCase.workspace,
    `${fixturePrefix}${index}.ts`
  );

  try {
    // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose (see above)
    await writeFile(fixture, testCase.source, { flag: "wx" });

    const result = spawnSync(biome, ["lint", path.relative(root, fixture)], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");

    if (result.error) {
      throw result.error;
    }

    if (result.status === 0 || !output.includes(testCase.expected)) {
      throw new Error(
        `Biome did not reject the forbidden import of "${testCase.specifier}" in ` +
          `${path.relative(root, fixture)}: ${output}`
      );
    }
  } finally {
    await unlink(fixture).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}
console.log(
  `Import boundary rules reject all ${cases.length} prohibited fixtures.`
);
