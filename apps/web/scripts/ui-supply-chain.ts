/**
 * The supply-chain floor of the interface packages (ADR 0103, security conditions 1, 3, 4 and 6).
 * Pure functions: ui-supply-chain.test.ts feeds them the real files and also synthetic ones, so a rule
 * that stops detecting is a red test and not a silent pass.
 */

/**
 * The interface runtime and build packages that may enter apps/web (condition 1). A pull request that
 * needs another one changes this list, in plain sight of the review. Exact versions only (no ^ or ~).
 * `lucide-react` stands for "lucide or the icons we already have": there are none today.
 */
export const UI_ALLOWED_PACKAGES = [
  "@base-ui/react",
  "@tailwindcss/vite",
  "class-variance-authority",
  "clsx",
  "lucide-react",
  "tailwind-merge",
  "tailwindcss",
  "tw-animate-css",
] as const;

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
    ...BASELINE_PACKAGES,
  ]);
  return declaredDependencies(manifest)
    .map(({ name }) => name)
    .filter((name) => !allowed.has(name));
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Interface packages declared with a range instead of an exact version (condition 4). */
export function inexactInterfaceVersions(manifest: PackageManifest) {
  const ui = new Set<string>(UI_ALLOWED_PACKAGES);
  return declaredDependencies(manifest)
    .filter(({ name, range }) => ui.has(name) && !EXACT_VERSION.test(range))
    .map(({ name, range }) => `${name}@${range}`);
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
      [string, string, Partial<Record<string, Record<string, string>>>?]
    >;
  };
  const packages = new Map<string, LockPackage>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    const meta = entry[2] ?? {};
    packages.set(key, {
      // Peer dependencies are the app's own direct ones (react...) and are covered by the baseline list.
      dependencies: [
        ...Object.keys(meta.dependencies ?? {}),
        ...Object.keys(meta.optionalDependencies ?? {}),
      ],
      id: entry[0],
    });
  }
  return packages;
}

const LAST_PACKAGE_IN_KEY = /^(.*)\/(@[^/]+\/[^/]+|[^/@][^/]*)$/;

function parentKey(key: string) {
  const match = LAST_PACKAGE_IN_KEY.exec(key);
  return match?.[1] ?? null;
}

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
 * `name@version` of the given packages and of everything they pull in (dependencies and optional
 * dependencies, the native binaries of the build tools included), read from bun.lock, sorted.
 */
export function interfaceClosure(
  packages: Map<string, LockPackage>,
  roots: string[]
) {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    const key = resolveInLock(packages, null, root);
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

/** The interface packages the manifest declares today, in any dependency field. */
export function declaredInterfacePackages(manifest: PackageManifest) {
  const ui = new Set<string>(UI_ALLOWED_PACKAGES);
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

/**
 * Condition 3: what code under apps/web/src/ui/ may not contain, and the packages it may import.
 * A relative import stays inside the project; anything else must be on the interface list.
 */
export function scanUiSource(file: string, source: string): SourceFinding[] {
  const findings: SourceFinding[] = SOURCE_RULES.filter(({ pattern }) =>
    pattern.test(source)
  ).map(({ rule }) => ({ file, rule }));
  const allowed = new Set<string>([
    ...UI_ALLOWED_PACKAGES,
    ...UI_SOURCE_EXTRA_PACKAGES,
  ]);
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1] as string;
    if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      continue;
    }
    if (!allowed.has(packageName(specifier))) {
      findings.push({ file, rule: `import of ${specifier}` });
    }
  }
  return findings;
}

const INSTALL_OR_BUILD =
  /\bbunx?\s+(?:install|i|add|ci)\b|\bnpm\s+(?:ci|install|i)\b|\bbun\s+run\s+(?:--filter\s+\S+\s+)?build|\bturbo\s+run\s+build|\bvite\s+build/;

// A secret or the job token read through an expression (a comment that only says "secrets." does not count).
const SECRET_REFERENCE = /\$\{\{[^}]*\b(?:secrets|github\.token)\b[^}]*\}\}/;

const JOBS_KEY = /^jobs:\s*$/;
const JOB_KEY = /^ {2}([\w-]+):\s*$/;
const STEPS_KEY = /^ {4}steps:\s*$/;
const STEP_START = /^ {6}- /;

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
    for (const line of stepsAt === -1 ? [] : body.slice(stepsAt + 1)) {
      if (STEP_START.test(line)) {
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
  const lines = workflow
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
  const jobsAt = lines.findIndex((line) => JOBS_KEY.test(line));
  if (jobsAt === -1) {
    return [`${file}: no top-level jobs: key`];
  }
  const workflowHasSecret = SECRET_REFERENCE.test(
    lines.slice(0, jobsAt).join("\n")
  );
  const problems: string[] = [];
  for (const job of splitJobs(lines, jobsAt)) {
    const risky = job.steps.filter((step) => INSTALL_OR_BUILD.test(step));
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
  return problems;
}
