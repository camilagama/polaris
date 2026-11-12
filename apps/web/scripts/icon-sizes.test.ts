import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The icon scale of the app is 12, 16 and 18 px (DESIGN.md, rule 11), so a Lucide icon is never `size-3.5` (14 px),
 * on the icon itself or through a rule on the `svg` of its button (`[&_svg]:size-3.5`). The scan reads every
 * `.tsx` of `src` and the list of what may keep 14 px is exact by file and number of uses: the Google "G", a brand
 * mark and not a Lucide icon. An entry nothing uses, or used once more, fails.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
const FOURTEEN_PX = /(?<![\w-])(?:[^\s"'`]*:)?size-3\.5(?![\w.-])/g;

const BRAND_MARKS: Readonly<Record<string, number>> = {
  "sign-in/entry-ui.tsx": 1,
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return entry.name.endsWith(".tsx") && !TEST_FILE.test(entry.name)
      ? [path]
      : [];
  });
}

export function fourteenPxUses(text: string): string[] {
  return text.match(FOURTEEN_PX) ?? [];
}

function usesByFile(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const path of sources(SRC)) {
    const count = fourteenPxUses(readFileSync(path, "utf8")).length;
    if (count > 0) {
      found[relative(SRC, path).split(sep).join("/")] = count;
    }
  }
  return found;
}

describe("nenhum ícone de 14 px (regra 11)", () => {
  it("só o G do Google guarda size-3.5, e a lista é exata", () => {
    expect(usesByFile()).toEqual(BRAND_MARKS);
  });

  it("o controle pega o ícone, a regra do svg do botão e a variante, e deixa passar o resto", () => {
    expect(fourteenPxUses('<X className="size-3.5 shrink-0" />')).toEqual([
      "size-3.5",
    ]);
    expect(fourteenPxUses('className="inline-flex [&_svg]:size-3.5"')).toEqual([
      "[&_svg]:size-3.5",
    ]);
    expect(fourteenPxUses('className="sm:size-3.5"')).toEqual(["sm:size-3.5"]);
    expect(
      fourteenPxUses(
        'className="size-4 size-3 size-35 size-3.55 text-size-3.5 [&_svg]:size-4"'
      )
    ).toEqual([]);
  });

  it("a varredura lê os três lugares que saíram dos 14 px", () => {
    const read = (path: string) => readFileSync(join(SRC, path), "utf8");
    for (const path of [
      "ui/sidebar.tsx",
      "sign-in/new-password-field.tsx",
      "sales/sale-item-editor.tsx",
    ]) {
      expect(read(path).length, path).toBeGreaterThan(0);
      expect(fourteenPxUses(read(path)), path).toEqual([]);
    }
  });
});
