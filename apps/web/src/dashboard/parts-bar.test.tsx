import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeriodChain, PeriodQuality } from "./dashboard-model";

const state = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [state.hidden, () => undefined],
}));

const BAR_WIDTH = /style="width:([\d.]+)%"/g;

const { PartsBar, partPercents } = await import("./parts-bar");

beforeEach(() => {
  state.hidden = false;
});

/**
 * "Para onde vão os custos" (AC-12): with no cost of the goods known (`cogsCoverageOf` "none") neither the bar
 * nor its track is drawn, the goods read "—" with "sem custo conhecido", the fees and the expenses keep their values and
 * a line says why; a partial and a full cost stay as they were.
 */

const chain: PeriodChain = {
  anticipationFees: "10.00",
  cogs: "0.00",
  commercialSurcharges: "0.00",
  contributionMargin: "0.00",
  discounts: "0.00",
  estimatedOperatingResult: "0.00",
  grossProfit: "0.00",
  grossSales: "0.00",
  linkedExpenses: "61.55",
  netSales: "0.00",
  operatingExpenses: "1735.40",
  processingFees: "98.20",
  returns: "0.00",
};

function quality(itemLinesWithUnknownCost: number): PeriodQuality {
  return {
    anticipationFeesUnknown: 0,
    itemLines: 25,
    itemLinesWithUnknownCost,
    level: itemLinesWithUnknownCost > 0 ? "partial" : "complete",
    linkedExpenses: 1,
    missing: itemLinesWithUnknownCost > 0 ? ["unknown_cost"] : [],
    operatingExpenses: 2,
    processingFeesUnknown: 0,
    salesCount: 25,
  };
}

