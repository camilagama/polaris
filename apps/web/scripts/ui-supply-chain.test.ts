import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KNOWN_HARMLESS,
  policyOfBlock,
  productionPolicy,
} from "../e2e/csp-fixture";
import {
  BASELINE_PACKAGES,
  declaredInterfacePackages,
  inexactInterfaceVersions,
  interfaceClosure,
  nonRegistryDependencies,
  type PackageManifest,
  parseBunLock,
  readWorkflow,
  scanUiFolderFile,
  scanUiSource,
  secretsInInstallOrBuild,
  testPackagesOutsideDev,
  trustedDependencyEntries,
  UI_ALLOWED_PACKAGES,
  UI_TEST_PACKAGES,
  unlistedDependencies,
} from "./ui-supply-chain";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const webDir = join(root, "apps/web");
const readRoot = (path: string) => readFileSync(join(root, path), "utf8");
const readJson = (path: string) =>
  JSON.parse(readRoot(path)) as PackageManifest;
const webManifest = readJson("apps/web/package.json");

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.test\.[jt]sx?$/;
// only comments that open a line (a doc block, a `//` line): a `//` or `/*` inside a string never hides code
const COMMENT = /^\s*\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gm;
const WORKFLOW_FILE = /\.ya?ml$/;
const BUNFIG_RELEASE_AGE = /^minimumReleaseAge\s*=\s*604800\s*$/m;
const BUNFIG_AGE_KEYS = /^\s*(minimumReleaseAge\w*)\s*=/gm;
const TABLE_HEADER = /^\s*\[/;

/** The lines of the `[install]` table of a bunfig.toml, up to the next table. */
function installSection(bunfig: string) {
  const lines = bunfig.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[install]");
  if (start === -1) {
    return "";
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => TABLE_HEADER.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const BUNFIG_EXCLUDES = /^\s*minimumReleaseAgeExcludes\s*=\s*\[([^\]]*)\]/m;
const BUN_VERSION_FILE = /^\s*bun-version-file:\s*\.bun-version\s*$/m;
const STEP_START = /^\s*- /;
const BUN_VERSION_PIN = /^\s*bun-version:/m;
const MIN_BUN_VERSION = "1.4.3";

/** Compares `major.minor.patch` numerically; a pre-release suffix is ignored. */
function isAtLeast(version: string, minimum: string) {
  const parse = (text: string) =>
    text.split(".").map((part) => Number.parseInt(part, 10));
  const [a, b] = [parse(version), parse(minimum)];
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) > (b[index] ?? 0);
    }
  }
  return true;
}

const CLOSURE_FILE = "apps/web/ui-dependency-closure.txt";

describe("allowlist of interface packages (condition 1)", () => {
  it("apps/web declares only packages on the lists", () => {
    expect(unlistedDependencies(webManifest)).toEqual([]);
  });

  it("refuses a package that is on no list", () => {
    expect(
      unlistedDependencies({
        dependencies: { "@base-ui/react": "1.9.0", "next-themes": "0.4.6" },
        devDependencies: { sonner: "2.0.0", vite: "^8.3.3" },
      })
    ).toEqual(["next-themes", "sonner"]);
  });

  it("keeps the lists sorted, free of duplicates and apart from each other", () => {
    const lists: readonly (readonly string[])[] = [
      UI_ALLOWED_PACKAGES,
      UI_TEST_PACKAGES,
      BASELINE_PACKAGES,
    ];
    for (const list of lists) {
      expect([...list]).toEqual([...list].sort());
      expect(new Set(list).size).toBe(list.length);
    }
    const all = lists.flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps the test tools in devDependencies", () => {
    expect(testPackagesOutsideDev(webManifest)).toEqual([]);
    expect(
      testPackagesOutsideDev({
        dependencies: { "axe-core": "4.14.0" },
        devDependencies: { vite: "^8.3.3" },
      })
    ).toEqual(["axe-core in dependencies"]);
  });

  it("has no dependency that bypasses the registry", () => {
    expect(nonRegistryDependencies(webManifest)).toEqual([]);
    expect(
      nonRegistryDependencies({
        dependencies: {
          a: "npm:evil@1.0.0",
          b: "git+https://example.com/b.git",
          c: "https://example.com/c.tgz",
          d: "file:../d",
          e: "owner/repo",
          f: "^1.0.0",
          g: "workspace:*",
        },
      })
    ).toEqual([
      "a@npm:evil@1.0.0",
      "b@git+https://example.com/b.git",
      "c@https://example.com/c.tgz",
      "d@file:../d",
      "e@owner/repo",
    ]);
  });

  it("holds interface packages to an exact version", () => {
    expect(inexactInterfaceVersions(webManifest)).toEqual([]);
    expect(
      inexactInterfaceVersions({
        dependencies: {
          "@base-ui/react": "^1.9.0",
          clsx: "2.1.1",
          react: "^19.3.0",
          tailwindcss: "~4.1.0",
        },
      })
    ).toEqual(["@base-ui/react@^1.9.0", "tailwindcss@~4.1.0"]);
  });
});

