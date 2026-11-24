import { spawnSync } from "node:child_process";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
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
const uiMessage =
  "packages/ui must stay framework-free: the Admin page has no React, and the dash's components live in apps/web/src/ui.";
const browserMessage =
  "Browser code must not import the database, the server layer or server-only libraries.";
const uiPieceMessage = "A piece of ui/ imports neither a screen nor app-shell";

// Biome's category for each kind of case: the run checks the rule and the message of every
// diagnostic, so a different rule that happens to print the same text cannot satisfy a fixture.
const importRule = "lint/style/noRestrictedImports";
const consoleRule = "lint/suspicious/noConsole";

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
  ["react", ["packages", "ui", "src"], uiMessage],
  ["react/jsx-runtime", ["packages", "ui", "src"], uiMessage],
  ["react-dom", ["packages", "ui", "src"], uiMessage],
  ["react-dom/client", ["packages", "ui", "src"], uiMessage],
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
  ["@/app-shell/screen-tabs", ["apps", "web", "src", "ui"], uiPieceMessage],
  ["../app-shell/screen-tabs", ["apps", "web", "src", "ui"], uiPieceMessage],
  ["@/sales/sale-page", ["apps", "web", "src", "ui"], uiPieceMessage],
  ["../sales/sale-page", ["apps", "web", "src", "ui"], uiPieceMessage],
  [
    "../../sales/sale-page",
    ["apps", "web", "src", "ui", "charts"],
    uiPieceMessage,
  ],
  [
    "../../app-shell/screen-tabs",
    ["apps", "web", "src", "ui", "charts"],
    uiPieceMessage,
  ],
  ["@polaris/db/client", ["apps", "web", "src", "ui"], browserMessage],
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
  // the operator's commands are the only door to billing (ADR 0105): never a webhook, its signature or a client
  ["@polaris/billing/asaas/webhook", ["apps", "admin", "src"], adminMessage],
  ["@polaris/billing/woovi/webhook", ["apps", "admin", "src"], adminMessage],
  ["@polaris/billing/woovi/signature", ["apps", "admin", "src"], adminMessage],
  ["@polaris/billing/asaas/client", ["apps", "admin", "src"], adminMessage],
  ["better-auth", ["apps", "admin", "src"], adminMessage],
  ["pg", ["apps", "admin", "src"], adminMessage],
].map(([specifier, workspace, expected]) => ({
  expected,
  rule: importRule,
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
  expected: "Don't use console.",
  file: ".ts",
  rule: consoleRule,
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
  expected: "Don't use console.",
  file,
  rule: consoleRule,
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
  rule: importRule,
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
// Controls: a harmless import in the same restricted folders, linted in the same run as the forbidden
// ones. The rule must stay silent on it, or "rejected" above would only mean "flags every file".
const controlImport = (workspace, expected) => ({
  allowed: true,
  expected,
  rule: importRule,
  source: forbiddenImport("./neighbour-module"),
  specifier: "./neighbour-module",
  workspace,
});
const importControls = [
  controlImport(["packages", "domain", "src"], domainMessage),
  controlImport(["packages", "contracts", "src"], contractsMessage),
  controlImport(["packages", "db", "src"], dbMessage),
  controlImport(["packages", "ui", "src"], uiMessage),
  controlImport(["apps", "web", "src", "lib"], browserMessage),
  controlImport(["apps", "web", "src", "ui"], uiPieceMessage),
  controlImport(["apps", "catalog", "src"], catalogMessage),
  controlImport(["apps", "admin", "src"], adminMessage),
  ...[
    ["@/lib/utils", ["apps", "web", "src", "ui"]],
    ["@/ui/block", ["apps", "web", "src", "ui"]],
    ["../money", ["apps", "web", "src", "ui", "charts"]],
    ["../../lib/utils", ["apps", "web", "src", "ui", "charts"]],
  ].map(([specifier, workspace]) => ({
    allowed: true,
    expected: uiPieceMessage,
    rule: importRule,
    source: forbiddenImport(specifier),
    specifier,
    workspace,
  })),
  // the one door the Admin has to billing must stay open, or the rejections above would only mean "all of billing"
  {
    allowed: true,
    expected: adminMessage,
    rule: importRule,
    source: forbiddenImport("@polaris/billing/operator-commands"),
    specifier: "@polaris/billing/operator-commands",
    workspace: ["apps", "admin", "src"],
  },
];
cases.push(
  ...importControls,
  ...consoleRejected,
  ...consoleAllowed,
  ...evlogRejected,
  evlogCase(["packages", "observability", "src"], true)
);

const browserIncludes = "apps/web/src/**";
const uiIncludes = "apps/web/src/ui/**";

const jsoncComments = /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const jsoncTrailingCommas = /("(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/g;

/** Biome config text without JSONC comments and trailing commas; string contents stay untouched. */
const stripJsonc = (text) =>
  text
    .replace(jsoncComments, (_match, string) => string ?? "")
    .replace(jsoncTrailingCommas, (_match, string) => string ?? "");

const restrictedImportOptions = (override) =>
  override?.linter?.rules?.style?.noRestrictedImports?.options ?? {};
const restrictedImportLevel = (override) =>
  override?.linter?.rules?.style?.noRestrictedImports?.level;

// `on` is the rule's own default severity, which Biome does not promise to be an error, so it ranks
// below `error`; a level this table does not know ranks below everything.
const levelStrength = { error: 4, on: 3, warn: 2, info: 1, off: 0 };
const strengthOf = (level) => levelStrength[level] ?? -1;

/** What the copy of one browser pattern group lacks in the ui/ override, or adds that would undo it. */
function missingFromGroup(pattern, uiPatterns) {
  const copies = uiPatterns.filter(
    (candidate) => candidate.message === pattern.message
  );
  if (!pattern.message || copies.length !== 1) {
    return [
      `exactly one copy of the pattern group "${pattern.message}" (it needs a message of its own)`,
    ];
  }
  const [{ group }] = copies;
  const missing = group
    .filter((entry) => entry.startsWith("!") && !pattern.group.includes(entry))
    .map(
      (entry) =>
        `no extra exception: "${entry}" in the group "${pattern.message}" would reopen what the browser override restricts`
    );
  let from = 0;
  for (const entry of pattern.group) {
    const found = group.indexOf(entry, from);
    if (found === -1) {
      missing.push(`"${entry}" of the group "${pattern.message}"`);
    } else {
      from = found + 1;
    }
  }
  return missing;
}

/**
 * Biome replaces the options of `noRestrictedImports` in the override of `apps/web/src/ui/**` instead of
 * merging them with the browser override, so ui/ repeats the browser group. Everything the browser
 * override restricts (paths, and every entry of each pattern group, in the same order because a `!`
 * entry only undoes what came before it) must be there too, or ui/ is left uncovered without a sound.
 * Entries that only ui/ has (app-shell, the screens) may be extra, as separate groups, but an exception
 * (`!`) added to the copied group would undo a restriction, so it is refused. The `level` of the rule
 * must not be weaker either: with `off` or `warn` in ui/ the whole copied group would stop failing.
 */
function missingFromUiOverride(config) {
  const overrides = config.overrides ?? [];
  const browser = overrides.find((override) =>
    override.includes?.includes(browserIncludes)
  );
  const ui = overrides.find((override) =>
    override.includes?.includes(uiIncludes)
  );
  if (!(browser && ui)) {
    return [
      `biome.jsonc must keep the override of ${browserIncludes} and the one of ${uiIncludes}`,
    ];
  }
  const browserOptions = restrictedImportOptions(browser);
  const uiOptions = restrictedImportOptions(ui);
  const missing = [];
  const browserLevel = restrictedImportLevel(browser);
  const uiLevel = restrictedImportLevel(ui);
  if (strengthOf(uiLevel) < strengthOf(browserLevel)) {
    missing.push(
      `level ${JSON.stringify(uiLevel)} of noRestrictedImports, weaker than the ${JSON.stringify(browserLevel)} of the browser override`
    );
  }
  for (const [name, value] of Object.entries(browserOptions.paths ?? {})) {
    if (JSON.stringify(uiOptions.paths?.[name]) !== JSON.stringify(value)) {
      missing.push(`path "${name}"`);
    }
  }
  for (const pattern of browserOptions.patterns ?? []) {
    missing.push(...missingFromGroup(pattern, uiOptions.patterns ?? []));
  }
  return missing;
}

function assertUiRepeatsBrowserGroup(config, where) {
  const missing = missingFromUiOverride(config);
  if (missing.length > 0) {
    throw new Error(
      `${where}: the override of ${uiIncludes} must repeat what the browser override of ${browserIncludes} restricts (Biome replaces the options, it does not merge them). Missing: ${missing.join("; ")}.`
    );
  }
}

const biomeConfig = JSON.parse(
  stripJsonc(await readFile(path.join(root, "biome.jsonc"), "utf8"))
);
assertUiRepeatsBrowserGroup(biomeConfig, "biome.jsonc");

const overrideOf = (config, includes) =>
  config.overrides.find((override) => override.includes?.includes(includes));
const plantedConfig = (mutate) => {
  const copy = structuredClone(biomeConfig);
  const uiOverride = overrideOf(copy, uiIncludes);
  const options = restrictedImportOptions(uiOverride);
  mutate({
    browserOptions: restrictedImportOptions(overrideOf(copy, browserIncludes)),
    group: options.patterns.find(
      (pattern) => pattern.message === browserMessage
    ).group,
    options,
    override: uiOverride,
  });
  return copy;
};
const plantedMissing = [
  [
    "a library of the browser group",
    '"evlog/**"',
    ({ group }) => {
      group.splice(group.indexOf("evlog/**"), 1);
    },
  ],
  [
    "the exception of the browser group",
    '"!@polaris/observability/redaction"',
    ({ group }) => {
      group.splice(group.indexOf("!@polaris/observability/redaction"), 1);
    },
  ],
  [
    "the exception of the browser group in its place",
    '"!@polaris/observability/redaction"',
    ({ group }) => {
      const exception = "!@polaris/observability/redaction";
      group.splice(group.indexOf(exception), 1);
      group.unshift(exception);
    },
  ],
  [
    "an exception added to the copied group",
    '"!evlog/**"',
    ({ group }) => {
      group.splice(group.indexOf("evlog/**") + 1, 0, "!evlog/**");
    },
  ],
  [
    "the whole browser group",
    "Browser code must not import",
    ({ options }) => {
      options.patterns = options.patterns.filter(
        (pattern) => !pattern.message.startsWith("Browser code")
      );
    },
  ],
  [
    "a path the browser override restricts",
    'path "plantedPackage"',
    ({ browserOptions }) => {
      browserOptions.paths = { plantedPackage: "planted" };
    },
  ],
  [
    "an error level (it is off)",
    'level "off" of noRestrictedImports, weaker than the "error"',
    ({ override }) => {
      override.linter.rules.style.noRestrictedImports.level = "off";
    },
  ],
  [
    "an error level (it is warn)",
    'level "warn" of noRestrictedImports, weaker than the "error"',
    ({ override }) => {
      override.linter.rules.style.noRestrictedImports.level = "warn";
    },
  ],
  [
    "a level at all",
    'level undefined of noRestrictedImports, weaker than the "error"',
    ({ override }) => {
      override.linter.rules.style.noRestrictedImports.level = undefined;
    },
  ],
  [
    "the whole override",
    "must keep the override",
    ({ override }) => {
      override.includes = ["apps/web/src/never/**"];
    },
  ],
];
for (const [what, expected, mutate] of plantedMissing) {
  let message = "";
  try {
    assertUiRepeatsBrowserGroup(plantedConfig(mutate), "planted config");
  } catch (error) {
    ({ message } = error);
  }
  if (!message.includes(expected)) {
    throw new Error(
      `A copy of biome.jsonc without ${what} in the ui/ override must fail naming "${expected}", and it ${message ? `failed with: ${message}` : "passed"}.`
    );
  }
}

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

/** Biome's diagnostics grouped by repo-relative file: rule, message and whether it is an error. */
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
  } catch (error) {
    throw new Error(
      `Biome did not print a JSON report: ${result.stdout}${result.stderr}`,
      { cause: error }
    );
  }
  const byFile = new Map(files.map((file) => [file, []]));
  for (const diagnostic of report.diagnostics) {
    byFile.get(diagnostic.location?.path)?.push({
      error: diagnostic.severity === "error",
      message: diagnostic.message,
      rule: diagnostic.category,
    });
  }
  return byFile;
}

try {
  // allSettled, not all: a failed write must not let the cleanup below run while others are in flight
  const writes = await Promise.allSettled(
    fixtures.map((fixture) =>
      writeFile(fixture.path, fixture.source, { flag: "wx" })
    )
  );
  const failedWrite = writes.find((write) => write.status === "rejected");
  if (failedWrite) {
    throw failedWrite.reason;
  }

  const relativePaths = fixtures.map((fixture) =>
    path.relative(root, fixture.path)
  );
  const diagnostics = lintAll(relativePaths);

  for (const fixture of fixtures) {
    const relative = path.relative(root, fixture.path);
    const lines = diagnostics.get(relative);
    const output = lines
      .map((line) => `${line.rule} ${line.message}`)
      .join("\n");
    const matches = (line) =>
      line.rule === fixture.rule && line.message.includes(fixture.expected);

    // Every fixture breaks the file-name rule (the `__` prefix), so a file with no diagnostic at all
    // was not linted (ignored, or dropped from the run) and its "allowed" verdict would be vacuous.
    if (lines.length === 0) {
      throw new Error(
        `Biome reported nothing for ${relative}: it was not linted.`
      );
    }

    if (fixture.allowed) {
      if (lines.some(matches)) {
        throw new Error(
          `Biome rejected "${fixture.specifier}" in ${relative}, ` +
            `where it is allowed: ${output}`
        );
      }
    } else if (!lines.some((line) => line.error && matches(line))) {
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
