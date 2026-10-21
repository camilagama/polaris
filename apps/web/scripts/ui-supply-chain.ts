import { dirname, resolve, sep } from "node:path";

/**
 * The supply-chain floor of the interface packages (ADR 0103, security conditions 1, 3, 4 and 6).
 * Pure functions: ui-supply-chain.test.ts feeds them the real files and also synthetic ones, so a rule
 * that stops detecting is a red test and not a silent pass.
 */

/**
 * The interface runtime and build packages that may enter apps/web (condition 1). A pull request that
 * needs another one changes this list, in plain sight of the review. Exact versions only (no ^ or ~).
 * `lucide-react` stands for "lucide or the icons we already have": there are none today.
 * The two `@fontsource-variable` packages came with the UI base (ADR 0103, section 2): the Geist files
 * served by the app itself, so it works offline and under `font-src 'self'`; CSS and woff2 only, no code
 * and no dependencies, imported by their latin subset file.
 */
export const UI_ALLOWED_PACKAGES = [
  "@base-ui/react",
  "@fontsource-variable/geist",
  "@fontsource-variable/geist-mono",
  "@tailwindcss/vite",
  "class-variance-authority",
  "clsx",
  "lucide-react",
  "tailwind-merge",
  "tailwindcss",
  "tw-animate-css",
] as const;

/**
 * Test tools of the interface: development dependencies only, held like the list above (exact version,
 * closure under review) but never importable by src/ui/ nor declared as a runtime dependency.
 * `axe-core` came with the components of the sale (ADR 0103, section 8, item 3): the Playwright checks
 * evaluate it inside the gallery (no violation in each theme). It has no dependencies and no install script.
 */
export const UI_TEST_PACKAGES = ["axe-core"] as const;

/**
 * Everything apps/web depended on before this floor existed. These are not interface packages; the list
 * only freezes the set, so a new name (of any kind) cannot enter without editing this file.
 */
export const BASELINE_PACKAGES = [
  "@cloudflare/vite-plugin",
  "@cloudflare/workers-types",
  "@noble/hashes",
  "@orpc/client",
  "@orpc/server",
  "@playwright/test",
  "@polaris/billing",
  "@polaris/contracts",
  "@polaris/db",
  "@polaris/domain",
  "@polaris/http-security",
  "@polaris/observability",
  "@sentry/react",
  "@tanstack/browser-db-sqlite-persistence",
  "@tanstack/db",
  "@tanstack/offline-transactions",
  "@tanstack/react-db",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "better-auth",
  "browserstack-local",
  "hono",
  "react",
  "react-dom",
  "react-email",
  "vite",
  "webdriverio",
  "wrangler",
] as const;

/** Packages that code under src/ui/ may import besides the interface list (condition 3). */
const UI_SOURCE_EXTRA_PACKAGES = ["react", "react-dom"];

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  trustedDependencies?: string[];
}

function declaredDependencies(manifest: PackageManifest) {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).map(([name, range]) => ({
      field,
      name,
      range,
    }))
  );
}

