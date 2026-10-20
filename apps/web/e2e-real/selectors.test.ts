import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The journeys survive a redesign (T-125a §8): roles, labels and texts only. A CSS class or id, `nth`, a chained
 * `>>` selector or XPath fails here; `data-testid` only with a comment on the line before saying why no role or
 * label exists.
 */
const root = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN: [RegExp, string][] = [
  [/locator\(\s*["'`]\./, "CSS class"],
  [/locator\(\s*["'`]#/, "CSS id"],
  [/\.nth\(/, "nth"],
  [/locator\(\s*["'`][^"'`]*>>/, "chained selector"],
  [/xpath=/, "XPath"],
  [/nth-child/, "nth-child"],
];

export function selectorViolations(source: string): string[] {
  const lines = source.split("\n");
  const found: string[] = [];
  for (const [index, line] of lines.entries()) {
    for (const [pattern, name] of FORBIDDEN) {
      if (pattern.test(line)) {
        found.push(`${index + 1}: ${name}`);
      }
    }
    if (/data-testid|getByTestId/.test(line) && !/^\s*\/\/|\/\*/.test(lines[index - 1] ?? "")) {
      found.push(`${index + 1}: data-testid without a comment`);
    }
  }
  return found;
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the selectors of the e2e journeys", () => {
  it("use roles, labels and texts only", () => {
    const files = sources(root);
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((file) =>
      selectorViolations(readFileSync(file, "utf8")).map((violation) => `${relative(root, file)}:${violation}`)
    );
    expect(found).toEqual([]);
  });

  it("would catch each forbidden form (control)", () => {
    expect(selectorViolations('page.locator(".sale-total")')).toEqual(["1: CSS class"]);
    expect(selectorViolations("page.locator('#sale-method')")).toEqual(["1: CSS id"]);
    expect(selectorViolations('page.getByRole("row").nth(2)')).toEqual(["1: nth"]);
    expect(selectorViolations('page.locator("form >> button")')).toEqual(["1: chained selector"]);
    expect(selectorViolations('page.locator("xpath=//dd")')).toEqual(["1: XPath"]);
    expect(selectorViolations('page.getByTestId("total")')).toEqual(["1: data-testid without a comment"]);
    expect(selectorViolations('// no role nor label here: the chart canvas\npage.getByTestId("chart")')).toEqual([]);
  });
});
