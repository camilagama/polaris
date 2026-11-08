import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatBrlAmount } from "@/lib/format";

const state = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [state.hidden, () => undefined],
}));

const { MoneyText, NoBreakMoney } = await import("./hidden-values");
const { HeroValue } = await import("./kpi-card");
const { Money } = await import("./money");

const SIZES = [undefined, "sm", "md", "lg", "xl"] as const;
const DIGIT = /\d/;
const CURRENCY_CLASS = /data-money-currency=""/;
const CURRENCY_TAG = /<span class="([^"]*)" data-money-currency="">/;
const BOX_CLASS = /<span[^>]*class="([^"]*whitespace-nowrap[^"]*)"/;
const OTHER_TEXT_SIZE = /\btext-(?!\[0\.56em\])/;
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

  it("says a dash and 'sem valor' for an amount nobody knows", () => {
    const markup = renderToStaticMarkup(<Money size="lg" text={null} />);
    expect(textOf(markup)).toBe("—sem valor");
    expect(markup).toContain('class="sr-only"');
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
    expect(
      textOf(renderToStaticMarkup(<NoBreakMoney text="Total R$ 1.840,00" />))
    ).toBe("Total R$ 1.840,00");
  });
});

describe("MoneyText and NoBreakMoney, with the values showing", () => {
  it("write the text they are given, each amount in a box that does not break", () => {
    const text = "Melhor dia: 18/10, R$ 1.840,00 e -R$ 12,00";
    for (const Component of [MoneyText, NoBreakMoney]) {
      const markup = renderToStaticMarkup(<Component text={text} />);
      expect(textOf(markup)).toBe(text);
      expect(markup.match(/whitespace-nowrap/g)).toHaveLength(2);
    }
  });
});