/** The words of a piece of markup, read tag by tag. */
function words(markup: string): string {
  let out = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") {
      inTag = true;
    } else if (char === ">") {
      inTag = false;
    } else if (!inTag) {
      out += char;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

const PERCENT = /\d+%/;
const HIDDEN_SPOKEN = /valor escondido/g;
const MONEY_DIGIT = /R\$ \d/;
const LINE = "Sem o custo das mercadorias, a divisão dos custos não aparece.";

describe("the parts of the cost", () => {
  it("with no cost of the goods known draws no bar, says the goods have no known cost and keeps the other parts", () => {
    const markup = renderToStaticMarkup(
      <PartsBar chain={chain} quality={quality(25)} />
    );
    expect(markup).not.toContain("data-parts-bar");
    expect(markup).not.toContain("bg-muted");
    const text = words(markup);
    expect(text).toContain("Mercadorias—sem valorsem custo conhecido");
    expect(text).not.toContain("incompleto");
    expect(text).toContain("TaxasR$ 108,20");
    expect(text).toContain("DespesasR$ 1.796,95");
    expect(text).toContain(LINE);
  });

  it("with a partial cost of the goods draws the bar and marks the goods incomplete, as before", () => {
    const markup = renderToStaticMarkup(
      <PartsBar chain={{ ...chain, cogs: "1712.40" }} quality={quality(3)} />
    );
    expect(markup).toContain("data-parts-bar");
    const text = words(markup);
    expect(text).toContain("MercadoriasR$ 1.712,4047%incompleto");
    expect(text).not.toContain("sem custo conhecido");
    expect(text).not.toContain(LINE);
  });

  it("with every cost of the goods known draws the bar with no mark", () => {
    const markup = renderToStaticMarkup(
      <PartsBar chain={{ ...chain, cogs: "1712.40" }} quality={quality(0)} />
    );
    expect(markup).toContain("data-parts-bar");
    expect(words(markup)).not.toContain("incompleto");
    expect(words(markup)).not.toContain(LINE);
  });
});

describe("a refunded part in the bar", () => {
  it("draws no width for a negative part and the others fill the bar", () => {
    const markup = renderToStaticMarkup(
      <PartsBar
        chain={{
          ...chain,
          anticipationFees: "0.00",
          cogs: "-5.00",
          linkedExpenses: "0.00",
          operatingExpenses: "11.00",
          processingFees: "7.00",
        }}
        quality={quality(0)}
      />
    );
    const widths = [...markup.matchAll(BAR_WIDTH)].map((match) =>
      Number(match[1])
    );
    expect(markup).not.toContain("width:-");
    expect(widths).toHaveLength(3);
    expect(widths[0]).toBe(0);
    expect((widths[1] ?? 0) + (widths[2] ?? 0)).toBeCloseTo(100, 5);
  });
});

describe("the percent of each part", () => {
  const sums = (values: Array<number | null>) =>
    values.reduce<number>((sum, value) => sum + (value ?? 0), 0);

  it("adds up to 100 by the largest remainder, whatever the split", () => {
    expect(
      partPercents(
        [{ value: "1.00" }, { value: "1.00" }, { value: "1.00" }],
        "3.00"
      )
    ).toEqual([34, 33, 33]);
    expect(
      partPercents(
        [{ value: "1712.40" }, { value: "108.20" }, { value: "1796.95" }],
        "3617.55"
      )
    ).toEqual([47, 3, 50]);
    for (let total = 1; total <= 400; total += 1) {
      for (let first = 0; first <= total; first += 7) {
        const second = Math.floor((total - first) / 3);
        const parts = [first, second, total - first - second].map((cents) => ({
          value: (cents / 100).toFixed(2),
        }));
        const percents = partPercents(parts, (total / 100).toFixed(2));
        expect(sums(percents), `${first}/${second}/${total}`).toBe(100);
        percents.forEach((percent, index) => {
          const exact =
            (Number(parts[index]?.value) * 10_000) / (total / 100) / 100;
          expect(Math.abs((percent ?? 0) - exact)).toBeLessThan(1);
        });
      }
    }
  });

  it("gives a refunded (negative) part 0% and still adds the others up to 100", () => {
    const cases: [string[], string][] = [
      [["-0.50", "-0.50", "101.00"], "100.00"],
      [["-10.00", "-20.00", "130.00"], "100.00"],
      [["-0.01", "-0.01", "0.03"], "0.01"],
      [["-3.33", "-3.33", "9.99"], "3.33"],
      [["-1.00", "40.00", "-2.00"], "37.00"],
      [["-5.00", "7.00", "11.00"], "13.00"],
    ];
    for (const [values, total] of cases) {
      const percents = partPercents(
        values.map((value) => ({ value })),
        total
      );
      expect(sums(percents), values.join("/")).toBe(100);
      for (const percent of percents) {
        expect(percent, values.join("/")).toBeGreaterThanOrEqual(0);
      }
    }
    expect(
      partPercents(
        [{ value: "-0.50" }, { value: "-0.50" }, { value: "101.00" }],
        "100.00"
      )
    ).toEqual([0, 0, 100]);
  });

  it("gives no part a percent without a total, refund or not", () => {
    expect(
      partPercents(
        [{ value: null }, { value: "-5.00" }, { value: "10.00" }],
        null
      )
    ).toEqual([null, null, null]);
  });

  it("gives no part a percent when the refunds leave nothing positive to divide", () => {
    expect(
      partPercents([{ value: "-4.00" }, { value: "-1.00" }], "-5.00")
    ).toEqual([null, null]);
  });

  it("gives a known part with a zero value 0%, not nothing", () => {
    expect(
      partPercents([{ value: "0.00" }, { value: "50.00" }], "50.00")
    ).toEqual([0, 100]);
  });

  it("gives an unknown part no percent and divides the known ones by the total", () => {
    expect(
      partPercents(
        [{ value: null }, { value: "30.00" }, { value: "10.00" }],
        "40.00"
      )
    ).toEqual([null, 75, 25]);
  });

  it("gives no part a percent when there is no total to divide", () => {
    expect(partPercents([{ value: null }, { value: "30.00" }], null)).toEqual([
      null,
      null,
    ]);
    expect(
      partPercents([{ value: "0.00" }, { value: "0.00" }], "0.00")
    ).toEqual([null, null]);
  });
});

describe("the percent in the legend", () => {
  it("writes the value and the percent of every known part, adding up to 100", () => {
    const text = words(
      renderToStaticMarkup(
        <PartsBar chain={{ ...chain, cogs: "1712.40" }} quality={quality(0)} />
      )
    );
    expect(text).toContain("MercadoriasR$ 1.712,4047%");
    expect(text).toContain("TaxasR$ 108,203%");
    expect(text).toContain("DespesasR$ 1.796,9550%");
  });

  it("shows no percent with the goods unknown: the total is not known", () => {
    const markup = renderToStaticMarkup(
      <PartsBar chain={chain} quality={quality(25)} />
    );
    expect(markup).not.toContain("data-part-percent");
    expect(words(markup)).not.toMatch(PERCENT);
    expect(words(markup)).not.toContain("0%");
  });

  it("masks the percent with the value when the values are hidden", () => {
    state.hidden = true;
    const markup = renderToStaticMarkup(
      <PartsBar chain={{ ...chain, cogs: "1712.40" }} quality={quality(0)} />
    );
    expect(markup).not.toContain("data-part-percent");
    expect(markup.match(/data-masked-percent/g)).toHaveLength(3);
    const text = words(markup);
    expect(text).not.toMatch(PERCENT);
    expect(text).not.toMatch(MONEY_DIGIT);
    expect(text.match(HIDDEN_SPOKEN)).toHaveLength(3);
  });
});
