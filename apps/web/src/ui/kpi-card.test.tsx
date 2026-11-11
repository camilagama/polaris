import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DeltaChip,
  HeroPercent,
  HeroValue,
  type KpiDelta,
  KPI_STRIP,
  KpiTile,
  KpiTileSkeleton,
} from "./kpi-card";

/**
 * The geometry of a KPI tile does not depend on what it says now: the support line is always there, and the number, the dash and "R$ ••••" share
 * one box of exactly the line height. The heights themselves are measured in the browser (e2e-real/cls).
 */

const CLASS_ATTRIBUTE = /class="([^"]*)"/;
const CURRENCY_SPAN = /<span class="([^"]*)" data-money-currency/;
const TEXT_IN_REM = /text-\[[\d.]+rem\]/;

const TILE_CHIP_THEN_NOTE =
  /data-kpi-note-row=""><span data-kpi-chip-row=""><span data-kpi-delta="down">[^<]*<\/span><\/span>2 vendas/;

const PILL_THEN_AGAINST =
  /data-kpi-pill=""[^>]*>.*\+30,0%<\/span>.*<\/span><span[^>]*data-kpi-delta-against=""[^>]*>vs\. 07\/10 a 05\/11<\/span>/;

const tile = (props: Partial<Parameters<typeof KpiTile>[0]>) =>
  renderToStaticMarkup(
    <KpiTile
      entity="sales"
      id="kpi"
      title="Vendas"
      value={<HeroValue amount="129.90" />}
      {...props}
    />
  );

describe("KpiTile", () => {
  it("is a region named by its title, with no chip and no note when it has none", () => {
    const bare = tile({});
    expect(bare).toContain('role="region"');
    expect(bare).toContain('aria-labelledby="kpi"');
    expect(bare).not.toContain("data-kpi-delta");
    expect(bare).not.toContain("data-kpi-chip-row");
    expect(tile({ note: "2 vendas" })).toContain("2 vendas");
  });

  it("puts the chip and the note on the one support line, under the number", () => {
    const markup = tile({
      chip: <span data-kpi-delta="down">↓ -100,0%</span>,
      note: "2 vendas",
    });
    expect(markup).toMatch(TILE_CHIP_THEN_NOTE);
    expect(markup.indexOf("data-kpi-value")).toBeLessThan(
      markup.indexOf("data-kpi-note-row")
    );
  });

  it("puts the sparkline beside the number, and the date of a day read in the place of the chip", () => {
    const markup = tile({
      date: "Até 17/10",
      spark: <i data-spark="" />,
    });
    expect(markup).toContain('data-kpi-date="">Até 17/10');
    expect(markup).toContain('data-kpi-spark=""');
    expect(markup.indexOf("data-kpi-headline")).toBeLessThan(
      markup.indexOf("data-kpi-spark")
    );
    expect(tile({})).not.toContain("data-kpi-date");
    expect(tile({})).not.toContain("data-kpi-spark");
  });

  it("is 92 px tall at 3 lines, with no height kept for a foot or an action; a warning has a row only when it exists", () => {
    const markup = tile({ note: "2 vendas" });
    expect(markup).not.toContain("data-kpi-foot");
    expect(markup).not.toContain("data-kpi-warning");
    expect(markup).toContain("py-3");
    expect(tile({ warning: "estimativa incompleta" })).toContain(
      'data-kpi-warning=""'
    );
  });
});

describe("HeroValue", () => {
  it("the number and the dash share the box of one line height", () => {
    for (const markup of [
      renderToStaticMarkup(<HeroValue amount="129.90" />),
      renderToStaticMarkup(<HeroValue amount={null} />),
    ]) {
      expect(markup).toContain("h-(--text-value-lg--line-height)");
      expect(markup).toContain("text-value-lg");
    }
  });

  it("says its empty text in the same box in place of the dash, and only when there is no amount", () => {
    const empty = renderToStaticMarkup(
      <HeroValue amount={null} emptyText="sem custo neste dia" />
    );
    expect(empty).toContain("h-(--text-value-lg--line-height)");
    expect(empty).toContain("sem custo neste dia");
    expect(empty).not.toContain("sem valor");
    expect(empty).not.toContain("—");
    const known = renderToStaticMarkup(
      <HeroValue amount="90.00" emptyText="sem custo neste dia" />
    );
    expect(known).toContain("90");
    expect(known).not.toContain("sem custo neste dia");
  });
});

