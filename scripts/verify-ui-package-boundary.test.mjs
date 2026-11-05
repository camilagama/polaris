import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FRAMEWORKS = ["react", "react-dom"];
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function frameworksDeclared(manifest) {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    FRAMEWORKS.filter((name) => manifest[field]?.[name] !== undefined).map(
      (name) => `${field}: ${name}`
    )
  );
}

describe("packages/ui declares no framework (the import side is the Biome rule checked by verify-import-boundaries.mjs)", () => {
  it("the real manifest has no react or react-dom", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../packages/ui/package.json", import.meta.url),
        "utf8"
      )
    );
    expect(
      frameworksDeclared(manifest),
      "packages/ui is shared with the Admin page, which has no React: keep components in apps/web/src/ui and leave only tokens and constants here"
    ).toEqual([]);
  });

  it("control: a manifest that adds react or react-dom in any field is reported", () => {
    expect(
      frameworksDeclared({
        dependencies: { react: "19.0.0" },
        devDependencies: { "react-dom": "19.0.0" },
        optionalDependencies: { "react-dom": "^19" },
        peerDependencies: { react: "^19" },
      })
    ).toEqual([
      "dependencies: react",
      "devDependencies: react-dom",
      "peerDependencies: react",
      "optionalDependencies: react-dom",
    ]);
  });

  it("control: other dependencies are left alone", () => {
    expect(
      frameworksDeclared({ dependencies: { "tw-animate-css": "1.0.0" } })
    ).toEqual([]);
  });
});
