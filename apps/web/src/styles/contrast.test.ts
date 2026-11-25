import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The contrast map of the v5.1 tokens (docs/design/contraste-v5.1.md, ADR 0103): every pair of the two tables is
 * measured again from theme.css, OKLCH to sRGB, WCAG 2.x. A pair fails below its target or when it drifts from
 * the ratio the document states, so a token change cannot leave the map behind.
 */
const theme = readFileSync(
  new URL("../../../../packages/ui/src/theme.css", import.meta.url),
  "utf8"
);
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

const CELL = /^`([a-z0-9-]+)(?:\/(\d+))?(?: sobre ([a-z0-9-]+))?`$/;

function color(cell: string, palette: ReturnType<typeof tokens>): Rgb {
  const [, name, percent, base] = CELL.exec(cell) ?? [];
  const top = palette.get(name as string);
  if (!top) {
    throw new Error(`unknown token in ${cell}`);
  }
  if (base === undefined) {
    return top.rgb;
  }
  const bottom = palette.get(base);
  if (!bottom) {
    throw new Error(`unknown token in ${cell}`);
  }
  // `x/NN sobre y` is the utility with an opacity; `x sobre y` is a token that carries its own alpha (the dark borders)
  const alpha = percent === undefined ? top.alpha : Number(percent) / 100;
  return over(top.rgb, alpha, bottom.rgb);
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
 * The two colors of the charts of src/ui/charts/: the ink (`--chart-5`, the series) and the middle gray
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
    // the hatch of an unknown day (Resultado, AC-9): it always comes with words, and still reaches the bar of a graphic
    ["`chart-unknown`", 3],
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

/**
 * The bar of "Por categoria" (Despesas): `--chart-2`, the color of the expenses in the bar of parts of the Resultado,
 * over the `--muted` track it grows on. The bar is a drawing beside the written name, share and amount, and still
 * reaches the 3:1 of a graphic element (WCAG 1.4.11) in both themes.
 */
describe.each([
  ["Tema claro", tokens(block(":root"))],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
  ],
])("contraste da barra de Por categoria, %s", (section, palette) => {
  it("`chart-2` / `muted` is in the map and reaches 3:1", () => {
    const row = pairs(section).find(
      (item) => item.foreground === "`chart-2`" && item.background === "`muted`"
    );
    expect(row, `chart-2 / muted is not in "${section}"`).toBeDefined();
    expect(
      ratio(color("`chart-2`", palette), color("`muted`", palette))
    ).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The step of the hour of the "Primeiros passos" (Início): its icon is `primary` (ink) over the tint of the circle
 * (`primary/10`) and its border is `primary` over the card, never the brand red (which reads as an error in a box).
 * Both pairs are rows of the tables above; this one says they cannot leave the map, and holds the icon to the 4.5:1 of
 * text and the border to the 3:1 of a graphic element.
 */
describe.each([
  ["Tema claro", tokens(block(":root"))],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
  ],
])("contraste do passo atual, %s", (section, palette) => {
  const rows = pairs(section);

  it.each([
    ["`primary`", "`primary/10 sobre card`", 4.5],
    ["`primary`", "`card`", 3],
  ] as const)(
    "%s / %s is in the map and reaches %d:1",
    (foreground, background, bar) => {
      const row = rows.find(
        (item) =>
          item.foreground === foreground && item.background === background
      );
      expect(
        row,
        `${foreground} / ${background} is not in "${section}"`
      ).toBeDefined();
      expect(
        ratio(color(foreground, palette), color(background, palette))
      ).toBeGreaterThanOrEqual(bar);
    }
  );
});

/**
 * The ring and the box of the "Primeiros passos" (menu and Início): the arc of the ring is ink over the sidebar and over
 * the card, the check is ink over `primary/10`, and the words of a done step are `muted-foreground` over the soft row
 * (`muted/50`). The drawings are graphic elements (3:1, WCAG 1.4.11) and the words are text (4.5:1). Each pair is a row of
 * the tables above; this one says they cannot leave the map.
 */
describe.each([
  ["Tema claro", tokens(block(":root"))],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
  ],
])("contraste do anel e do passo feito, %s", (section, palette) => {
  const rows = pairs(section);

  it.each([
    ["`primary`", "`sidebar`", 3],
    ["`primary`", "`card`", 3],
    ["`primary`", "`primary/10 sobre card`", 3],
    ["`muted-foreground`", "`muted/50 sobre card`", 4.5],
  ] as const)(
    "%s / %s reaches %d:1 and is in the map",
    (foreground, background, bar) => {
      const row = rows.find(
        (item) =>
          item.foreground === foreground && item.background === background
      );
      expect(
        row,
        `${foreground} / ${background} is not in "${section}"`
      ).toBeDefined();
      expect(
        ratio(color(foreground, palette), color(background, palette))
      ).toBeGreaterThanOrEqual(bar);
    }
  );
});

/**
 * The timeline of the sale detail (src/sales/sale-timeline.tsx), over the card: the word in `card-foreground` and the
 * time in `muted-foreground` are text (4.5:1), and the three dots (the sale's `chart-sales`, `destructive`, and the
 * supporting `muted-foreground`) are graphic elements that carry no meaning alone (WCAG 1.4.11, 3:1). Each pair is a row
 * of the tables above, so a token change that breaks one is read there too.
 */
describe.each([
  ["Tema claro", tokens(block(":root"))],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
  ],
])("contraste da linha do tempo da venda, %s", (section, palette) => {
  const rows = pairs(section);

  it.each([
    ["`card-foreground`", "texto do evento", 4.5],
    ["`muted-foreground`", "hora do evento", 4.5],
    ["`muted-foreground`", "ponto neutro", 3],
    ["`chart-sales`", "ponto da venda", 3],
    ["`destructive`", "ponto da venda cancelada", 3],
  ] as const)(
    "%s / `card` (%s) reaches %d:1 and is in the map",
    (foreground, _use, bar) => {
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

/**
 * The `--input` border of a field on the `--muted` strip (the lowered block inside a card), which sits lighter than the
 * card in the dark. It is a graphic element (WCAG 1.4.11, 3:1); with `--input` at L 0.55 it measured 2.81.
 */
describe("contraste do contorno do campo sobre muted, tema escuro", () => {
  const palette = new Map([
    ...tokens(block(":root")),
    ...tokens(block(".dark")),
  ]);
  const rows = pairs("Tema escuro");

  it("`input` / `muted` reaches 3:1 and is in the map", () => {
    const row = rows.find(
      (item) => item.foreground === "`input`" && item.background === "`muted`"
    );
    expect(row, "input / `muted` is not in the map").toBeDefined();
    expect(
      ratio(color("`input`", palette), color("`muted`", palette))
    ).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The framed card (Início blocks, from 760 px): the title and the foot sit on `--muted`, and the panel in `--card` stands
 * out of it. `--card` against `--muted` does not reach the 3:1 of a graphic edge in either theme, so the panel must carry
 * the 1 px `--border` line (AC-2.4); the test reads the class of the panel and fails if the line goes while the pair is
 * under 3:1, and holds the text on the frame to the 4.5:1 of text.
 */
const cardSource = readFileSync(
  new URL("../ui/card.tsx", import.meta.url),
  "utf8"
);
const PANEL_CLASS = /function CardFramePanel[\s\S]*?cn\(\s*"([^"]*)"/;

describe.each([
  ["Tema claro", tokens(block(":root"))],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
  ],
])("contraste da moldura do cartão, %s", (_section, palette) => {
  it("o painel tem o fio de --border enquanto --card sobre --muted fica abaixo de 3:1", () => {
    const edge = ratio(color("`card`", palette), color("`muted`", palette));
    const panel = PANEL_CLASS.exec(cardSource)?.[1] ?? "";
    expect(panel).not.toBe("");
    if (edge < 3) {
      expect(panel.split(" ")).toContain("md:ring-1");
      expect(panel.split(" ")).toContain("md:ring-border");
    }
  });

  it("o título e o pé (foreground) e a ação de cabeçalho (muted-foreground) leem sobre --muted com 4,5:1", () => {
    for (const text of ["`foreground`", "`muted-foreground`"]) {
      expect(
        ratio(color(text, palette), color("`muted`", palette))
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * The tab of a screen in the `line` variant (src/ui/tabs.tsx) over the page: the 2 px stroke under the open tab is ink
 * (a graphic element, 3:1, WCAG 1.4.11) and the words of a closed tab are `muted-foreground` (text, 4.5:1). Both pairs
 * are rows of the tables above, so the stroke and the closed tab cannot leave the map; the stroke is never the brand
 * color.
 */
describe.each([
  ["Tema claro", tokens(block(":root"))],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
  ],
])("contraste da aba de tela em linha, %s", (section, palette) => {
  const rows = pairs(section);

  it.each([
    ["`foreground`", "traço de 2 px sob a aba de tela aberta", 3],
    ["`muted-foreground`", "texto da aba de tela fechada", 4.5],
  ] as const)(
    "%s (%s) reaches %d:1 and is in the map",
    (foreground, use, bar) => {
      const row = rows.find(
        (item) =>
          item.foreground === foreground &&
          item.background === "`background`" &&
          item.use.startsWith(use)
      );
      expect(row, `${use} is not in "${section}"`).toBeDefined();
      expect(
        ratio(color(foreground, palette), color("`background`", palette))
      ).toBeGreaterThanOrEqual(bar);
    }
  );
});

const badgeSource = readFileSync(
  new URL("../ui/badge.tsx", import.meta.url),
  "utf8"
);
const BADGE_VARIANTS = /variant:\s*\{([\s\S]*?)\n\s*\}/;
const WHITESPACE = /\s+/;
const DARK_PREFIX = /^dark:/;
const TEXT_SIZE_CLASS =
  /^text-(?:xs|sm|base|lg|[2-9]?xl|\[[\d.]+(?:px|rem|em|%)\])(?:\/[\w.[\]]+)?$/;
const BADGE_COLOR_CLASS = /^[a-z]+-([a-z-]+?)(?:\/(\d+))?$/;
const BADGE_VARIANT_ENTRY = /(\w+):\s*"([^"]*)"/g;
const BADGE_VARIANT_KEY = /^\s*[\w"'`]+:/gm;

const badgeBlock = BADGE_VARIANTS.exec(badgeSource)?.[1] ?? "";
const badgeVariants = [...badgeBlock.matchAll(BADGE_VARIANT_ENTRY)].map(
  ([, name, classes]) => ({
    classes: classes as string,
    name: name as string,
  })
);

function badgePair(
  classes: string,
  palette: ReturnType<typeof tokens>,
  dark: boolean
) {
  const items = classes.split(WHITESPACE).filter(Boolean);
  const light = items.filter((item) => !item.includes(":"));
  const darkOnly = dark
    ? items.filter((item) => DARK_PREFIX.test(item) && !item.includes(":", 5))
    : [];
  const pick = (utility: string) => {
    const read = (list: string[]) =>
      list
        .map((item) => item.replace(DARK_PREFIX, ""))
        .filter(
          (item) =>
            item.startsWith(`${utility}-`) && !TEXT_SIZE_CLASS.test(item)
        )
        .map((item) => {
          const match = BADGE_COLOR_CLASS.exec(item);
          if (!(match && palette.has(match[1] as string))) {
            throw new Error(
              `class "${item}" is not a ${utility}-<token> of theme.css`
            );
          }
          return match;
        })
        .at(-1);
    return read(darkOnly) ?? read(light);
  };
  const fill = pick("bg");
  const text = pick("text");
  if (!(fill && text)) {
    return null;
  }
  if (text[2]) {
    throw new Error(
      `text-${text[1]}/${text[2]} has an opacity on the text: use a plain text-<token> so the pair is measured`
    );
  }
  const background = fill[2] ? `${fill[1]}/${fill[2]} sobre sidebar` : fill[1];
  return {
    background: `\`${background}\``,
    foreground: `\`${text[1]}\``,
  };
}

describe("variantes do Badge lidas de ui/badge.tsx", () => {
  it("lê toda variante do arquivo, sem cortar nem pular nenhuma", () => {
    expect(badgeVariants.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "destructive",
        "ink",
        "outline",
        "secondary",
        "warning",
      ])
    );
    expect(
      badgeVariants.length,
      'a variant of src/ui/badge.tsx was not read: write each as `name: "classes"` on one line of the `variant` object'
    ).toBe(badgeBlock.match(BADGE_VARIANT_KEY)?.length);
  });
});

/**
 * The `Badge` (src/ui/badge.tsx): the pair of each variant is read from the classes of the variant in the source, so
 * a color changed there is measured and a variant added there is measured too. The text is the `text-*` token and the
 * fill the `bg-*` token (`dark:bg-*` replaces it in the dark theme); a fill with an opacity is a tint over the header
 * (`sidebar`, where the sync chip sits), a plain one is solid. All are text (4.5:1, WCAG 1.4.3) and each pair must be
 * a row of the tables above, so a token change that breaks one is read there too.
 */
describe.each([
  ["Tema claro", tokens(block(":root")), false],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
    true,
  ],
] as const)("contraste do Badge, %s", (section, palette, dark) => {
  const rows = pairs(section);

  it.each(badgeVariants)(
    "variante $name reaches 4.5:1 and is in the map",
    ({ classes, name }) => {
      const pair = badgePair(classes, palette, dark);
      expect(
        pair,
        `Badge variant "${name}" in src/ui/badge.tsx has no readable pair: give it a bg-<token> and a text-<token> class of theme.css`
      ).not.toBeNull();
      const { background, foreground } = pair as NonNullable<typeof pair>;
      const row = rows.find(
        (item) =>
          item.foreground === foreground && item.background === background
      );
      expect(
        row,
        `Badge variant "${name}": ${foreground} / ${background} is not in "${section}" of docs/design/contraste-v5.1.md; add the row with its measured ratio, or use a pair already in the map`
      ).toBeDefined();
      expect(
        ratio(color(foreground, palette), color(background, palette))
      ).toBeGreaterThanOrEqual(4.5);
    }
  );
});

const menuProgressSource = readFileSync(
  new URL("../app-shell/menu-progress.tsx", import.meta.url),
  "utf8"
);
const DEFAULT_BADGE_VARIANT = /defaultVariants:\s*\{\s*variant:\s*"(\w+)"/;
const MENU_BADGE = /<Badge([^>]*)>\s*Assinatura\s*<\/Badge>/;

/**
 * The "Assinatura" mark of the trial line at the foot of the menu is the `Badge` with no variant and no color class of
 * its own, so its pair is the one of the default variant of `ui/badge.tsx`: read from there, it is in the map of the
 * two themes and reaches 4.5:1 (WCAG 1.4.3). A variant or a `text-*`/`bg-*` class added to the mark leaves this pair.
 */
describe.each([
  ["Tema claro", tokens(block(":root")), false],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
    true,
  ],
] as const)(
  "contraste do selo Assinatura do menu, %s",
  (section, palette, dark) => {
    it("usa a variante padrão do Badge, sem cor própria, e o par chega a 4.5:1", () => {
      const attributes = MENU_BADGE.exec(menuProgressSource)?.[1];
      expect(
        attributes,
        'the "Assinatura" mark of src/app-shell/menu-progress.tsx must be a `<Badge>`'
      ).toBeDefined();
      expect((attributes as string).trim()).toBe("");
      const name = DEFAULT_BADGE_VARIANT.exec(badgeSource)?.[1];
      const variant = badgeVariants.find((item) => item.name === name);
      expect(
        variant,
        "the default variant of the Badge was not read"
      ).toBeDefined();
      const pair = badgePair(
        (variant as NonNullable<typeof variant>).classes,
        palette,
        dark
      );
      const { background, foreground } = pair as NonNullable<typeof pair>;
      expect(
        pairs(section).find(
          (item) =>
            item.foreground === foreground && item.background === background
        ),
        `${foreground} / ${background} is not in "${section}" of docs/design/contraste-v5.1.md`
      ).toBeDefined();
      expect(
        ratio(color(foreground, palette), color(background, palette))
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
);

describe("badgePair: a ordem das classes e as utilidades de tamanho", () => {
  const palette = new Map([
    ...tokens(block(":root")),
    ...tokens(block(".dark")),
  ]);

  it("mede o mesmo par com a classe dark: antes ou depois da clara", () => {
    const normal = "bg-card text-foreground dark:bg-secondary";
    const inverted = "dark:bg-secondary bg-card text-foreground";
    expect(badgePair(inverted, palette, true)).toEqual(
      badgePair(normal, palette, true)
    );
    expect(badgePair(inverted, palette, true)?.background).toBe("`secondary`");
    expect(badgePair(inverted, palette, false)).toEqual(
      badgePair(normal, palette, false)
    );
    expect(badgePair(inverted, palette, false)?.background).toBe("`card`");
  });

  it("ignora utilidade de tamanho em text-*, sem erro de token de cor", () => {
    const base = badgePair("bg-card text-foreground", palette, false);
    for (const size of [
      "text-sm",
      "text-xs",
      "text-9xl",
      "text-[11px]",
      "text-sm/6",
    ]) {
      expect(
        badgePair(`${size} bg-card text-foreground`, palette, false)
      ).toEqual(base);
      expect(
        badgePair(`bg-card text-foreground ${size}`, palette, false)
      ).toEqual(base);
    }
  });

  it("só a classe dark: de um nível troca a clara", () => {
    for (const nested of [
      "dark:hover:bg-secondary",
      "hover:dark:bg-secondary",
    ]) {
      expect(
        badgePair(`bg-card text-foreground ${nested}`, palette, true)
          ?.background
      ).toBe("`card`");
    }
  });

  it("segue recusando text-* de cor arbitrária, que não é tamanho", () => {
    for (const arbitrary of ["text-[#fff]", "text-[var(--x)]"]) {
      expect(() =>
        badgePair(`bg-card text-foreground ${arbitrary}`, palette, false)
      ).toThrow("is not a text-<token> of theme.css");
    }
  });

  it("segue recusando text-* que não é token nem tamanho", () => {
    expect(() => badgePair("bg-card text-nao-existe", palette, false)).toThrow(
      "is not a text-<token> of theme.css"
    );
  });
});

/**
 * The ring of `InsetBlock tone="destructive"` (the confirmation of what cannot be undone, in the row itself): the
 * opacity is read from the component, not copied here, and `destructive` at that opacity over the `--muted` the block
 * is filled with has to keep the 3:1 of a graphic element (WCAG 1.4.11) in both themes.
 */
const insetSource = readFileSync(
  new URL("../ui/inset-block.tsx", import.meta.url),
  "utf8"
);
const DESTRUCTIVE_RING = /ring-destructive\/(\d+)/g;

describe.each([
  ["Tema claro", tokens(block(":root"))],
  [
    "Tema escuro",
    new Map([...tokens(block(":root")), ...tokens(block(".dark"))]),
  ],
])("contraste do anel da confirmação destrutiva, %s", (_section, palette) => {
  it("o anel destructive sobre --muted fica em pelo menos 3:1", () => {
    const rings = [...insetSource.matchAll(DESTRUCTIVE_RING)].map(
      (match) => match[1] as string
    );
    expect(rings).toHaveLength(1);
    const measured = ratio(
      color(`\`destructive/${rings[0]} sobre muted\``, palette),
      color("`muted`", palette)
    );
    expect(measured).toBeGreaterThanOrEqual(3);
  });
});
