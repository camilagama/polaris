import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The contrast map of the v5.1 tokens (docs/design/contraste-v5.1.md, ADR 0103): every pair of the two tables is
 * measured again from theme.css, OKLCH to sRGB, WCAG 2.x. A pair fails below its target or when it drifts from
 * the ratio the document states, so a token change cannot leave the map behind.
 */
const theme = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
const map = readFileSync(
  new URL("../../../../docs/design/contraste-v5.1.md", import.meta.url),
  "utf8"
);

type Rgb = [number, number, number];
const OKLCH =
  /--([a-z0-9-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)/g;

function block(selector: string) {
  const start = theme.indexOf(`${selector} {`);
  return theme.slice(start, theme.indexOf("\n}", start));
}

function tokens(css: string) {
  const values = new Map<string, { alpha: number; rgb: Rgb }>();
  for (const match of css.matchAll(OKLCH)) {
    const [, name, l, c, h, alpha] = match;
    values.set(name as string, {
      alpha: alpha === undefined ? 1 : Number(alpha),
      rgb: oklchToSrgb(Number(l), Number(c), Number(h)),
    });
  }
  return values;
}

/** OKLCH to gamma-encoded sRGB in [0, 1] (Björn Ottosson's OKLab matrices), clipped to the gamut. */
function oklchToSrgb(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m_ = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s_ = (l - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  const linear = [
    4.076_741_662_1 * l_ - 3.307_711_591_3 * m_ + 0.230_969_929_2 * s_,
    -1.268_438_004_6 * l_ + 2.609_757_401_1 * m_ - 0.341_319_396_5 * s_,
    -0.004_196_086_3 * l_ - 0.703_418_614_7 * m_ + 1.707_614_701 * s_,
  ];
  return linear.map((value) => {
    const v = Math.min(1, Math.max(0, value));
    return v <= 0.003_130_8 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

function luminance([r, g, b]: Rgb) {
  const channel = (v: number) =>
    v <= 0.040_45 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const over = (top: Rgb, alpha: number, bottom: Rgb): Rgb =>
  top.map((v, i) => alpha * v + (1 - alpha) * (bottom[i] as number)) as Rgb;

const CELL = /^`([a-z0-9-]+)(?:\/(\d+) sobre ([a-z0-9-]+))?`$/;

function color(cell: string, palette: ReturnType<typeof tokens>): Rgb {
  const [, name, percent, base] = CELL.exec(cell) ?? [];
  const top = palette.get(name as string);
  if (!top) {
    throw new Error(`unknown token in ${cell}`);
  }
  if (percent === undefined) {
    return top.rgb;
  }
  const bottom = palette.get(base as string);
  if (!bottom) {
    throw new Error(`unknown token in ${cell}`);
  }
  return over(top.rgb, Number(percent) / 100, bottom.rgb);
}

function ratio(a: Rgb, b: Rgb) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

function pairs(section: string) {
  const start = map.indexOf(`## ${section}`);
  const end = map.indexOf("\n## ", start + 1);
  return map
    .slice(start, end === -1 ? undefined : end)
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return {
        background: cells[1]?.split(" / ")[1] as string,
        expected: Number(cells[4]?.replaceAll("*", "")),
        foreground: cells[1]?.split(" / ")[0] as string,
        target: Number(cells[5]),
        use: cells[2] as string,
      };
    });
}

describe.each([
  ["Tema claro", tokens(block(":root"))],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
  ],
])("contraste da v5.1, %s", (section, palette) => {
  const rows = pairs(section);

  it("reads the table of the document", () => {
    expect(rows.length).toBeGreaterThan(50);
  });

  it.each(rows)(
    "$foreground / $background ($use): at least $target, as documented ($expected)",
    (row) => {
      const measured = ratio(
        color(row.foreground, palette),
        color(row.background, palette)
      );
      expect(measured).toBeGreaterThanOrEqual(row.target);
      expect(Math.abs(measured - row.expected)).toBeLessThanOrEqual(0.1);
    }
  );
});

/**
 * The two colors of the charts of src/ui/charts/ (t285): the ink (`--chart-5`, the series) and the middle gray
 * (`--chart-3`, the dashed second series and the third part of a bar), each over the card they are drawn on. Both pairs
 * are rows of the tables above; this one says they cannot be taken out of the map, and holds them to the bar of a graphic
 * element (WCAG 1.4.11, 3:1) with the ink held to the 4.5:1 of text, since the line carries the series for whoever
 * cannot tell the gradient apart.
 */
describe.each([
  ["Tema claro", tokens(block(":root"))],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
  ],
])("contraste dos gráficos, %s", (section, palette) => {
  const rows = pairs(section);

  it.each([
    ["`chart-3`", 3],
    ["`chart-5`", 4.5],
  ] as const)(
    "%s / `card` is in the map and reaches %d:1",
    (foreground, bar) => {
      const row = rows.find(
        (item) => item.foreground === foreground && item.background === "`card`"
      );
      expect(row, `${foreground} / card is not in "${section}"`).toBeDefined();
      expect(
        ratio(color(foreground, palette), color("`card`", palette))
      ).toBeGreaterThanOrEqual(bar);
    }
  );
});
