import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SaleNoticeRegion } from "./sale-notice-region";

const HIDDEN = /hidden/;
const REGION_WITH_ALERT = /^<div aria-live="polite"[^>]*><div[^>]*>/;

describe("SaleNoticeRegion", () => {
  it("is in the tree before the notice, as a live region that is not display:none", () => {
    const html = renderToStaticMarkup(<SaleNoticeRegion notice={null} />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("></div>");
    expect(html).not.toMatch(HIDDEN);
  });

  it("holds the notice inside the same region", () => {
    const html = renderToStaticMarkup(
      <SaleNoticeRegion notice={{ message: "Venda cancelada.", ok: true }} />
    );
    expect(html).toMatch(REGION_WITH_ALERT);
    expect(html).toContain("Venda cancelada.");
  });
});
