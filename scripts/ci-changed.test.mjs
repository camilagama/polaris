import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyChanges } from "./ci-changed.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED_FOLDERS = new Set([
  "node_modules",
  "dist",
  ".wrangler",
  ".turbo",
]);

function sourceFiles(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_FOLDERS.has(entry.name) ? [] : sourceFiles(full);
    }
    return SOURCE_FILE.test(entry.name) ? [full] : [];
  });
}

/** Module specifiers of static, dynamic, re-exported and required imports. */
function importSpecifiers(source) {
  const found = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    found.push(match[1]);
  }
  return found;
}

/** True when `specifier`, written in `file`, reaches the Admin app. */
function reachesAdminApp(file, specifier) {
  if (
    specifier === "@polaris/admin" ||
    specifier.startsWith("@polaris/admin/")
  ) {
    return true;
  }
  if (!specifier.startsWith(".")) {
    return false;
  }
  const target = path.relative(
    root,
    path.resolve(path.dirname(file), specifier)
  );
  return target === "apps/admin" || target.startsWith("apps/admin/");
}

/** Every file outside apps/admin that imports the Admin app, or declares it as a dependency. */
function adminDependents() {
  const folders = ["apps/web", "apps/catalog", "packages"];
  const hits = [];
  for (const folder of folders) {
    for (const file of sourceFiles(path.join(root, folder))) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (reachesAdminApp(file, specifier)) {
          hits.push(`${path.relative(root, file)} -> ${specifier}`);
        }
      }
    }
  }
  const manifests = [
    "apps/web/package.json",
    "apps/catalog/package.json",
    ...readdirSync(path.join(root, "packages")).map(
      (name) => `packages/${name}/package.json`
    ),
  ];
  for (const manifest of manifests) {
    if (
      readFileSync(path.join(root, manifest), "utf8").includes("@polaris/admin")
    ) {
      hits.push(`${manifest} -> @polaris/admin`);
    }
  }
  return hits;
}

