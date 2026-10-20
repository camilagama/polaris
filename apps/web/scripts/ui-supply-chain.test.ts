import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_PACKAGES,
  declaredInterfacePackages,
  inexactInterfaceVersions,
  interfaceClosure,
  nonRegistryDependencies,
  type PackageManifest,
  parseBunLock,
  readWorkflow,
  scanUiSource,
  secretsInInstallOrBuild,
  trustedDependencyEntries,
  UI_ALLOWED_PACKAGES,
  unlistedDependencies,
} from "./ui-supply-chain";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const webDir = join(root, "apps/web");
const readRoot = (path: string) => readFileSync(join(root, path), "utf8");
const readJson = (path: string) =>
  JSON.parse(readRoot(path)) as PackageManifest;
const webManifest = readJson("apps/web/package.json");

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const WORKFLOW_FILE = /\.ya?ml$/;
const BUNFIG_RELEASE_AGE =
  /^\[install\][^[]*^minimumReleaseAge\s*=\s*604800\s*$/m;

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
    for (const list of [UI_ALLOWED_PACKAGES, BASELINE_PACKAGES]) {
      expect([...list]).toEqual([...list].sort());
      expect(new Set(list).size).toBe(list.length);
    }
    expect(
      UI_ALLOWED_PACKAGES.filter((name) =>
        (BASELINE_PACKAGES as readonly string[]).includes(name)
      )
    ).toEqual([]);
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

describe("source of apps/web/src/ui/ (condition 3)", () => {
  const uiDir = join(webDir, "src/ui");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return SOURCE_FILE.test(entry.name) ? [path] : [];
    });
  }

  const present = existsSync(uiDir);
  it(
    present
      ? "no file under src/ui/ breaks a rule"
      : "passes empty: src/ui/ does not exist yet",
    () => {
      const findings = present
        ? sourceFiles(uiDir).flatMap((file) =>
            scanUiSource(file, readFileSync(file, "utf8"), uiDir)
          )
        : [];
      expect(findings).toEqual([]);
    }
  );

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
    expect(readRoot("bunfig.toml")).toMatch(BUNFIG_RELEASE_AGE);
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
