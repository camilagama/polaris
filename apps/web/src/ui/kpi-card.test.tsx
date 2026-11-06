import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeroValue, KpiCard, KpiCardSkeleton } from "./kpi-card";

/**
 * The geometry of a KPI card does not depend on what it says now: the support line is always there, a foot given as
 * `null` keeps its line, the longest date keeps its width out of sight, and the number, the dash and "R$ ••••" share
 * one box of exactly the line height. The heights themselves are measured in the browser (e2e-real/cls).
 */

const CHIP_THEN_NOTE =
  /data-kpi-chip-row=""[^>]*><span data-kpi-delta="down">[^<]*<\/span><\/div><\/div><div[^>]*data-kpi-note-row="">2 vendas/;

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

describe("KpiCard", () => {
  it("keeps the row of the chip and the row of the note without a chip or a note, with no text for a screen reader", () => {
    const bare = card({});
    expect(bare).toContain('data-kpi-chip-row=""');
    expect(bare).toContain('data-kpi-note-row=""');
    expect(bare).toContain("min-h-5");
    expect(bare).not.toContain("data-kpi-delta");
    expect(card({ note: "2 vendas" })).toContain("2 vendas");
  });

  it("puts the chip in its own row, apart from the note", () => {
    const markup = card({
      chip: <span data-kpi-delta="down">↓ -100,0%</span>,
      note: "2 vendas",
    });
    expect(markup).toMatch(CHIP_THEN_NOTE);
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
      expect(markup).toContain("h-[1.05em]");
      expect(markup).toContain("leading-5");
    }
  });

  it("says its empty text in the same box in place of the dash, and only when there is no amount", () => {
    const empty = renderToStaticMarkup(
      <HeroValue amount={null} emptyText="sem custo neste dia" />
    );
    expect(empty).toContain("h-[1.05em]");
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
    expect(markup).toContain("min-[900px]:text-[1.5rem]");
    expect(markup).not.toContain("@max-");
  });

  it("steps an amount of 12 or 13 characters down to 20 px, and of 14 or more to 18 px, only in a column too narrow for it", () => {
    const twelve = sizeOf("12345.67");
    expect(twelve).toContain("min-[900px]:@[9rem]:text-[1.5rem]");
    expect(twelve).toContain("min-[900px]:@max-[8.999rem]:text-[1.25rem]");
    expect(sizeOf("999999.99")).toContain("@max-[8.999rem]:text-[1.25rem]");
    const long = sizeOf("-9999999.99");
    expect(long).toContain("min-[900px]:@[10.5rem]:text-[1.5rem]");
    expect(long).toContain("min-[900px]:@max-[10.499rem]:text-[1.125rem]");
  });

  it("keeps the dash and the empty text at 24 px, with no step", () => {
    expect(sizeOf(null)).toContain("min-[900px]:text-[1.5rem]");
  });

  it("does not touch the value of a card that is not in the strip", () => {
    const markup = renderToStaticMarkup(<HeroValue amount="999999.99" />);
    expect(markup).not.toContain("min-[900px]");
    expect(markup).toContain("md:text-[1.875rem]");
  });
});

const TEXT_BETWEEN_TAGS = />[^<]+</;
const SKELETON_FOOT = /data-kpi-skeleton-foot=""/g;

describe("KpiCardSkeleton", () => {
  it("draws the rows of the card it stands for, out of the accessibility tree", () => {
    const markup = renderToStaticMarkup(
      <KpiCardSkeleton action footer={1} size="md" />
    );
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('data-kpi-chip-row=""');
    expect(markup).toContain('data-kpi-note-row=""');
    expect(markup).toContain("h-[1.05em]");
    expect(markup).toContain("h-[3.25rem]");
    expect(markup.match(SKELETON_FOOT)).toHaveLength(1);
  });

  it("has no text for a screen reader: the box is hidden and holds no words", () => {
    const markup = renderToStaticMarkup(
      <KpiCardSkeleton action footer={2} size="md" />
    );
    expect(markup.startsWith('<div aria-hidden="true"')).toBe(true);
    expect(markup.match(TEXT_BETWEEN_TAGS)).toBeNull();
    expect(markup.match(SKELETON_FOOT)).toHaveLength(2);
  });
});
