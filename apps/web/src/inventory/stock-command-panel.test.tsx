import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StockCommandPanel } from "./stock-command-panel";
import type { StockTarget } from "./stock-target";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const target: StockTarget = {
  archived: false,
  movingAverageCost: "12.000000",
  productName: "Camiseta Polaris",
  quantity: 26,
  variantId: "variant-1",
  variantText: "Azul / M",
  version: 3,
};

const noop = () => undefined;

function render(action: "write_off" | "receive", standalone: boolean) {
  return renderToStaticMarkup(
    <StockCommandPanel
      action={action}
      onBalance={noop}
      onClose={noop}
      onReloadList={noop}
      organizationId="org-1"
      standalone={standalone}
      target={target}
      today="2026-11-03"
    />
  );
}

const TITLE_LINE =
  'Saldo atual: 26 · custo médio <span class="whitespace-nowrap">R$ 12,00</span>';

describe("the line under the title of the movement panel", () => {
  it("is left out inside the row, which already says the balance and the cost", () => {
    const html = render("write_off", false);
    expect(html).not.toContain(TITLE_LINE);
    expect(html).not.toContain("Camiseta Polaris");
    expect(html).toContain("Saldo atual: 26 unidades.");
  });

  it("names the variant, the balance and the cost when no row is above it", () => {
    const html = render("write_off", true);
    expect(html).toContain(`Camiseta Polaris · Azul / M. ${TITLE_LINE}`);
    expect(html).toContain("Saldo atual: 26 unidades.");
  });

  it("is left out of the other movements inside the row too", () => {
    expect(render("receive", false)).not.toContain(TITLE_LINE);
    expect(render("receive", true)).toContain(TITLE_LINE);
  });
});