describe("closure of the interface packages (condition 1)", () => {
  const lockText = readRoot("bun.lock");
  const packages = parseBunLock(lockText);

  it("matches the closure file, read from bun.lock", () => {
    const closure = interfaceClosure(
      packages,
      declaredInterfacePackages(webManifest)
    );
    const expected = `${closure.join("\n")}${closure.length > 0 ? "\n" : ""}`;
    if (process.env.UI_CLOSURE_UPDATE === "1" && !process.env.CI) {
      writeFileSync(join(root, CLOSURE_FILE), expected);
    }
    const recorded = readRoot(CLOSURE_FILE)
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .join("\n");
    expect(
      `${recorded}${recorded.length > 0 ? "\n" : ""}`,
      `${CLOSURE_FILE} differs from bun.lock: review the new or changed packages, then run UI_CLOSURE_UPDATE=1 bunx vitest run apps/web/scripts/ui-supply-chain.test.ts`
    ).toBe(expected);
  });

  it("follows dependencies, optional dependencies, peers and nested versions in the lock", () => {
    const lock = parseBunLock(`{
      "lockfileVersion": 2,
      "packages": {
        "ui": ["ui@1.0.0", "", { "dependencies": { "dep": "^1", "other": "^1" }, "optionalDependencies": { "native-x": "1", "native-y": "1" }, "peerDependencies": { "react": ">=18" } }, "sha512-x"],
        "dep": ["dep@1.2.0", "", { "dependencies": { "leaf": "^2" } }, "sha512-x"],
        "other": ["other@1.0.0", "", {}, "sha512-x"],
        "other/leaf": ["leaf@3.0.0", "", {}, "sha512-x"],
        "leaf": ["leaf@2.5.0", "", {}, "sha512-x"],
        "native-x": ["native-x@1.0.0", "", {}, "sha512-x"],
        "react": ["react@19.0.0", "", {}, "sha512-x"],
      }
    }`);
    expect(interfaceClosure(lock, ["ui"])).toEqual([
      "dep@1.2.0",
      "leaf@2.5.0",
      "native-x@1.0.0",
      "other@1.0.0",
      "react@19.0.0",
      "ui@1.0.0",
    ]);
  });

  it("brings in required peers and leaves optional ones out", () => {
    const lock = parseBunLock(`{
      "packages": {
        "ui": ["ui@1.0.0", "", { "peerDependencies": { "react": ">=18", "native": "*" }, "optionalPeers": ["native"] }, "x"],
        "react": ["react@19.0.0", "", {}, "x"],
        "native": ["native@1.0.0", "", {}, "x"]
      }
    }`);
    expect(interfaceClosure(lock, ["ui"])).toEqual([
      "react@19.0.0",
      "ui@1.0.0",
    ]);
  });

  it("prefers the copy the workspace owns over the hoisted one", () => {
    const lock = parseBunLock(`{
      "packages": {
        "ui": ["ui@2.0.0", "", {}, "x"],
        "@polaris/web/ui": ["ui@1.0.0", "", {}, "x"]
      }
    }`);
    expect(interfaceClosure(lock, ["ui"])).toEqual(["ui@1.0.0"]);
  });

  it("does not look up a scoped package as a nested one of its own scope", () => {
    const lock = parseBunLock(`{
      "packages": {
        "@s/ui": ["@s/ui@1.0.0", "", { "dependencies": { "ui": "*" } }, "x"],
        "ui": ["ui@9.0.0", "", {}, "x"]
      }
    }`);
    expect(interfaceClosure(lock, ["@s/ui"])).toEqual([
      "@s/ui@1.0.0",
      "ui@9.0.0",
    ]);
  });

  it("resolves a nested copy before the hoisted one", () => {
    const lock = parseBunLock(`{
      "packages": {
        "ui": ["ui@1.0.0", "", { "dependencies": { "other": "^1" } }, "x"],
        "other": ["other@1.0.0", "", { "dependencies": { "leaf": "^3" } }, "x"],
        "other/leaf": ["leaf@3.0.0", "", {}, "x"],
        "leaf": ["leaf@2.5.0", "", {}, "x"]
      }
    }`);
    expect(interfaceClosure(lock, ["ui"])).toEqual([
      "leaf@3.0.0",
      "other@1.0.0",
      "ui@1.0.0",
    ]);
  });

  it("fails when a declared interface package is missing from the lock", () => {
    expect(() => interfaceClosure(packages, ["not-in-the-lock-xyz"])).toThrow();
  });
});

