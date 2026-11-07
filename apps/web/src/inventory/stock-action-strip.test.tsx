import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StockActionStrip } from "./stock-action-strip";
import type { StockAttentionLink } from "./stock-list-model";

const link: StockAttentionLink = {
  href: "/inventory?filtro=sem-saldo",
  id: "without-stock",
  text: "1 variante sem saldo",
};
const noop = () => undefined;

describe("StockActionStrip", () => {
  it("draws the links inside the strip", () => {
    const html = renderToStaticMarkup(
      <StockActionStrip links={[link]} onApply={noop} unavailable={false} />
    );
    expect(html).toContain('data-slot="action-strip"');
    expect(html).toContain("1 variante sem saldo");
    expect(html).not.toContain("indisponíveis");
  });

  it("draws nothing while unread, with nothing to do or without a connection", () => {
    expect(
      renderToStaticMarkup(
        <StockActionStrip links={[]} onApply={noop} unavailable={false} />
      )
    ).toBe("");
  });

  it("says the notices are unavailable, and never that nothing needs action, when a read failed", () => {
    const html = renderToStaticMarkup(
      <StockActionStrip links={[]} onApply={noop} unavailable />
    );
    expect(html).toContain("Avisos do estoque indisponíveis agora.");
    expect(html).not.toContain('data-slot="action-strip"');
  });
});
