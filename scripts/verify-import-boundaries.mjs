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
    "@polaris/observability/wide-event",
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

// Server code logs through @polaris/observability (ADR 0089): a direct `console.*` skips the redaction
// policy, so `noConsole` must reject a new one in every server folder and leave CLI scripts and tests alone.
const consoleSource = 'console.log("boundary fixture");\n';
const consoleRejected = [
  ["apps", "web", "src", "server"],
  ["apps", "web", "src", "server", "queue"],
  ["apps", "web", "worker"],
  ["apps", "admin", "src"],
  ["apps", "catalog", "src", "server"],
  ["apps", "catalog", "src"],
  ["packages", "db", "src"],
  ["packages", "billing", "src"],
  ["packages", "domain", "src"],
  ["packages", "observability", "src"],
].map((workspace) => ({
  allowed: false,
  expected: "noConsole",
  file: ".ts",
  source: consoleSource,
  specifier: "console.log",
  workspace,
}));
const consoleAllowed = [
  [["apps", "web", "scripts"], ".ts"],
  [["packages", "db", "scripts"], ".ts"],
  [["apps", "web", "src", "server"], ".test.ts"],
  [["packages", "observability", "src"], ".test.ts"],
  [["packages", "ui", "src"], ".ts"],
].map(([workspace, file]) => ({
  allowed: true,
  expected: "noConsole",
  file,
  source: consoleSource,
  specifier: "console.log",
  workspace,
}));
// evlog runs with its own masking off, so only packages/observability may import it.
const evlogMessage =
  "Server code logs through @polaris/observability: evlog directly would skip the redaction policy (ADR 0089).";
const evlogCase = (workspace, allowed) => ({
  allowed,
  expected: evlogMessage,
  source: forbiddenImport("evlog"),
  specifier: "evlog",
  workspace,
});
const evlogRejected = [
  ["apps", "web", "src", "server"],
  ["apps", "web", "worker"],
  ["apps", "admin", "src"],
  ["apps", "catalog", "src"],
  ["packages", "db", "src"],
  ["packages", "billing", "src"],
  ["packages", "http-security", "src"],
].map((workspace) => evlogCase(workspace, false));
cases.push(
  ...consoleRejected,
  ...consoleAllowed,
  ...evlogRejected,
  evlogCase(["packages", "observability", "src"], true)
);

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

// One Biome run over every fixture (a run per fixture paid the config load and the project scan 60
// times). The fixtures sit at their real paths, not in a temp folder, because the boundary rules are
// `overrides` keyed on repo paths such as packages/domain/**; they live only while that single run
// takes, so a build or typecheck racing with them is as unlikely as before.
const fixtures = cases.map((testCase, position) => ({
  ...testCase,
  path: path.join(
    root,
    ...testCase.workspace,
    `${fixturePrefix}${position + 1}${testCase.file ?? ".ts"}`
  ),
}));

/** Biome's diagnostics grouped by repo-relative file: "category message" and whether it is an error. */
function lintAll(files) {
  const result = spawnSync(
    biome,
    ["lint", "--reporter=json", "--max-diagnostics=none", ...files],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    }
  );
  if (result.error) {
    throw result.error;
  }
  const json = result.stdout.slice(result.stdout.indexOf("{"));
  let report;
  try {
    report = JSON.parse(json);
  } catch {
    throw new Error(
      `Biome did not print a JSON report: ${result.stdout}${result.stderr}`
    );
  }
  const byFile = new Map(files.map((file) => [file, []]));
  for (const diagnostic of report.diagnostics) {
    byFile.get(diagnostic.location?.path)?.push({
      error: diagnostic.severity === "error",
      text: `${diagnostic.category} ${diagnostic.message}`,
    });
  }
  return byFile;
}

try {
  await Promise.all(
    fixtures.map((fixture) =>
      writeFile(fixture.path, fixture.source, { flag: "wx" })
    )
  );

  const relativePaths = fixtures.map((fixture) =>
    path.relative(root, fixture.path)
  );
  const diagnostics = lintAll(relativePaths);

  for (const fixture of fixtures) {
    const relative = path.relative(root, fixture.path);
    const lines = diagnostics.get(relative);
    const output = lines.map((line) => line.text).join("\n");

    // Every fixture breaks the file-name rule (the `__` prefix), so a file with no diagnostic at all
    // was not linted (ignored, or dropped from the run) and its "allowed" verdict would be vacuous.
    if (lines.length === 0) {
      throw new Error(
        `Biome reported nothing for ${relative}: it was not linted.`
      );
    }

    if (fixture.allowed) {
      if (output.includes(fixture.expected)) {
        throw new Error(
          `Biome rejected "${fixture.specifier}" in ${relative}, ` +
            `where it is allowed: ${output}`
        );
      }
    } else if (
      !lines.some((line) => line.error && line.text.includes(fixture.expected))
    ) {
      throw new Error(
        `Biome did not reject the forbidden "${fixture.specifier}" in ` +
          `${relative}: ${output}`
      );
    }
  }
} finally {
  await Promise.all(
    fixtures.map((fixture) =>
      unlink(fixture.path).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      })
    )
  );
}
console.log(
  `Boundary rules behave as expected on all ${cases.length} fixtures (prohibited imports, evlog outside the logger and console calls rejected; the allowed exceptions left alone).`
);