describe("trustedDependencies stays empty (condition 1)", () => {
  const manifests = ["package.json", "apps", "packages"].flatMap((entry) => {
    if (entry === "package.json") {
      return [entry];
    }
    return readdirSync(join(root, entry))
      .map((name) => `${entry}/${name}/package.json`)
      .filter((path) => existsSync(join(root, path)));
  });

  it("is empty or absent in the root and in every workspace", () => {
    expect(manifests).toContain("apps/web/package.json");
    for (const path of manifests) {
      expect(trustedDependencyEntries(readJson(path)), path).toEqual([]);
    }
  });

  it("sees an entry when there is one", () => {
    expect(
      trustedDependencyEntries({ trustedDependencies: ["esbuild"] })
    ).toEqual(["esbuild"]);
  });
});

describe("source of apps/web/src/ui/, src/ui-gallery/ and src/lib/ (condition 3)", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return SOURCE_FILE.test(entry.name) ? [path] : [];
    });
  }

  // The components and their gallery: every rule, the packages included (a component test may import vitest).
  it.each(["src/ui", "src/ui-gallery"])(
    "no file under %s/ breaks a rule",
    (folder) => {
      const dir = join(webDir, folder);
      const findings = existsSync(dir)
        ? sourceFiles(dir).flatMap((file) =>
            scanUiFolderFile(file, readFileSync(file, "utf8"), dir)
          )
        : [];
      expect(findings).toEqual([]);
    }
  );

  // src/lib/ is shared with the old screens and imports the app's own packages: the rules on markup and style
  // for all of it (comments and tests aside: a test holds the attacks as data), every rule for what the
  // interface base put there (`cn` and the theme).
  const libDir = join(webDir, "src/lib");
  const LIB_OF_THE_BASE = ["utils.ts", "theme.ts"];

  it("no file under src/lib/ injects markup or style", () => {
    const findings = sourceFiles(libDir)
      .filter((file) => !TEST_FILE.test(file))
      .flatMap((file) =>
        scanUiSource(
          file,
          readFileSync(file, "utf8").replace(COMMENT, ""),
          libDir
        ).filter(({ rule }) => !rule.startsWith("import of "))
      );
    expect(findings).toEqual([]);
  });

  it("lets only a test file of src/ui/ import the test runner, and keeps every other rule on it", () => {
    const vitest = 'import { it } from "vitest";';
    expect(scanUiFolderFile("/w/src/ui/a.test.tsx", vitest)).toEqual([]);
    expect(scanUiFolderFile("/w/src/ui/a.tsx", vitest)).toEqual([
      { file: "/w/src/ui/a.tsx", rule: "import of vitest" },
    ]);
    expect(
      scanUiFolderFile(
        "/w/src/ui/a.test.tsx",
        'import "vitest/config"; import "@vitest/expect"; import "axe-core"; el.innerHTML = x;'
      ).map(({ rule }) => rule)
    ).toEqual([
      ".innerHTML",
      "import of vitest/config",
      "import of @vitest/expect",
      "import of axe-core",
    ]);
  });

  it("strips only comments that open a line, never code after a string", () => {
    expect('const a = "x // " + el.innerHTML;'.replace(COMMENT, "")).toContain(
      ".innerHTML"
    );
    expect(
      "/**\n * never an injected <style>\n */\nexport {};".replace(COMMENT, "")
    ).not.toContain("<style");
  });

  it.each(LIB_OF_THE_BASE)("src/lib/%s breaks no rule", (name) => {
    const file = join(libDir, name);
    expect(
      scanUiSource(
        file,
        readFileSync(file, "utf8").replace(COMMENT, ""),
        libDir
      )
    ).toEqual([]);
  });

  const clean = `import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { clsx } from "clsx";
import { cn } from "../lib/cn";
export const Box = () => <Dialog.Root />;`;

  it("accepts a component made of the listed packages and relative imports", () => {
    expect(scanUiSource("box.tsx", clean)).toEqual([]);
  });

  it.each([
    ["<style", "const a = <style>{css}</style>;"],
    [
      "dangerouslySetInnerHTML",
      "<div dangerouslySetInnerHTML={{ __html: x }} />",
    ],
    ['createElement("style")', 'document.createElement("style")'],
    ['createElement("style")', "document.createElement('style')"],
    ["insertAdjacentHTML", 'el.insertAdjacentHTML("beforeend", x)'],
    [".innerHTML", "el.innerHTML = x"],
    ["next-themes", 'import { ThemeProvider } from "next-themes";'],
    ["sonner", 'import { Toaster } from "sonner";'],
    ["vaul", 'import { Drawer } from "vaul";'],
  ])("rejects %s", (rule, source) => {
    expect(
      scanUiSource("x.tsx", source).map((finding) => finding.rule)
    ).toContain(rule);
  });

  it.each([
    'import x from "lodash";',
    'export { y } from "@radix-ui/react-dialog";',
    'const z = await import("framer-motion");',
    'const w = require("moment");',
    'import "some-side-effect";',
  ])("rejects a package off the list: %s", (source) => {
    const rules = scanUiSource("x.tsx", source).map((finding) => finding.rule);
    expect(rules.some((rule) => rule.startsWith("import of "))).toBe(true);
  });

  it("rejects a relative import that reaches node_modules or leaves src", () => {
    const srcRoot = "/repo/apps/web/src";
    const file = "/repo/apps/web/src/ui/button.tsx";
    const rules = (specifier: string) =>
      scanUiSource(file, `import x from "${specifier}";`, srcRoot);
    expect(rules("../lib/cn")).toEqual([]);
    expect(rules("./button-group")).toEqual([]);
    expect(rules("../../../../node_modules/x/index.js")).toHaveLength(1);
    expect(rules("../../../../packages/db/src/index")).toHaveLength(1);
    expect(rules("../../../other/file")).toHaveLength(1);
  });

  it.each([
    ["outerHTML", "el.outerHTML = x"],
    ["document.write", 'document.write("<p>")'],
    ['createElementNS(..., "style")', 'document.createElementNS(ns, "style")'],
    ["adoptedStyleSheets", "document.adoptedStyleSheets = [sheet]"],
  ])("rejects %s too", (rule, source) => {
    expect(
      scanUiSource("x.tsx", source).map((finding) => finding.rule)
    ).toContain(rule);
  });

  it("takes a scoped package by its first two segments", () => {
    expect(
      scanUiSource("x.tsx", 'import { a } from "@base-ui/react/popover";')
    ).toEqual([]);
    expect(
      scanUiSource("x.tsx", 'import { a } from "@base-ui/other/popover";')
    ).toEqual([{ file: "x.tsx", rule: "import of @base-ui/other/popover" }]);
  });
});

