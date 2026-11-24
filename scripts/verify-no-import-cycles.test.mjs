import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const GUARD = fileURLToPath(
  new URL("./verify-no-import-cycles.mjs", import.meta.url)
);
const HEADER = "Circular runtime imports found:";
const SOURCE_SUFFIX = /\.tsx?$/;

const created = [];

afterEach(() => {
  for (const folder of created.splice(0)) {
    rmSync(folder, { force: true, recursive: true });
  }
});

/**
 * The guard derives the repository root from its own location, so each case
 * copies it to `<tmp>/scripts/`, plants the tree under `<tmp>/packages` and
 * `<tmp>/apps` (both must exist) and runs it there.
 */
function runGuard(files) {
  const root = mkdtempSync(path.join(tmpdir(), "polaris-import-cycles-"));
  created.push(root);
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "packages"));
  mkdirSync(path.join(root, "apps"));
  copyFileSync(GUARD, path.join(root, "scripts", "guard.mjs"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const result = spawnSync(process.execPath, ["scripts/guard.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function workspacePackage(name, exports) {
  return JSON.stringify({ exports, name: `@polaris/${name}` });
}

const ONE = "packages/lib/src/one.ts";
const TWO = "packages/lib/src/two.ts";

describe("verify-no-import-cycles", () => {
  it("passes a tree without a cycle and counts the source files", () => {
    const result = runGuard({
      [ONE]: 'import { two } from "./two";\nexport const one = two;\n',
      [TWO]: "export const two = 1;\n",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "No circular runtime imports across 2 source files."
    );
    expect(result.stderr).toBe("");
  });

  it("fails a relative cycle and names both files", () => {
    const result = runGuard({
      [ONE]: 'import { two } from "./two";\nexport const one = two;\n',
      [TWO]: 'import { one } from "./one";\nexport const two = one;\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(HEADER);
    expect(result.stderr).toContain(
      path.join("packages", "lib", "src", "one.ts")
    );
    expect(result.stderr).toContain(
      path.join("packages", "lib", "src", "two.ts")
    );
    expect(result.stdout).toBe("");
  });

  it("fails a cycle closed through a @polaris/<package>/<subpath> specifier", () => {
    const result = runGuard({
      "packages/a/package.json": workspacePackage("a", { "./x": "./src/x.ts" }),
      "packages/a/src/x.ts":
        'import { y } from "@polaris/b/y";\nexport const x = y;\n',
      "packages/b/package.json": workspacePackage("b", {
        "./y": { default: "./src/y.ts" },
      }),
      "packages/b/src/y.ts":
        'import { x } from "@polaris/a/x";\nexport const y = x;\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(HEADER);
    expect(result.stderr).toContain(path.join("packages", "a", "src", "x.ts"));
    expect(result.stderr).toContain(path.join("packages", "b", "src", "y.ts"));
  });

  it("does not follow a workspace specifier that the exports map does not list", () => {
    const result = runGuard({
      "packages/a/package.json": workspacePackage("a", { "./x": "./src/x.ts" }),
      "packages/a/src/x.ts":
        'import { y } from "@polaris/b/nao-exportado";\nexport const x = y;\n',
      "packages/b/package.json": workspacePackage("b", { "./y": "./src/y.ts" }),
      "packages/b/src/y.ts":
        'import { x } from "@polaris/a/x";\nexport const y = x;\n',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("across 2 source files.");
  });

  it("ignores an import type on one side of the loop", () => {
    const result = runGuard({
      [ONE]: 'import type { Two } from "./two";\nexport type One = Two;\n',
      [TWO]:
        'import { one } from "./one";\nexport const two = one;\nexport type Two = number;\n',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No circular runtime imports");
  });

  it("counts `export * from` as an edge", () => {
    const result = runGuard({
      [ONE]: 'export * from "./two";\n',
      [TWO]: 'import { one } from "./one";\nexport const two = one;\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(HEADER);
  });

  it("counts a dynamic import() as an edge", () => {
    const result = runGuard({
      [ONE]: 'export const load = () => import("./two");\n',
      [TWO]: 'import { load } from "./one";\nexport const two = load;\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(HEADER);
  });

  it("resolves a folder import to its index.ts", () => {
    const result = runGuard({
      [ONE]: 'import { two } from "./pasta";\nexport const one = two;\n',
      "packages/lib/src/pasta/index.ts":
        'import { one } from "../one";\nexport const two = one;\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(HEADER);
    expect(result.stderr).toContain(
      path.join("packages", "lib", "src", "pasta", "index.ts")
    );
  });

  // Each exclusion gets a cycle that exists only through the excluded file
  // (real.ts -> excluded -> real.ts), so the guard passes only while the
  // exclusion holds; the control plants the same loop under a name the guard
  // does read and must fail, proving the planted tree is a real cycle.
  function exclusionCycle(excludedFile, specifier) {
    return {
      "packages/lib/src/real.ts": `import { other } from "${specifier}";\nexport const real = other;\n`,
      [excludedFile]:
        'import { real } from "../real";\nexport const other = real;\n',
    };
  }

  const EXCLUDED_SUFFIXES = [
    { control: "ex.spec.ts", suffix: ".test.ts" },
    { control: "ex.spec.tsx", suffix: ".test.tsx" },
    { control: "ex.spec.ts", suffix: ".d.ts" },
    { control: "ex.spec.ts", suffix: ".gen.ts" },
  ];

  it.each(EXCLUDED_SUFFIXES)(
    "leaves a $suffix file out of the graph",
    ({ control, suffix }) => {
      const excluded = `ex${suffix}`;
      const tree = (name) =>
        exclusionCycle(
          `packages/lib/src/dir/${name}`,
          `./dir/${name.replace(SOURCE_SUFFIX, "")}`
        );

      const passed = runGuard(tree(excluded));
      expect(passed.status, `${suffix} must stay excluded`).toBe(0);
      expect(passed.stdout).toContain(
        "No circular runtime imports across 1 source files."
      );

      const failed = runGuard(tree(control));
      expect(failed.status, `control ${control} must form a cycle`).toBe(1);
      expect(failed.stderr).toContain(HEADER);
    }
  );

  const EXCLUDED_FOLDERS = [
    "node_modules",
    "dist",
    ".wrangler",
    "drizzle",
    "e2e",
  ];

  it.each(EXCLUDED_FOLDERS)(
    "leaves the %s folder out of the graph",
    (folder) => {
      const tree = (name) =>
        exclusionCycle(`packages/lib/src/${name}/ex.ts`, `./${name}/ex`);

      const passed = runGuard(tree(folder));
      expect(passed.status, `${folder} must stay excluded`).toBe(0);
      expect(passed.stdout).toContain(
        "No circular runtime imports across 1 source files."
      );

      const failed = runGuard(tree("pasta"));
      expect(failed.status, "control folder must form a cycle").toBe(1);
      expect(failed.stderr).toContain(HEADER);
    }
  );

  // `scripts/` holds the gates and their support modules, which import each
  // other; it is walked like `src`, and a `scripts` folder nested below a
  // walked folder is not skipped.
  const SCRIPTS_CYCLE = (folder) => ({
    "packages/a/src/ok.ts": "export const ok = 1;\n",
    [`${folder}/one.ts`]:
      'import { two } from "./two";\nexport const one = two;\n',
    [`${folder}/two.ts`]:
      'import { one } from "./one";\nexport const two = one;\n',
  });

  it.each(["packages/a/scripts", "apps/web/scripts"])(
    "fails a cycle in the %s folder",
    (folder) => {
      const result = runGuard(SCRIPTS_CYCLE(folder));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(HEADER);
      expect(result.stderr).toContain(path.join(folder, "one.ts"));
      expect(result.stderr).toContain(path.join(folder, "two.ts"));
    }
  );

  it("fails a cycle in a src/scripts/ folder", () => {
    const result = runGuard(SCRIPTS_CYCLE("packages/a/src/scripts"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(HEADER);
    expect(result.stderr).toContain(
      path.join("packages", "a", "src", "scripts", "one.ts")
    );
    expect(result.stderr).toContain(
      path.join("packages", "a", "src", "scripts", "two.ts")
    );
  });

  it("counts the scripts/ files of a package in the graph", () => {
    const result = runGuard({
      "packages/a/src/ok.ts": "export const ok = 1;\n",
      "packages/a/scripts/gate.ts":
        'import { ok } from "../src/ok";\nexport const gate = ok;\n',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "No circular runtime imports across 2 source files."
    );
  });
});