/** Dependencies of the manifest that are on no list (condition 1). */
export function unlistedDependencies(manifest: PackageManifest) {
  const allowed = new Set<string>([
    ...UI_ALLOWED_PACKAGES,
    ...UI_TEST_PACKAGES,
    ...BASELINE_PACKAGES,
  ]);
  return declaredDependencies(manifest)
    .map(({ name }) => name)
    .filter((name) => !allowed.has(name));
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Interface packages (test tools included) declared with a range instead of an exact version (condition 4). */
export function inexactInterfaceVersions(manifest: PackageManifest) {
  const ui = new Set<string>([...UI_ALLOWED_PACKAGES, ...UI_TEST_PACKAGES]);
  return declaredDependencies(manifest)
    .filter(({ name, range }) => ui.has(name) && !EXACT_VERSION.test(range))
    .map(({ name, range }) => `${name}@${range}`);
}

const NON_REGISTRY_RANGE =
  /^(?:npm:|git|https?:|file:|link:|github:|[\w.-]+\/[\w.-]+$)/;

/** Dependencies pointing at something other than the registry (alias, URL, git, path): a name on the list would hide them. */
export function nonRegistryDependencies(manifest: PackageManifest) {
  return declaredDependencies(manifest)
    .filter(({ range }) => NON_REGISTRY_RANGE.test(range))
    .map(({ name, range }) => `${name}@${range}`);
}

/** Test tools of the interface declared anywhere but in `devDependencies`. */
export function testPackagesOutsideDev(manifest: PackageManifest) {
  const tools = new Set<string>(UI_TEST_PACKAGES);
  return declaredDependencies(manifest)
    .filter(({ field, name }) => tools.has(name) && field !== "devDependencies")
    .map(({ field, name }) => `${name} in ${field}`);
}

/** `trustedDependencies` entries of a manifest: any one lets that package run install scripts. */
export function trustedDependencyEntries(manifest: PackageManifest) {
  return manifest.trustedDependencies ?? [];
}

interface LockPackage {
  dependencies: string[];
  id: string;
}

/** bun.lock is JSONC: only trailing commas need to go before JSON.parse. */
export function parseBunLock(text: string) {
  const json = text.replace(/,(\s*[}\]])/g, "$1");
  const lock = JSON.parse(json) as {
    packages: Record<
      string,
      [string, string, Record<string, Record<string, string> | string[]>?]
    >;
  };
  const packages = new Map<string, LockPackage>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    const meta = entry[2] ?? {};
    const optionalPeers = new Set((meta.optionalPeers ?? []) as string[]);
    packages.set(key, {
      // Bun installs required peers too; an optional peer that nobody else brings is not installed.
      dependencies: [
        ...Object.keys(meta.dependencies ?? {}),
        ...Object.keys(meta.optionalDependencies ?? {}),
        ...Object.keys(meta.peerDependencies ?? {}).filter(
          (name) => !optionalPeers.has(name)
        ),
      ],
      id: entry[0],
    });
  }
  return packages;
}

const LAST_PACKAGE_IN_KEY = /^(.*)\/(@[^/]+\/[^/]+|[^/@][^/]*)$/;

const PLAIN_PACKAGE_NAME = /^(?:@[^/]+\/)?[^/]+$/;

function parentKey(key: string) {
  if (PLAIN_PACKAGE_NAME.test(key)) {
    return null;
  }
  const match = LAST_PACKAGE_IN_KEY.exec(key);
  return match?.[1] ?? null;
}

const WORKSPACE_KEY = "@polaris/web";

function resolveInLock(
  packages: Map<string, LockPackage>,
  fromKey: string | null,
  name: string
) {
  let scope = fromKey;
  while (scope !== null) {
    const nested = `${scope}/${name}`;
    if (packages.has(nested)) {
      return nested;
    }
    scope = parentKey(scope);
  }
  return packages.has(name) ? name : null;
}

/**
 * `name@version` of the given packages and of everything they pull in (dependencies, optional
 * dependencies and required peers, the native binaries of the build tools included), read from bun.lock, sorted.
 */
export function interfaceClosure(
  packages: Map<string, LockPackage>,
  roots: string[]
) {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    // A workspace that needs another version than the hoisted one gets its own key, prefixed by its name.
    const key = resolveInLock(packages, WORKSPACE_KEY, root);
    if (key === null) {
      throw new Error(`${root} is in package.json but not in bun.lock`);
    }
    queue.push(key);
  }
  while (queue.length > 0) {
    const key = queue.pop() as string;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    for (const dependency of packages.get(key)?.dependencies ?? []) {
      const resolved = resolveInLock(packages, key, dependency);
      // An optional dependency of another platform may be absent from the lock.
      if (resolved !== null) {
        queue.push(resolved);
      }
    }
  }
  return [...seen].map((key) => (packages.get(key) as LockPackage).id).sort();
}