describe("minimumReleaseAge (condition 4)", () => {
  it("is 7 days for Renovate", () => {
    const renovate = JSON.parse(readRoot("renovate.json")) as {
      internalChecksFilter?: string;
      minimumReleaseAge?: string;
      packageRules?: Record<string, unknown>[];
    };
    expect(renovate.minimumReleaseAge).toBe("7 days");
    // "strict" keeps the branch from being created before the age is reached.
    expect(renovate.internalChecksFilter).toBe("strict");
    // No rule may shorten or drop the age for its packages.
    expect(
      renovate.packageRules?.filter((rule) => "minimumReleaseAge" in rule)
    ).toEqual([]);
  });

  it("is 7 days (604800 seconds) for Bun", () => {
    const install = installSection(readRoot("bunfig.toml"));
    expect(install).toMatch(BUNFIG_RELEASE_AGE);
    // A misspelled key or one in another table is ignored by Bun: only these two names exist.
    expect(
      [...readRoot("bunfig.toml").matchAll(BUNFIG_AGE_KEYS)]
        .map((match) => match[1])
        .filter(
          (key) =>
            key !== "minimumReleaseAge" && key !== "minimumReleaseAgeExcludes"
        )
    ).toEqual([]);
    expect(
      installSection(
        '[install]\nminimumReleaseAgeExcludes = ["x"]\nminimumReleaseAge = 604800\n[run]\nbun = true\n'
      )
    ).toMatch(BUNFIG_RELEASE_AGE);
    expect(installSection("[run]\nminimumReleaseAge = 604800\n")).not.toMatch(
      BUNFIG_RELEASE_AGE
    );
  });

  it("excludes from the age only the packages of an urgent update, one by one", () => {
    // docs/runbooks/dependency-audit.md: the urgent PR lists the package here and in bunfig.toml;
    // the PR that removes the entry (after 7 days) empties this list again.
    const URGENT_EXCLUDES: string[] = [];
    const entry = BUNFIG_EXCLUDES.exec(installSection(readRoot("bunfig.toml")));
    const excluded = (entry?.[1] ?? "")
      .split(",")
      .map((name) => name.trim().replace(/^"|"$/g, ""))
      .filter((name) => name.length > 0);
    expect(excluded).toEqual(URGENT_EXCLUDES);
    expect(excluded.filter((name) => name.includes("*"))).toEqual([]);
  });

  const readBunVersion = () => readRoot(".bun-version").trim();

  it("is enforced by a Bun that honors it: .bun-version is 1.4.3 or newer", () => {
    expect(isAtLeast(readBunVersion(), MIN_BUN_VERSION)).toBe(true);
    expect(isAtLeast("1.4.2", MIN_BUN_VERSION)).toBe(false);
    expect(isAtLeast("1.3.9", MIN_BUN_VERSION)).toBe(false);
    expect(isAtLeast("1.4.3", MIN_BUN_VERSION)).toBe(true);
    expect(isAtLeast("1.10.0", MIN_BUN_VERSION)).toBe(true);
    expect(isAtLeast("2.0.0", MIN_BUN_VERSION)).toBe(true);
  });

  it("is the Bun of packageManager and of every setup-bun step", () => {
    const version = readBunVersion();
    expect(readJson("package.json")).toMatchObject({
      packageManager: `bun@${version}`,
    });
    const workflowDir = join(root, ".github/workflows");
    let steps = 0;
    for (const name of readdirSync(workflowDir).filter((file) =>
      WORKFLOW_FILE.test(file)
    )) {
      const lines = readFileSync(join(workflowDir, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("oven-sh/setup-bun@")) {
          return;
        }
        steps += 1;
        // The CI picks Bun by the file: no pinned `bun-version` that could drift from it.
        const following = lines.slice(index + 1);
        const stepEnd = following.findIndex((next) => STEP_START.test(next));
        const withBlock = (
          stepEnd === -1 ? following : following.slice(0, stepEnd)
        ).join("\n");
        expect(withBlock, `${name}:${index + 1}`).toMatch(BUN_VERSION_FILE);
        expect(withBlock, `${name}:${index + 1}`).not.toMatch(BUN_VERSION_PIN);
      });
    }
    expect(steps).toBeGreaterThan(0);
  });
});

