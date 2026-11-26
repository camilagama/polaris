import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  SOURCE_RULE_EXCEPTIONS,
  scanTestLibraryImports,
  scanUiFolderFile,
  scanUiSource,
  secretsInInstallOrBuild,
  TEST_LIBRARY_EXCEPTIONS,
  TEST_LIBRARY_SCAN_FOLDERS,
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

describe("source of apps/web/src (condition 3)", () => {
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

  it("rejects adoptedStyleSheets in every file, the old counter's path included, and lists no exception", () => {
    const adopt = "root.adoptedStyleSheets = [sheet];";
    for (const file of [
      "/repo/apps/web/src/ui/figure-counter.tsx",
      "/repo/apps/web/src/ui/money.tsx",
      "/repo/apps/web/src/ui/animated-figure.tsx",
    ]) {
      expect(scanUiSource(file, adopt, undefined, "/repo")).toEqual([
        { file, rule: "adoptedStyleSheets" },
      ]);
    }
    expect(SOURCE_RULE_EXCEPTIONS).toEqual([]);
  });

  it("takes a scoped package by its first two segments", () => {
    expect(
      scanUiSource("x.tsx", 'import { a } from "@base-ui/react/popover";')
    ).toEqual([]);
    expect(
      scanUiSource("x.tsx", 'import { a } from "@base-ui/other/popover";')
    ).toEqual([{ file: "x.tsx", rule: "import of @base-ui/other/popover" }]);
  });
  // The test libraries never reach the bundle: every file of the production folders that is not a `*.test.*` or
  // `*.spec.*` is production code, whatever its folder.
  it("walks exactly src, worker, pwa and legal, each with a production file", () => {
    expect(TEST_LIBRARY_SCAN_FOLDERS).toEqual([
      "src",
      "worker",
      "pwa",
      "legal",
    ]);
    for (const folder of TEST_LIBRARY_SCAN_FOLDERS) {
      expect(
        sourceFiles(join(webDir, folder)).filter(
          (file) => !TEST_FILE.test(file)
        ).length,
        folder
      ).toBeGreaterThan(0);
    }
  });

  // A new folder of apps/web is either walked or listed here with the reason it holds no production code:
  // e2e*, poc and real-devices are browser and device tests that Vite never imports; scripts/ runs in Node at
  // build or check time; public/ (boot-retry.js, theme-init.js) is copied as it is and served without a bundle,
  // so no import in it reaches the build. The configs at the root of apps/web (`vite*.ts`, `playwright*.ts`,
  // `vitest*.ts`) are outside the walk too: it takes folders, and they run in Node, never in the bundle.
  it("leaves out of the walk only these folders of apps/web", () => {
    const NOT_WALKED = [
      "e2e",
      "e2e-agent",
      "e2e-pwa",
      "e2e-real",
      "poc",
      "public",
      "real-devices",
      "scripts",
    ];
    let listing: string;
    try {
      listing = execFileSync("git", ["ls-files", "-z", "apps/web"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(
        "git ls-files falhou: este teste lista as pastas de apps/web pelo git e precisa rodar dentro de um checkout com .git",
        { cause: error }
      );
    }
    const tracked = listing
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => path.slice("apps/web/".length))
      .filter((path) => path.includes("/"));
    const folders = [
      ...new Set(tracked.map((path) => path.split("/")[0])),
    ].sort();
    expect(folders).toEqual(
      [...TEST_LIBRARY_SCAN_FOLDERS, ...NOT_WALKED].sort()
    );
  });

  const scanTestLibraryTree = (webRoot: string, repoRoot?: string) =>
    TEST_LIBRARY_SCAN_FOLDERS.flatMap((folder) =>
      existsSync(join(webRoot, folder))
        ? sourceFiles(join(webRoot, folder)).flatMap((file) =>
            scanTestLibraryImports(
              file,
              readFileSync(file, "utf8").replace(COMMENT, ""),
              repoRoot
            ).map((finding) => `${folder}/${basename(file)}: ${finding.rule}`)
          )
        : []
    );

  // That the folders outside the list are not walked is proved by the `git ls-files` test above, which pins the
  // list of folders; this one only proves the walk reaches a nested file in each listed folder.
  it("a library planted in each folder of the list is found by the walk", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-lib-tree-"));
    try {
      for (const folder of TEST_LIBRARY_SCAN_FOLDERS) {
        const deep = join(dir, "apps/web", folder, "a");
        mkdirSync(deep, { recursive: true });
        writeFileSync(join(deep, "planted.ts"), 'import "happy-dom";');
        writeFileSync(join(deep, "planted.test.ts"), 'import "happy-dom";');
      }
      expect(scanTestLibraryTree(join(dir, "apps/web"), dir).sort()).toEqual([
        "legal/planted.ts: import of happy-dom",
        "pwa/planted.ts: import of happy-dom",
        "src/planted.ts: import of happy-dom",
        "worker/planted.ts: import of happy-dom",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a planted file in a subfolder, whatever its extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-lib-"));
    try {
      const deep = join(dir, "a/b");
      mkdirSync(deep, { recursive: true });
      for (const name of ["x.mts", "x.cts", "x.d.ts", "x.js"]) {
        writeFileSync(join(deep, name), 'import "happy-dom";');
      }
      const found = sourceFiles(dir).map((file) => basename(file));
      expect(found.sort()).toEqual(["x.cts", "x.d.ts", "x.js", "x.mts"]);
      for (const file of sourceFiles(dir)) {
        expect(
          scanTestLibraryImports(file, readFileSync(file, "utf8"), root),
          file
        ).toHaveLength(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no file of those folders outside the tests imports a test library", () => {
    const files = TEST_LIBRARY_SCAN_FOLDERS.flatMap((folder) =>
      sourceFiles(join(webDir, folder))
    );
    expect(sourceFiles(join(webDir, "src")).length).toBeGreaterThan(100);
    expect(files.some((file) => TEST_FILE.test(file))).toBe(true);
    expect(scanTestLibraryTree(webDir)).toEqual([]);
  });

  it("lists no exception, and every one it lists names an existing file and a reason", () => {
    expect(TEST_LIBRARY_EXCEPTIONS).toEqual([]);
    for (const { file, why } of TEST_LIBRARY_EXCEPTIONS) {
      expect(existsSync(join(root, file)), file).toBe(true);
      expect(why.length, file).toBeGreaterThan(0);
    }
  });

  describe("scanTestLibraryImports", () => {
    const catalog = join(root, "apps/web/src/catalog/planted.tsx");
    const plantedIn = (folder: string) =>
      join(root, `apps/web/${folder}/planted.ts`);
    const rules = (
      file: string,
      source: string,
      exceptions?: typeof TEST_LIBRARY_EXCEPTIONS
    ) =>
      scanTestLibraryImports(file, source, root, exceptions).map(
        (finding) => finding.rule
      );

    it.each([
      'import { render } from "@testing-library/react";',
      'import userEvent from "@testing-library/user-event";',
      'import { screen } from "@testing-library/dom";',
      'import { Window } from "happy-dom";',
      'import axe from "axe-core";',
      'export { render } from "@testing-library/react";',
      'const lib = await import("happy-dom");',
      'const lib = require("@testing-library/react");',
      'import "@testing-library/jest-dom";',
      'import { Window } from "happy-dom/lib/window";',
      'import { Window } from "../../node_modules/happy-dom/lib/index.js";',
      'import { render } from "../../../../node_modules/@testing-library/react";',
    ])("rejects a planted import in src/catalog: %s", (source) => {
      const found = rules(catalog, source);
      expect(found).toHaveLength(1);
      expect(found[0]?.startsWith("import of ")).toBe(true);
    });

    // The scan looks at the file, never at its folder, so this case would pass on any folder: the proof that the
    // walk reaches worker/, pwa/ and legal/ is the `toEqual` of TEST_LIBRARY_SCAN_FOLDERS, the planted tree and
    // the `git ls-files` check above.
    it.each([
      'import { render } from "@testing-library/react";',
      'import userEvent from "@testing-library/user-event";',
      'import { screen } from "@testing-library/dom";',
      'import { Window } from "happy-dom";',
      'import axe from "axe-core";',
      'export { render } from "@testing-library/react";',
      'const lib = await import("happy-dom");',
      'const lib = require("@testing-library/react");',
      'import "@testing-library/jest-dom";',
      'import { Window } from "happy-dom/lib/window";',
      'import { Window } from "../node_modules/happy-dom/lib/index.js";',
      'import { render } from "../../node_modules/@testing-library/react";',
    ])(
      "rejects a planted import in a file of worker, pwa and legal (the scan looks at the file, not the folder): %s",
      (source) => {
        for (const folder of ["worker", "pwa", "legal"]) {
          const found = rules(plantedIn(folder), source);
          expect(found, folder).toHaveLength(1);
          expect(found[0]?.startsWith("import of "), folder).toBe(true);
        }
      }
    );

    it("passes a file of worker, pwa and legal without the import, and lets their tests import", () => {
      for (const folder of ["worker", "pwa", "legal"]) {
        expect(
          rules(
            plantedIn(folder),
            'import { Hono } from "hono";\nimport { x } from "./x";'
          ),
          folder
        ).toEqual([]);
        expect(
          rules(
            join(root, `apps/web/${folder}/planted.test.ts`),
            'import { render } from "@testing-library/react";'
          ),
          folder
        ).toEqual([]);
      }
    });

    it("passes the same file without the import", () => {
      expect(
        rules(
          catalog,
          'import { useState } from "react";\nimport { cn } from "@/lib/utils";'
        )
      ).toEqual([]);
    });

    it("lets the tests import them, in `.test.` and `.spec.` files of any folder", () => {
      const source = 'import { render } from "@testing-library/react";';
      for (const name of [
        "a.test.tsx",
        "a.test.ts",
        "a.spec.tsx",
        "a.spec.ts",
      ]) {
        expect(rules(join(root, "apps/web/src/catalog", name), source)).toEqual(
          []
        );
      }
    });

    it("does not take a file that only has `test` in its name for a test", () => {
      const source = 'import { render } from "@testing-library/react";';
      for (const name of [
        "test-support.ts",
        "render-test-support.tsx",
        "a.test-utils.tsx",
        "latest.tsx",
      ]) {
        expect(rules(join(root, "apps/web/src/catalog", name), source)).toEqual(
          ["import of @testing-library/react"]
        );
      }
    });

    it("does not take a package that only starts with the same letters, nor a relative path, nor types", () => {
      expect(
        rules(
          catalog,
          [
            'import a from "happy-dom-fake";',
            'import b from "./happy-dom";',
            'import c from "../axe-core";',
            'import d from "@testing-library-fake/react";',
            'import e from "@types/d3-shape";',
          ].join("\n")
        )
      ).toEqual([]);
    });

    it("lets one exact file through, by its whole path, and only the file it names", () => {
      const source = 'import { render } from "@testing-library/react";';
      const exceptions = [
        { file: "apps/web/src/catalog/planted.tsx", why: "control" },
      ];
      expect(rules(catalog, source, exceptions)).toEqual([]);
      expect(
        rules(join(root, "apps/web/src/sales/planted.tsx"), source, exceptions)
      ).toEqual(["import of @testing-library/react"]);
      expect(
        rules(
          join(root, "apps/web/src/catalog/deep/planted.tsx"),
          source,
          exceptions
        )
      ).toEqual(["import of @testing-library/react"]);
      expect(
        rules(
          join(root, "apps/other/apps/web/src/catalog/planted.tsx"),
          source,
          exceptions
        )
      ).toEqual(["import of @testing-library/react"]);
    });

    it("covers every test library of the list and nothing but them", () => {
      for (const name of UI_TEST_PACKAGES.filter(
        (item) => !item.startsWith("@types/")
      )) {
        expect(rules(catalog, `import x from "${name}";`)).toEqual([
          `import of ${name}`,
        ]);
      }
    });
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

  // The backup workflow is renamed by a patch applied apart from the code, so the list holds exactly the name that
  // exists; the staging-only name goes away with the patch.
  const withoutInstallOrBuild = [
    workflows.includes("backup.yml") ? "backup.yml" : "backup-staging.yml",
  ];

  it("lists exactly the workflows that run no install or build step", () => {
    const found = workflows
      .filter((name) => {
        const text = readFileSync(join(workflowDir, name), "utf8");
        return readWorkflow(text, name).recognized === 0;
      })
      .sort();
    expect(found).toEqual(withoutInstallOrBuild);
  });

  it.each(workflows)(
    "%s: no secret in a step that installs or builds",
    (name) => {
      const text = readFileSync(join(workflowDir, name), "utf8");
      const { problems, recognized } = readWorkflow(text, name);
      expect(problems).toEqual([]);
      // A reader that recognizes nothing would pass any file: it must see the install it knows is there.
      if (!withoutInstallOrBuild.includes(name)) {
        expect(
          recognized,
          `${name}: no install or build step recognized`
        ).toBeGreaterThan(0);
      }
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
