import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeroValue, KpiCard, KpiCardSkeleton } from "./kpi-card";

/**
 * The geometry of a KPI card does not depend on what it says now: the support line is always there, a foot given as
 * `null` keeps its line, the longest date keeps its width out of sight, and the number, the dash and "R$ ••••" share
 * one box of exactly the line height. The heights themselves are measured in the browser (e2e-real/cls).
 */

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
  it("keeps the support line without a chip or a note", () => {
    expect(card({})).toContain("min-h-[1.375rem]");
    expect(card({ note: "2 vendas" })).toContain("2 vendas");
  });

  it("keeps the foot's line when the foot is null, and draws none without one", () => {
    expect(card({ footer: null })).toContain("min-h-4");
    expect(card({})).not.toContain("min-h-4");
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
});

describe("KpiCardSkeleton", () => {
  it("draws the rows of the card it stands for, out of the accessibility tree", () => {
    const markup = renderToStaticMarkup(
      <KpiCardSkeleton action footer={1} size="md" />
    );
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("min-h-[1.375rem]");
    expect(markup).toContain("min-h-4");
    expect(markup).toContain("h-[1.05em]");
    expect(markup).toContain("h-[3.25rem]");
  });
});