describe("policy of the CSP fixture (condition 2)", () => {
  const file = `# comment
/sw.js
  Content-Security-Policy: default-src 'none'
  Cache-Control: no-cache

/*
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'
  Referrer-Policy: no-referrer

/other
  Content-Security-Policy: default-src 'self' evil.example
`;

  it("reads the block of the path asked, not the first CSP line of the file", () => {
    expect(policyOfBlock(file, "/*")).toBe("default-src 'self'");
    expect(policyOfBlock(file, "/sw.js")).toBe("default-src 'none'");
    expect(policyOfBlock(file, "/missing")).toBe("");
  });

  it("is the policy of the `/*` block of the real _headers file", () => {
    expect(productionPolicy).toContain("default-src 'self'");
    expect(productionPolicy).toContain("frame-ancestors 'none'");
  });
});

describe("CSP exceptions", () => {
  it("has no known harmless violation: every violation fails the e2e", () => {
    expect(KNOWN_HARMLESS).toEqual([]);
  });
});

describe("secrets stay out of install and build steps (condition 6)", () => {
  const workflowDir = join(root, ".github/workflows");
  const workflows = readdirSync(workflowDir).filter((name) =>
    WORKFLOW_FILE.test(name)
  );

  it("finds the workflows", () => {
    expect(workflows).toContain("ci.yml");
    expect(workflows).toContain("deploy-staging.yml");
  });

  it.each(workflows)(
    "%s: no secret in a step that installs or builds",
    (name) => {
      const text = readFileSync(join(workflowDir, name), "utf8");
      const { problems, recognized } = readWorkflow(text, name);
      expect(problems).toEqual([]);
      // A reader that recognizes nothing would pass any file: it must see the install it knows is there.
      expect(
        recognized,
        `${name}: no install or build step recognized`
      ).toBeGreaterThan(0);
    }
  );

  it.each([
    "bun run --filter=@polaris/web build",
    "bun run --cwd apps/web build",
    "bun run --bun build",
    "bun update",
    "turbo build",
    "npm run build",
    "yarn install",
    "pnpm install",
    "npx playwright test --config x.ts",
    "bun run test:offline-poc",
    "bunx vitest run",
  ])("recognizes `%s` as an install or build step", (command) => {
    const workflow = `name: X
jobs:
  j:
    steps:
      - env:
          T: \${{ secrets.T }}
        run: ${command}
`;
    expect(secretsInInstallOrBuild(workflow, "w.yml")).toHaveLength(1);
  });

  it("reads steps at another indent and a job key with a comment", () => {
    const workflow = `name: X
jobs:
  a: # first
    steps:
    - run: echo hi
  b: # second
    steps:
    - env:
        T: \${{ secrets.T }}
      run: bun install
`;
    const { problems, recognized } = readWorkflow(workflow, "w.yml");
    expect(recognized).toBe(1);
    expect(problems).toHaveLength(1);
  });

  const header = `name: X
on: push
jobs:
  build:
    runs-on: ubuntu-24.04
`;

  it("passes a deploy step that holds the secret while install and build hold none", () => {
    const workflow = `${header}    steps:
      - run: bun install --frozen-lockfile
      - name: Build
        env:
          VITE_FLAG: "true"
        run: bun run --filter @polaris/web build
  deploy:
    steps:
      - run: bun install --frozen-lockfile
      # secrets. are only in this one
      - name: Deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: bunx --no-install wrangler deploy
`;
    expect(secretsInInstallOrBuild(workflow, "w.yml")).toEqual([]);
  });

  it("fails a secret in the env of the install step", () => {
    const workflow = `${header}    steps:
      - name: Install
        env:
          TOKEN: \${{ secrets.TOKEN }}
        run: bun install --frozen-lockfile
`;
    expect(secretsInInstallOrBuild(workflow, "w.yml")).toHaveLength(1);
  });

  it("fails a secret in the build step, in a multi-line run too", () => {
    const workflow = `${header}    steps:
      - name: Build
        env:
          TOKEN: \${{ secrets.TOKEN }}
        run: |
          echo start
          bun run --filter @polaris/web build
`;
    expect(secretsInInstallOrBuild(workflow, "w.yml")).toHaveLength(1);
  });

  it("fails a secret in the job-level env of a job that builds", () => {
    const workflow = `name: X
jobs:
  build:
    env:
      TOKEN: \${{ secrets.TOKEN }}
    steps:
      - run: bun run build
`;
    expect(secretsInInstallOrBuild(workflow, "w.yml")).toHaveLength(1);
  });

  it("fails a secret in the workflow-level env", () => {
    const workflow = `name: X
env:
  TOKEN: \${{ secrets.TOKEN }}
jobs:
  build:
    steps:
      - run: bun install --frozen-lockfile
`;
    expect(secretsInInstallOrBuild(workflow, "w.yml")).toHaveLength(1);
  });

  it("fails the job token read in a build step", () => {
    const workflow = `${header}    steps:
      - env:
          GH: \${{ github.token }}
        run: bun run --filter @polaris/web build
`;
    expect(secretsInInstallOrBuild(workflow, "w.yml")).toHaveLength(1);
  });

  it("refuses a file it cannot read", () => {
    expect(secretsInInstallOrBuild("name: X\n", "w.yml")).toHaveLength(1);
  });
});
