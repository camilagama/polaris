import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { helpTipTextProblem } from "../src/ui/help-tip-text";

/**
 * Every `HelpTip` written with a literal text in `src/` stays within the limits of DESIGN.md, "Texto curto". It lives
 * here and not in `src/ui/` because it reads the source tree, and `src/ui/` may import no Node module
 * (scripts/ui-supply-chain.test.ts).
 */
const src = fileURLToPath(new URL("../src", import.meta.url));

/** The `.tsx` files under `dir`, tests aside. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sources(path);
    }
    return path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

// a HelpTip whose children are one string literal: `<HelpTip about="…">texto</HelpTip>`
const LITERAL_HELP_TIP = /<HelpTip\b[^>]*>\s*([^<>{}]+?)\s*<\/HelpTip>/g;
const WHITESPACE = /\s+/g;

describe("os HelpTip escritos no código", () => {
  it("têm texto dentro do limite", () => {
    const problems: string[] = [];
    let found = 0;
    for (const file of sources(src)) {
      for (const match of readFileSync(file, "utf8").matchAll(
        LITERAL_HELP_TIP
      )) {
        found += 1;
        const problem = helpTipTextProblem(
          (match[1] ?? "").replace(WHITESPACE, " ")
        );
        if (problem) {
          problems.push(`${file}: ${problem}`);
        }
      }
    }
    // the gallery has at least one, so the scan cannot pass by finding none
    expect(found).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
