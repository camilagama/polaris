import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The icon scale of the app is 12, 16 and 18 px (DESIGN.md, rule 11), so a Lucide icon is never `size-3.5` (14 px),
 * on the icon itself or through a rule on the `svg` of its button (`[&_svg]:size-3.5`). The same 14 px written as
 * `h-3.5 w-3.5` or `h-[14px] w-[14px]` counts as ONE use when both sit in the same element (text between `<`, `>` and
 * `;`, so `cn("h-3.5", on && "w-3.5")` pairs too) with the same variant prefix; a lone `h-3.5` or `w-3.5` is a line of
 * a skeleton or a bar, not a square icon, and does not count. The scan reads every
 * `.tsx` of `src` and the list of what may keep 14 px is exact by file and number of uses: the Google "G", a brand
 * mark and not a Lucide icon. An entry nothing uses, or used once more, fails.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
const FOURTEEN_PX =
  /(?<![\w-])((?:[^\s"'`]*:)?)!?(size|[hw])-(?:3\.5|\[14px\])(?![\w.-])/g;
const DOLLAR = "$";
const ELEMENT_BOUNDARY = /[;<>]/;

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

function elementUses(element: string): string[] {
  const uses: string[] = [];
  const pairs = new Map<string, { h: string[]; w: string[] }>();
  for (const [token, variant, axis] of element.matchAll(FOURTEEN_PX)) {
    if (axis === "size") {
      uses.push(token);
      continue;
    }
    const pair = pairs.get(variant) ?? { h: [], w: [] };
    pair[axis as "h" | "w"].push(token);
    pairs.set(variant, pair);
  }
  for (const { h, w } of pairs.values()) {
    for (let index = 0; index < Math.min(h.length, w.length); index += 1) {
      uses.push(`${h[index]} ${w[index]}`);
    }
  }
  return uses;
}

export function fourteenPxUses(text: string): string[] {
  return text.split(ELEMENT_BOUNDARY).flatMap(elementUses);
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
  it("só o G do Google guarda 14 px, e a lista é exata", () => {
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
    expect(fourteenPxUses('className="size-[14px]"')).toEqual(["size-[14px]"]);
    expect(
      fourteenPxUses(
        'className="size-4 size-3 size-35 size-3.55 text-size-3.5 [&_svg]:size-4"'
      )
    ).toEqual([]);
  });

  it("h e w de 14 px na mesma classe contam um uso, com e sem variante", () => {
    expect(fourteenPxUses('<X className="h-3.5 w-3.5 shrink-0" />')).toEqual([
      "h-3.5 w-3.5",
    ]);
    expect(fourteenPxUses('className="w-3.5 h-3.5"')).toEqual(["h-3.5 w-3.5"]);
    expect(fourteenPxUses('className="h-[14px] w-[14px]"')).toEqual([
      "h-[14px] w-[14px]",
    ]);
    expect(fourteenPxUses('className="h-3.5 w-[14px]"')).toEqual([
      "h-3.5 w-[14px]",
    ]);
    expect(fourteenPxUses('className="md:h-3.5 md:w-3.5"')).toEqual([
      "md:h-3.5 md:w-3.5",
    ]);
    expect(
      fourteenPxUses('className="[&_svg]:h-3.5 [&_svg]:w-3.5 flex"')
    ).toEqual(["[&_svg]:h-3.5 [&_svg]:w-3.5"]);
    expect(
      fourteenPxUses('className="h-3.5 w-3.5 md:h-[14px] md:w-[14px]"')
    ).toEqual(["h-3.5 w-3.5", "md:h-[14px] md:w-[14px]"]);
    expect(
      fourteenPxUses(
        '<a className="h-3.5 w-3.5" /><b className="h-3.5 w-3.5" />'
      )
    ).toEqual(["h-3.5 w-3.5", "h-3.5 w-3.5"]);
  });

  it("h e w em strings separadas do mesmo elemento, com aspas na variante e com ! contam", () => {
    expect(
      fourteenPxUses('className={cn("h-3.5", active && "w-3.5")}')
    ).toEqual(["h-3.5 w-3.5"]);
    expect(
      fourteenPxUses(`className={\`h-3.5 ${DOLLAR}{on ? "a" : "b"} w-3.5\`}`)
    ).toEqual(["h-3.5 w-3.5"]);
    expect(
      fourteenPxUses(
        `className="[&_svg:not([class*='size-'])]:h-3.5 [&_svg:not([class*='size-'])]:w-3.5"`
      )
    ).toEqual(["])]:h-3.5 ])]:w-3.5"]);
    expect(fourteenPxUses('className="!h-3.5 !w-3.5"')).toEqual([
      "!h-3.5 !w-3.5",
    ]);
    expect(fourteenPxUses('className="md:!h-3.5 md:!w-3.5"')).toEqual([
      "md:!h-3.5 md:!w-3.5",
    ]);
    expect(fourteenPxUses('className="h-3.5! w-3.5!"')).toEqual([
      "h-3.5 w-3.5",
    ]);
    expect(fourteenPxUses('className="md:!h-3.5 w-3.5"')).toEqual([]);
  });

  it("h ou w de 14 px sozinho, variantes que não casam e números parecidos não contam", () => {
    expect(fourteenPxUses('<hr className="h-3.5 bg-border" />')).toEqual([]);
    expect(fourteenPxUses('<Skeleton className="h-3.5 w-48" />')).toEqual([]);
    expect(fourteenPxUses('className="w-[14px] truncate"')).toEqual([]);
    expect(fourteenPxUses('className="h-3.5 md:w-3.5"')).toEqual([]);
    expect(
      fourteenPxUses('<a className="h-3.5" /><b className="w-3.5" />')
    ).toEqual([]);
    expect(
      fourteenPxUses(
        'className="h-3.55 w-3.55 h-35 w-35 min-h-3.5 min-w-3.5 max-h-[14px] max-w-[14px] h-4 w-4"'
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
