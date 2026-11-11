import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DeltaChip,
  HeroPercent,
  HeroValue,
  type KpiDelta,
  KpiCard,
  KpiTile,
  KpiTileSkeleton,
} from "./kpi-card";

/**
 * The geometry of a KPI card does not depend on what it says now: the support line is always there, a foot given as
 * `null` keeps its line, the longest date keeps its width out of sight, and the number, the dash and "R$ ••••" share
 * one box of exactly the line height. The heights themselves are measured in the browser (e2e-real/cls).
 */

const CLASS_ATTRIBUTE = /class="([^"]*)"/;
const CURRENCY_SPAN = /<span class="([^"]*)" data-money-currency/;
const FIT_IN_CQW = /min\(var\(--text-value-lg\), ([\d.]+)cqw\)/;
const TEXT_IN_REM = /text-\[[\d.]+rem\]/;

const TILE_CHIP_THEN_NOTE =
  /data-kpi-note-row=""><span class="shrink-0" data-kpi-chip-row=""><span data-kpi-delta="down">[^<]*<\/span><\/span>2 vendas/;

const PILL_THEN_AGAINST =
  /data-kpi-pill=""[^>]*>.*\+30,0%<\/span>.*<\/span><span[^>]*data-kpi-delta-against=""[^>]*>vs\. 07\/10 a 05\/11<\/span>/;

const card = (props: Partial<Parameters<typeof KpiCard>[0]>) =>
  renderToStaticMarkup(
    <KpiCard
      entity="sales"
      id="kpi"
      title="Vendas"
      value={<HeroValue amount="129.90" />}
      {...props}
    />
  );

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

  it("is 92 px tall at 3 lines, with no height kept for a foot or an action; a warning is the support line, never a fourth", () => {
    const markup = tile({ note: "2 vendas" });
    expect(markup).not.toContain("data-kpi-foot");
    expect(markup).not.toContain("data-kpi-warning");
    expect(markup).toContain("py-3");
    const warned = tile({
      chip: <i data-chip="" />,
      warning: "Incompleta",
      warningDetail: "5 de 23 dias sem custo",
    });
    expect(warned).toContain('data-kpi-warning=""');
    expect(warned.match(/data-kpi-note-row/g)).toHaveLength(1);
    expect(warned).toContain("h-5 flex-nowrap overflow-hidden");
    expect(warned.indexOf("Incompleta")).toBeLessThan(
      warned.indexOf("data-chip")
    );
    expect(warned.indexOf("data-chip")).toBeLessThan(
      warned.indexOf("5 de 23 dias sem custo")
    );
  });
});

describe("HeroValue of a tile", () => {
  const sized = (amount: string) =>
    renderToStaticMarkup(<HeroValue amount={amount} tile />);
  const fit = (markup: string) => Number(FIT_IN_CQW.exec(markup)?.[1]);

  it("sizes the figure by the width of its own area: the longer the amount, the smaller the fit, and a short one keeps the token", () => {
    const short = fit(sized("0"));
    const long = fit(sized("-99640.35"));
    expect(long).toBeLessThan(short);
    expect(short).toBeGreaterThan(30);
    expect(long).toBeLessThan(30);
  });

  it("does not size a figure that is not a tile's, nor a dash", () => {
    expect(renderToStaticMarkup(<HeroValue amount="129.90" />)).not.toContain(
      "cqw"
    );
    expect(sized("129.90")).toContain("max(0.875rem");
    expect(
      renderToStaticMarkup(<HeroValue amount={null} tile />)
    ).not.toContain("cqw");
  });
});