describe("HeroValue sizes", () => {
  const AMOUNTS = ["129.90", "-99640.35", "12345.67", null] as const;
  const classesOf = (markup: string) => CLASS_ATTRIBUTE.exec(markup)?.[1] ?? "";
  const sizeClassesOf = (markup: string) =>
    classesOf(markup)
      .split(" ")
      .filter((name) => name.includes("value-") || name.startsWith("h-("));

  it("writes every amount of every card at one size, lg, with the weight 600 and no size in rem", () => {
    for (const amount of AMOUNTS) {
      const markup = renderToStaticMarkup(<HeroValue amount={amount} />);
      expect(markup).toContain("text-value-lg");
      expect(markup).not.toContain("text-value-xl");
      expect(markup).toContain("font-semibold");
      expect(markup).not.toContain("font-[650]");
      expect(markup).not.toMatch(TEXT_IN_REM);
    }
  });

  it("gives the same size and line classes to a short, a long, a negative and a missing amount", () => {
    const [first, ...rest] = AMOUNTS.map((amount) =>
      sizeClassesOf(renderToStaticMarkup(<HeroValue amount={amount} />))
    );
    expect(first).toContain("text-value-lg");
    for (const classes of rest) {
      expect(classes).toEqual(first);
    }
  });

  it("writes the R$ of every card the same: a size under the number, by the same classes, whatever the amount", () => {
    const currency = (amount: string) =>
      CURRENCY_SPAN.exec(
        renderToStaticMarkup(<HeroValue amount={amount} />)
      )?.[1];
    expect(currency("129.90")).toContain("text-[0.56em]");
    expect(currency("-99640.35")).toBe(currency("129.90"));
    expect(currency("12345.67")).toBe(currency("129.90"));
  });

  it("has no size above lg and no step: nothing in a card is made to be the principal", () => {
    const markup = renderToStaticMarkup(<HeroValue amount="-99640.35" />);
    expect(markup).not.toContain("@max-");
    expect(markup).not.toContain("text-value-xl");
    const skeleton = renderToStaticMarkup(<KpiTileSkeleton />);
    expect(skeleton).toContain("h-(--text-value-lg--line-height)");
    expect(skeleton).not.toContain("text-value-xl");
  });
});

describe("HeroPercent", () => {
  it("is in the box of the amounts beside it, in the same size and weight, with the % a step smaller", () => {
    const markup = renderToStaticMarkup(<HeroPercent text="41,2%" />);
    expect(markup).toContain("font-semibold");
    expect(markup).toContain("text-value-lg");
    expect(markup).toContain('data-kpi-value="">41,2<span');
    expect(markup).toContain("text-[0.56em]");
  });

  it("says a dash and a word for a screen reader when there is no percent, and writes a negative in red", () => {
    const none = renderToStaticMarkup(<HeroPercent text={null} />);
    expect(none).toContain("sem valor");
    expect(none).not.toContain("data-kpi-value");
    expect(renderToStaticMarkup(<HeroPercent text="-3,0%" />)).toContain(
      "text-destructive"
    );
  });
});

const TEXT_BETWEEN_TAGS = />[^<]+</;

describe("KpiTileSkeleton", () => {
  it("draws the rows of the tile it stands for, out of the accessibility tree", () => {
    const markup = renderToStaticMarkup(<KpiTileSkeleton />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("h-(--text-value-lg--line-height)");
    expect(markup).toContain("py-3");
  });

  it("has no text for a screen reader: the box is hidden and holds no words", () => {
    const markup = renderToStaticMarkup(<KpiTileSkeleton />);
    expect(markup.startsWith('<div aria-hidden="true"')).toBe(true);
    expect(markup.match(TEXT_BETWEEN_TAGS)).toBeNull();
  });
});

describe("DeltaChip", () => {
  const DELTA: KpiDelta = {
    against: "vs. 07/10 a 05/11",
    money: false,
    spoken: "subiu 30,0 por cento",
    text: "+30,0%",
    trend: "up",
  };
  const chip = (delta: KpiDelta = DELTA) =>
    renderToStaticMarkup(<DeltaChip delta={delta} />);

  it("keeps the arrow and the number in a pill of their own and the 'vs. …' after it, cut with an ellipsis when it does not fit", () => {
    const markup = chip();
    expect(markup).toMatch(PILL_THEN_AGAINST);
    expect(markup).toContain("min-w-0 truncate");
  });

  it("keeps the name of the chip on the whole, so the screen reader reads it once", () => {
    const markup = chip({
      ...DELTA,
      basis: "em relação a setembro (1 a 14/09)",
    });
    expect(markup).toContain(
      'aria-label="subiu 30,0 por cento em relação a setembro (1 a 14/09)"'
    );
    expect(markup.match(/aria-label=/g)).toHaveLength(1);
  });
});

describe("KpiTile in the strip of the Resultado", () => {
  it("gives up its own card only from 1280 px, where the strip is one card with four columns", () => {
    const cell = tile({ strip: true });
    expect(cell).toContain("xl:rounded-none");
    expect(cell).toContain("xl:ring-0");
    expect(tile({})).not.toContain("xl:ring-0");
    expect(KPI_STRIP).toContain("xl:grid-cols-4");
    expect(KPI_STRIP).toContain("xl:divide-x");
    expect(KPI_STRIP).not.toContain("min-[56.25rem]");
  });

  it("keeps a tile without a sparkline (the margin) to its text", () => {
    const markup = tile({ note: "Sem custo informado", strip: true });
    expect(markup).not.toContain("data-kpi-spark");
    expect(markup).toContain("Sem custo informado");
  });
});
