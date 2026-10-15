import { describe, expect, it } from "vitest";
import { classifyChanges } from "./ci-changed.mjs";

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
});