describe("which CI jobs a change affects", () => {
  it("runs everything when the changed files are unknown", () => {
    expect(classifyChanges(null)).toEqual({
      browser: true,
      dependencies: true,
    });
  });

  it("skips the browser gate and the audit for prose only", () => {
    expect(
      classifyChanges([
        "docs/adr/0059-x.md",
        "doc/status-implementacao.md",
        "DESIGN.md",
        "",
      ])
    ).toEqual({ browser: false, dependencies: false });
  });

  it("skips the browser gate for the database package, whose code the web client never bundles", () => {
    expect(
      classifyChanges([
        "packages/db/src/media-repository.ts",
        "packages/db/scripts/verify-x-gate.ts",
        "packages/db/drizzle/0051_x.sql",
      ])
    ).toEqual({ browser: false, dependencies: false });
  });

  it("skips the browser gate for the web app's server, Worker and gate scripts, which it never runs", () => {
    expect(
      classifyChanges([
        "apps/web/src/server/routes/media.ts",
        "apps/web/src/server/media-reconciler.test.ts",
        "apps/web/worker/index.ts",
        "apps/web/scripts/verify-offline-e2e-gate.ts",
      ])
    ).toEqual({ browser: false, dependencies: false });
    // the client next to them is still covered
    expect(
      classifyChanges([
        "apps/web/src/server/routes/media.ts",
        "apps/web/src/lib/media-upload.ts",
      ]).browser
    ).toBe(true);
  });

  it("runs the browser gate when the web app, a shared package or the workflow changes", () => {
    for (const file of [
      "apps/web/src/catalog/product-media-panel.tsx",
      "packages/domain/src/billing/entitlements.ts",
      "packages/contracts/src/index.ts",
      ".github/workflows/ci.yml",
      "scripts/ci-changed.mjs",
    ]) {
      expect(classifyChanges(["docs/a.md", file]).browser).toBe(true);
    }
  });

  it("runs the audit when dependencies can change, wherever the manifest is", () => {
    for (const file of [
      "package.json",
      "bun.lock",
      "apps/web/package.json",
      "packages/db/package.json",
      ".bun-version",
    ]) {
      expect(classifyChanges([file]).dependencies).toBe(true);
    }
    expect(classifyChanges(["apps/web/src/x.ts"]).dependencies).toBe(false);
  });

  it("treats a lockfile change as relevant to the browser gate even next to database changes", () => {
    expect(
      classifyChanges(["packages/db/package.json", "bun.lock"]).browser
    ).toBe(true);
  });

  it("skips the browser gate for the Admin app, which neither the web client nor the catalog imports", () => {
    expect(
      classifyChanges([
        "apps/admin/src/app.ts",
        "apps/admin/src/app.test.ts",
        "apps/admin/wrangler.jsonc",
        "apps/admin/package.json",
      ])
    ).toEqual({ browser: false, dependencies: true });
    expect(classifyChanges(["apps/admin/src/app.ts"])).toEqual({
      browser: false,
      dependencies: false,
    });
  });

  it("keeps running the browser gate for what the Admin change does not cover", () => {
    // the sibling apps and the shared packages are still bundled by the gate
    for (const file of [
      "apps/web/src/lib/x.ts",
      "apps/catalog/src/x.ts",
      "packages/domain/src/x.ts",
      "apps/administrative/src/x.ts",
      "apps/admin-extra/src/x.ts",
      "bun.lock",
    ]) {
      expect(classifyChanges([file]).browser).toBe(true);
    }
  });

  it("runs the browser gate when an Admin change comes with a relevant one", () => {
    expect(
      classifyChanges(["apps/admin/src/app.ts", "apps/web/src/lib/x.ts"])
        .browser
    ).toBe(true);
    expect(
      classifyChanges([
        "apps/admin/src/app.ts",
        "packages/db/src/x.ts",
        "docs/a.md",
      ]).browser
    ).toBe(false);
    expect(
      classifyChanges(["apps/admin/src/app.ts", "packages/ui/src/x.tsx"])
        .browser
    ).toBe(true);
  });
});

// The proof behind the apps/admin entry in BROWSER_IRRELEVANT: the browser gate
// builds apps/web and apps/catalog (and the packages they use), so skipping it
// for apps/admin is only sound while none of them reaches the Admin app. If this
// fails, remove the entry instead of weakening the test.
describe("the Admin app is outside the browser gate's import graph", () => {
  it("is imported by nothing in apps/web, apps/catalog or packages/", () => {
    expect(adminDependents()).toEqual([]);
  });

  it("recognises the ways an import can reach the Admin app", () => {
    const file = path.join(root, "apps/web/src/lib/x.ts");
    expect(importSpecifiers('import { a } from "@polaris/admin";')).toEqual([
      "@polaris/admin",
    ]);
    expect(importSpecifiers('export * from "../../../admin/src/app";')).toEqual(
      ["../../../admin/src/app"]
    );
    expect(
      importSpecifiers('const m = await import("@polaris/admin/x");')
    ).toEqual(["@polaris/admin/x"]);
    expect(importSpecifiers('import "../../admin/src/side-effect";')).toEqual([
      "../../admin/src/side-effect",
    ]);
    expect(reachesAdminApp(file, "@polaris/admin")).toBe(true);
    expect(reachesAdminApp(file, "@polaris/admin/src/app")).toBe(true);
    expect(reachesAdminApp(file, "../../../admin/src/app")).toBe(true);
    expect(reachesAdminApp(file, "../../../admin")).toBe(true);
    // the domain's own "admin/*" subpaths and sibling folders are not the app
    expect(reachesAdminApp(file, "@polaris/domain/admin/access-log")).toBe(
      false
    );
    expect(reachesAdminApp(file, "./admin/x")).toBe(false);
    expect(reachesAdminApp(file, "../../../admin-extra/x")).toBe(false);
  });
});