describe("KpiCard", () => {
  it("keeps the row of the chip without a chip, with no text for a screen reader", () => {
    const bare = card({});
    expect(bare).toContain('data-kpi-chip-row=""');
    expect(bare).toContain("min-h-5");
    expect(bare).not.toContain("data-kpi-delta");
  });

  it("keeps the foot's line when the foot is null, and draws none without one", () => {
    expect(card({ footer: null })).toContain("data-kpi-foot");
    expect(card({})).not.toContain("data-kpi-foot");
  });

  it("keeps the width of the longest date out of sight, with or without a date", () => {
    const rest = card({
      date: "outubro inteiro",
      dateReserve: "outubro inteiro",
    });
    const reading = card({ dateReserve: "outubro inteiro" });
    for (const markup of [rest, reading]) {
      expect(markup).toContain('aria-hidden="true" class="invisible');
    }
    expect(rest).toContain('data-kpi-date="">outubro inteiro');
    expect(reading).not.toContain("data-kpi-date");
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

describe("HeroValue in a column of the strip", () => {
  const sizeOf = (amount: string | null) =>
    renderToStaticMarkup(<HeroValue amount={amount} strip />);

  it("is 24 px from 900 px for an amount that fits the narrowest column", () => {
    const markup = sizeOf("129.90");
    expect(markup).toContain("min-[56.25rem]:text-[1.5rem]");
    expect(markup).not.toContain("@max-");
  });

  it("steps an amount of 12 or 13 characters down to 20 px, and of 14 or more to 18 px, only in a column too narrow for it", () => {
    const twelve = sizeOf("12345.67");
    expect(twelve).toContain("min-[56.25rem]:@[9rem]:text-[1.5rem]");
    expect(twelve).toContain("min-[56.25rem]:@max-[8.999rem]:text-[1.25rem]");
    expect(sizeOf("999999.99")).toContain("@max-[8.999rem]:text-[1.25rem]");
    const long = sizeOf("-9999999.99");
    expect(long).toContain("min-[56.25rem]:@[10.5rem]:text-[1.5rem]");
    expect(long).toContain("min-[56.25rem]:@max-[10.499rem]:text-[1.125rem]");
  });

  it("keeps the line of 20 px and the box of 1.05 em at 900 px, which the merge of the classes drops when the line comes before the size", () => {
    for (const amount of ["129.90", "12345.67", "-9999999.99", null]) {
      const classes =
        CLASS_ATTRIBUTE.exec(
          renderToStaticMarkup(<HeroValue amount={amount} strip />)
        )?.[1]?.split(" ") ?? [];
      expect(classes).toContain("min-[56.25rem]:leading-5");
      expect(classes).toContain("min-[56.25rem]:h-[1.05em]");
    }
  });

  it("keeps the dash and the empty text at 24 px, with no step", () => {
    expect(sizeOf(null)).toContain("min-[56.25rem]:text-[1.5rem]");
  });

  it("does not touch the value of a card that is not in the strip", () => {
    const markup = renderToStaticMarkup(<HeroValue amount="999999.99" />);
    expect(markup).not.toContain("min-[56.25rem]");
    expect(markup).toContain("text-value-lg");
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
    const markup = renderToStaticMarkup(<HeroPercent strip text="41,2%" />);
    expect(markup).toContain("font-semibold");
    expect(markup).toContain("text-value-lg");
    expect(markup).toContain("min-[56.25rem]:leading-5");
    expect(markup).toContain("min-[56.25rem]:text-[1.5rem]");
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

describe("DeltaChip in a column of the strip", () => {
  const DELTA: KpiDelta = {
    against: "vs. 07/10 a 05/11",
    money: false,
    spoken: "subiu 30,0 por cento",
    text: "+30,0%",
    trend: "up",
  };
  const chip = (strip: boolean, delta: KpiDelta = DELTA) =>
    renderToStaticMarkup(<DeltaChip delta={delta} strip={strip} />);

  it("keeps the arrow and the number in a pill of their own and the 'vs. …' after it, whole", () => {
    const markup = chip(true);
    expect(markup).toMatch(PILL_THEN_AGAINST);
  });

  it("stacks the 'vs. …' under the pill, wrapping and muted, in a column narrower than 14 rem", () => {
    const markup = chip(true);
    expect(markup).toContain("min-[56.25rem]:@max-[13.999rem]:flex-col");
    expect(markup).toContain("min-[56.25rem]:@max-[13.999rem]:bg-transparent");
    expect(markup).toContain(
      "min-[56.25rem]:@max-[13.999rem]:whitespace-normal"
    );
    expect(markup).toContain(
      "min-[56.25rem]:@max-[13.999rem]:overflow-visible"
    );
    expect(markup).toContain(
      "min-[56.25rem]:@max-[13.999rem]:text-muted-foreground"
    );
    expect(markup).toContain("min-[56.25rem]:@max-[13.999rem]:rounded-full");
  });

  it("still cuts the 'vs. …' beside the number, where the line never wraps", () => {
    expect(chip(true)).toContain("min-w-0 truncate");
  });

  it("gives the 'vs. …' a title with the whole text in the strip, where it may be cut beside the number", () => {
    expect(chip(true)).toContain('title="vs. 07/10 a 05/11"');
    expect(chip(false)).not.toContain("title=");
  });

  it("is the chip of before outside the strip", () => {
    expect(chip(false)).not.toContain("@max-");
    expect(chip(false)).not.toContain("min-[56.25rem]");
  });

  it("keeps the name of the chip on the whole, so the screen reader reads it once", () => {
    const markup = chip(true, {
      ...DELTA,
      basis: "em relação a setembro (1 a 14/09)",
    });
    expect(markup).toContain(
      'aria-label="subiu 30,0 por cento em relação a setembro (1 a 14/09)"'
    );
    expect(markup.match(/aria-label=/g)).toHaveLength(1);
  });

  it("keeps the two lines of the chip row in the narrow column, empty without a comparison", () => {
    const markup = card({ strip: true });
    expect(markup).toContain(
      "min-[56.25rem]:@max-[13.999rem]:min-h-[3.375rem]"
    );
    expect(markup).toContain('data-kpi-chip-row=""');
  });
});
