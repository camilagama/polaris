import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatBrlAmount } from "@/lib/format";

const state = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [state.hidden, () => undefined],
}));

const { MoneyText } = await import("./hidden-values");
const { HeroValue } = await import("./kpi-card");
const { maskedAmountWidthEm, Money, splitAmountWidthEm } = await import(
  "./money"
);

const SIZES = [undefined, "sm", "md", "lg", "xl"] as const;
const DIGIT = /\d/;
const CURRENCY_CLASS = /data-money-currency=""/;
const CURRENCY_TAG = /<span class="([^"]*)" data-money-currency="">/;
const BOX_CLASS = /<span[^>]*class="([^"]*whitespace-nowrap[^"]*)"/;
const OTHER_TEXT_SIZE = /\btext-(?!\[0\.56em\])/;
const BOX_MONO = /<span[^>]*class="[^"]*\bfont-mono\b[^"]*\btabular-nums\b/;
const NAME_ATTRIBUTES = /\b(?:aria-label|title|alt)=/;

/** What a reader gets from the markup: its text, with no tags. */
const textOf = (markup: string) =>
  markup
    .split("<")
    .map((piece) => piece.slice(piece.indexOf(">") + 1))
    .join("");

const AMOUNTS = [
  "0",
  "0.05",
  "0.5",
  "12",
  "10.10",
  "1234.5",
  "99640.35",
  "999999.99",
  "1000000",
  "1234567.89",
  "-6.35",
  "-0.01",
  "-99640.35",
];

beforeEach(() => {
  state.hidden = false;
});

describe("Money, with the values showing", () => {
  it.each(
    AMOUNTS.flatMap((amount) => SIZES.map((size) => [amount, size] as const))
  )("%s in size %s reads as formatBrlAmount writes it", (amount, size) => {
    const text = formatBrlAmount(amount);
    expect(
      textOf(renderToStaticMarkup(<Money size={size} text={text} />))
    ).toBe(text);
  });

  it("keeps the sign of a negative amount in every size, not only its color", () => {
    for (const size of SIZES) {
      const markup = renderToStaticMarkup(
        <Money size={size} text={formatBrlAmount("-6.35")} />
      );
      expect(textOf(markup)).toBe("-R$ 6,35");
    }
    const hero = renderToStaticMarkup(<HeroValue amount="-6.35" />);
    expect(textOf(hero)).toBe("-R$ 6,35");
    expect(hero).toContain("text-destructive");
  });

  it("writes the R$ apart only in lg and xl, a size under the number, in the color of the number and not above weight 500", () => {
    for (const size of ["lg", "xl"] as const) {
      const markup = renderToStaticMarkup(
        <Money size={size} text="R$ 1.234,50" />
      );
      const currency = CURRENCY_TAG.exec(markup)?.[1] ?? "";
      expect(currency).toContain("text-[0.56em]");
      expect(currency).toContain("font-medium");
      expect(currency).not.toMatch(OTHER_TEXT_SIZE);
      expect(markup).toContain('data-money-cents=""');
    }
    for (const size of [undefined, "sm", "md"] as const) {
      const markup = renderToStaticMarkup(
        <Money size={size} text="R$ 1.234,50" />
      );
      expect(markup).not.toMatch(CURRENCY_CLASS);
      expect(markup).not.toContain("data-money-cents");
    }
  });

  it("takes only one of the four text-value sizes, and none when it has no size", () => {
    for (const size of ["sm", "md", "lg", "xl"] as const) {
      const markup = renderToStaticMarkup(<Money size={size} text="R$ 1,00" />);
      expect(markup).toContain(`text-value-${size}`);
      expect(markup).toContain("tabular-nums");
      expect(markup).toContain("whitespace-nowrap");
    }
    expect(renderToStaticMarkup(<Money text="R$ 1,00" />)).not.toContain(
      "text-value"
    );
  });

  it("sets every amount in Geist Mono, of any size and of none, with the values showing, hidden or unknown", () => {
    for (const hidden of [false, true]) {
      state.hidden = hidden;
      for (const size of SIZES) {
        for (const text of ["R$ 1.234,50", null]) {
          const markup = renderToStaticMarkup(
            <Money size={size} text={text} />
          );
          expect(markup).toMatch(BOX_MONO);
        }
      }
    }
  });

  it("splits a signed amount of lg and xl with each sign, and writes a text that is not an amount as it is", () => {
    for (const sign of ["+", "-", "−"]) {
      const markup = renderToStaticMarkup(
        <Money size="lg" text={`${sign}R$ 436,86`} />
      );
      expect(textOf(markup)).toBe(`${sign}R$ 436,86`);
      expect(markup).toContain('data-money-currency=""');
    }
    const plain = renderToStaticMarkup(<Money size="lg" text="R$ 12" />);
    expect(textOf(plain)).toBe("R$ 12");
    expect(plain).not.toContain("data-money-currency");
  });

  it("says a dash and 'sem valor' for an amount nobody knows", () => {
    const markup = renderToStaticMarkup(<Money size="lg" text={null} />);
    expect(textOf(markup)).toBe("—sem valor");
    expect(markup).toContain('class="sr-only"');
  });
});

const FAMILY_MONO = /\bfont-mono\b/;
const EM_OF_SPAN =
  /class="[^"]*text-\[([\d.]+)em\][^"]*" data-money-(?:currency|cents)/g;

describe("Money, the display in Geist Mono", () => {
  it("sets every size in the mono face and takes the tracking away only from lg and xl", () => {
    for (const size of ["lg", "xl"] as const) {
      const markup = renderToStaticMarkup(
        <Money size={size} text="R$ 1.234,50" />
      );
      expect(markup).toMatch(FAMILY_MONO);
      expect(markup).toContain("tracking-normal");
    }
    for (const size of [undefined, "sm", "md"] as const) {
      const markup = renderToStaticMarkup(
        <Money size={size} text="R$ 1.234,50" />
      );
      expect(markup).toMatch(FAMILY_MONO);
      expect(markup).not.toContain("tracking-normal");
    }
  });

  it("does not let a caller's negative tracking squeeze the cells of the display", () => {
    const markup = renderToStaticMarkup(
      <Money
        className="font-semibold tracking-[-0.035em]"
        size="lg"
        text="R$ 1.234,50"
      />
    );
    expect(markup).toContain("tracking-normal");
    expect(markup).not.toContain("tracking-[-0.035em]");
  });

  it("keeps the same face and box when the values are hidden", () => {
    state.hidden = true;
    try {
      const markup = renderToStaticMarkup(
        <Money size="xl" text="R$ 1.234,50" />
      );
      expect(markup).toMatch(FAMILY_MONO);
      expect(markup).toContain("data-masked-money");
    } finally {
      state.hidden = false;
    }
  });

  it("knows the width of a split amount from the em of its small parts, the same the markup says", () => {
    const emOf = (written: string) =>
      [...written.matchAll(EM_OF_SPAN)].map((match) => Number(match[1]));
    const markup = renderToStaticMarkup(
      <Money size="lg" text="R$ 99.640,35" />
    );
    const [currency, cents] = emOf(markup);
    const expected = (1 * 6 + 3 * (currency ?? 0) + 3 * (cents ?? 0)) * 0.6;
    expect(splitAmountWidthEm("R$ 99.640,35")).toBeCloseTo(expected, 10);
    expect(splitAmountWidthEm("-R$ 99.640,35")).toBeCloseTo(expected + 0.6, 10);
    expect(splitAmountWidthEm("R$ 12")).toBeCloseTo(5 * 0.6, 10);
  });

  it("knows the width of the mask: the small R$ and four dots", () => {
    expect(maskedAmountWidthEm()).toBeCloseTo((3 * 0.56 + 4) * 0.6, 10);
  });
});

describe("Money, with the values hidden", () => {
  beforeEach(() => {
    state.hidden = true;
  });

  it.each(
    AMOUNTS.flatMap((amount) => SIZES.map((size) => [amount, size] as const))
  )(
    "%s in size %s leaves no digit, no name and no title, and says 'valor escondido'",
    (amount, size) => {
      const markup = renderToStaticMarkup(
        <Money size={size} text={formatBrlAmount(amount)} />
      );
      expect(textOf(markup)).toBe("R$ ••••valor escondido");
      expect(DIGIT.test(textOf(markup))).toBe(false);
      expect(markup).not.toMatch(NAME_ATTRIBUTES);
      expect(markup).toContain('class="sr-only">valor escondido<');
    }
  );

  it("keeps the class of the R$ and of the box that it has with the amount showing", () => {
    const text = "R$ 1.234,50";
    for (const size of ["lg", "xl"] as const) {
      state.hidden = false;
      const shown = renderToStaticMarkup(<Money size={size} text={text} />);
      state.hidden = true;
      const masked = renderToStaticMarkup(<Money size={size} text={text} />);
      expect(CURRENCY_TAG.exec(masked)?.[1]).toBe(
        CURRENCY_TAG.exec(shown)?.[1]
      );
      expect(BOX_CLASS.exec(masked)?.[1]).toContain("text-value");
      expect(BOX_CLASS.exec(masked)?.[1]).toBe(BOX_CLASS.exec(shown)?.[1]);
    }
  });

  it("hides the amount in a hero value and keeps the negative color out of the mask", () => {
    const hero = renderToStaticMarkup(<HeroValue amount="-99640.35" />);
    expect(textOf(hero)).toBe("R$ ••••valor escondido");
    expect(hero).not.toContain("text-destructive");
  });

  it("masks the amounts of a running text and keeps the words, but not the amounts that say they must stay", () => {
    expect(
      textOf(
        renderToStaticMarkup(
          <MoneyText text="Melhor dia: 18/10, R$ 1.840,00" />
        )
      )
    ).toBe("Melhor dia: 18/10, R$ ••••valor escondido");
  });
});

describe("MoneyText, with the values showing", () => {
  it("writes the text it is given, each amount in a box that does not break", () => {
    const text = "Melhor dia: 18/10, R$ 1.840,00 e -R$ 12,00";
    const markup = renderToStaticMarkup(<MoneyText text={text} />);
    expect(textOf(markup)).toBe(text);
    expect(markup.match(/whitespace-nowrap/g)).toHaveLength(2);
  });
});
