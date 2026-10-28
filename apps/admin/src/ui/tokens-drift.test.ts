import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Admin page copies a few colour tokens of the store's app instead of importing its sheet (the Admin's import
 * boundary, D-2). This keeps the copy honest: every token the Admin declares has the app's value, light and dark.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const admin = read("../../ui/admin.css");
const theme = read("../../../web/src/styles/theme.css");

const DECLARATION = /(--[\w-]+)\s*:\s*([^;]+);/g;
const ADMIN_LIGHT = /^:root\s*\{([^}]*)\}/m;
const ADMIN_DARK =
  /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/;
const THEME_LIGHT = /^:root\s*\{([^}]*)\}/m;
const THEME_DARK = /^\.dark\s*\{([^}]*)\}/m;
const COMMENT = /\/\*[\s\S]*?\*\//g;

function tokens(css: string, block: RegExp): Map<string, string> {
  const body = block.exec(css.replaceAll(COMMENT, ""))?.[1] ?? "";
  return new Map(
    [...body.matchAll(DECLARATION)].map(([, name, value]) => [
      name as string,
      (value as string).trim(),
    ])
  );
}

describe("the Admin's copy of the app's tokens", () => {
  it.each([
    ["light", ADMIN_LIGHT, THEME_LIGHT],
    ["dark", ADMIN_DARK, THEME_DARK],
  ] as const)(
    "has the app's %s values for every token it declares",
    (_theme, adminBlock, themeBlock) => {
      const copied = tokens(admin, adminBlock);
      const source = tokens(theme, themeBlock);
      // the copy is not empty, and names only tokens the app has
      expect(copied.size).toBeGreaterThan(8);
      expect([...copied.keys()].filter((name) => !source.has(name))).toEqual(
        []
      );
      expect(Object.fromEntries(copied)).toEqual(
        Object.fromEntries(
          [...copied.keys()].map((name) => [name, source.get(name)])
        )
      );
    }
  );

  it("would see a drift (a changed value is told apart)", () => {
    const drifted = admin.replace(
      "--foreground: oklch(0.2 0.005 85);",
      "--foreground: oklch(0.21 0.005 85);"
    );
    expect(drifted).not.toBe(admin);
    expect(tokens(drifted, ADMIN_LIGHT).get("--foreground")).not.toBe(
      tokens(theme, THEME_LIGHT).get("--foreground")
    );
  });
});