/** The interface packages (test tools included) the manifest declares today, in any dependency field. */
export function declaredInterfacePackages(manifest: PackageManifest) {
  const ui = new Set<string>([...UI_ALLOWED_PACKAGES, ...UI_TEST_PACKAGES]);
  return [
    ...new Set(
      declaredDependencies(manifest)
        .map(({ name }) => name)
        .filter((name) => ui.has(name))
    ),
  ].sort();
}

export interface SourceFinding {
  file: string;
  rule: string;
}

const SOURCE_RULES: { rule: string; pattern: RegExp }[] = [
  { pattern: /<style\b/, rule: "<style" },
  { pattern: /dangerouslySetInnerHTML/, rule: "dangerouslySetInnerHTML" },
  {
    pattern: /createElement\(\s*["'`]style["'`]/,
    rule: 'createElement("style")',
  },
  { pattern: /insertAdjacentHTML/, rule: "insertAdjacentHTML" },
  { pattern: /\.innerHTML/, rule: ".innerHTML" },
  // Beyond the ADR's list: the same holes by another door.
  { pattern: /\bouterHTML\b/, rule: "outerHTML" },
  { pattern: /document\.write/, rule: "document.write" },
  {
    pattern: /createElementNS\([^)]*["'`]style["'`]/,
    rule: 'createElementNS(..., "style")',
  },
  { pattern: /adoptedStyleSheets/, rule: "adoptedStyleSheets" },
  { pattern: /next-themes/, rule: "next-themes" },
  { pattern: /\bsonner\b/, rule: "sonner" },
  { pattern: /\bvaul\b/, rule: "vaul" },
];

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bimport\s+)["'`]([^"'`]+)["'`]/g;

function packageName(specifier: string) {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

/** A relative import that reaches node_modules or leaves apps/web/src (`srcRoot`, when given). */
function escapesSource(file: string, specifier: string, srcRoot?: string) {
  if (specifier.split("/").includes("node_modules")) {
    return true;
  }
  if (srcRoot === undefined) {
    return false;
  }
  const target = resolve(dirname(file), specifier);
  return target !== srcRoot && !target.startsWith(`${srcRoot}${sep}`);
}

/**
 * Condition 3: what code under apps/web/src/ui/ may not contain, and the packages it may import.
 * A relative import stays inside the project; anything else must be on the interface list.
 */
export function scanUiSource(
  file: string,
  source: string,
  srcRoot?: string
): SourceFinding[] {
  const findings: SourceFinding[] = SOURCE_RULES.filter(({ pattern }) =>
    pattern.test(source)
  ).map(({ rule }) => ({ file, rule }));
  const allowed = new Set<string>([
    ...UI_ALLOWED_PACKAGES,
    ...UI_SOURCE_EXTRA_PACKAGES,
  ]);
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] as string;
    if (specifier.startsWith(".")) {
      if (escapesSource(file, specifier, srcRoot)) {
        findings.push({ file, rule: `import of ${specifier}` });
      }
      continue;
    }
    if (specifier.startsWith("@/")) {
      continue;
    }
    if (!allowed.has(packageName(specifier))) {
      findings.push({ file, rule: `import of ${specifier}` });
    }
  }
  return findings;
}

const TEST_FILE = /\.test\.[jt]sx?$/;
const TEST_RUNNER_IMPORT = "import of vitest";

/**
 * `scanUiSource` for a file of src/ui/ or of the gallery, where a component test may sit beside the
 * components: a `*.test.*` file may also import the test runner (`vitest` itself, nothing else), and every
 * other rule still holds for it. The runner never reaches the bundle: no component imports a test file.
 */
export function scanUiFolderFile(
  file: string,
  source: string,
  srcRoot?: string
) {
  return scanUiSource(file, source, srcRoot).filter(
    ({ rule }) => !(TEST_FILE.test(file) && rule === TEST_RUNNER_IMPORT)
  );
}

// What installs dependencies or runs repository code (a build, a test run that builds inside): none of it may hold a secret.
const INSTALL_OR_BUILD =
  /\b(?:bunx?|npm|yarn|pnpm)\s+(?:install|i|add|ci|update|up)\b|\b(?:bun|npm|yarn|pnpm)\s+run\s+[^\n]*\b(?:build|test)\b|\b(?:turbo|npm|yarn|pnpm)\s+(?:run\s+)?build\b|\bvite\s+build|\bplaywright\s+test|\bvitest\b/;

// A secret or the job token read through an expression (a comment that only says "secrets." does not count).
const SECRET_REFERENCE = /\$\{\{[^}]*\b(?:secrets|github\.token)\b[^}]*\}\}/;

const JOBS_KEY = /^jobs:\s*(?:#.*)?$/;
const JOB_KEY = /^ {2}([\w-]+):\s*(?:#.*)?$/;
const STEPS_KEY = /^(\s+)steps:\s*(?:#.*)?$/;
const LIST_ITEM = /^(\s*)- /;

function splitJobs(lines: string[], jobsAt: number) {
  const starts = lines
    .map((line, index) => ({ index, match: JOB_KEY.exec(line) }))
    .filter(({ index, match }) => index > jobsAt && match !== null);
  return starts.map(({ index, match }, position) => {
    const body = lines.slice(
      index + 1,
      starts[position + 1]?.index ?? lines.length
    );
    const stepsAt = body.findIndex((line) => STEPS_KEY.test(line));
    const steps: string[][] = [];
    const afterSteps = stepsAt === -1 ? [] : body.slice(stepsAt + 1);
    // The steps are the list items at the indent of the first one, whatever that indent is.
    const itemIndent = afterSteps
      .map((line) => LIST_ITEM.exec(line))
      .find((item) => item !== null)?.[1];
    for (const line of afterSteps) {
      if (LIST_ITEM.exec(line)?.[1] === itemIndent) {
        steps.push([line]);
      } else {
        steps.at(-1)?.push(line);
      }
    }
    return {
      header: body.slice(0, stepsAt === -1 ? 0 : stepsAt).join("\n"),
      name: (match as RegExpExecArray)[1],
      steps: steps.map((step) => step.join("\n")),
    };
  });
}

/**
 * Condition 6: no secret in the step that installs dependencies or builds, nor in the `env` of the job
 * or of the workflow that such a step would inherit. The workflows are plain YAML (no anchors, no
 * flow-style maps), so a line-based reading is enough; a file without a top-level `jobs:` fails loudly.
 */
export function secretsInInstallOrBuild(workflow: string, file: string) {
  return readWorkflow(workflow, file).problems;
}

/**
 * Same check, plus how many install or build steps it recognized: a workflow where that count is zero
 * is a workflow this reader may not understand, and the test refuses to call it clean.
 */
export function readWorkflow(workflow: string, file: string) {
  const lines = workflow
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
  const jobsAt = lines.findIndex((line) => JOBS_KEY.test(line));
  if (jobsAt === -1) {
    return { problems: [`${file}: no top-level jobs: key`], recognized: 0 };
  }
  const workflowHasSecret = SECRET_REFERENCE.test(
    lines.slice(0, jobsAt).join("\n")
  );
  const problems: string[] = [];
  let recognized = 0;
  for (const job of splitJobs(lines, jobsAt)) {
    const risky = job.steps.filter((step) => INSTALL_OR_BUILD.test(step));
    recognized += risky.length;
    if (risky.length === 0) {
      continue;
    }
    if (workflowHasSecret) {
      problems.push(
        `${file}: a secret in the workflow-level env, job ${job.name} installs or builds`
      );
    }
    if (SECRET_REFERENCE.test(job.header)) {
      problems.push(
        `${file}: a secret in the job-level env of ${job.name}, which installs or builds`
      );
    }
    for (const step of risky.filter((text) => SECRET_REFERENCE.test(text))) {
      problems.push(
        `${file}: a secret in a step of ${job.name} that installs or builds (${step.trim().slice(0, 60)})`
      );
    }
  }
  return { problems, recognized };
}
