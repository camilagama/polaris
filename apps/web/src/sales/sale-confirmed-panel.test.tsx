import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConfirmedSalePanel } from "./sale-confirmed-panel";
import type { ConfirmedSaleView } from "./sale-form-model";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const SALE_ID = "77777777-7777-4777-8777-777777777777";

const SALE: ConfirmedSaleView = {
  headline: "Venda confirmada.",
  items: [],
  note: "O método de pagamento registrado não comprova liquidação.",
  paymentDetails: [],
  replayed: false,
  saleDetails: [{ label: "Venda", tone: "plain", value: SALE_ID }],
  saleId: SALE_ID,
  totals: [],
};

const LINE = '1ª venda registrada. Veja o Hoje no <a aria-label="Ver o Início"';

const render = (firstSale: boolean) =>
  renderToStaticMarkup(
    <ConfirmedSalePanel
      firstSale={firstSale}
      organizationId="loja-a"
      panelRef={createRef()}
      sale={SALE}
    />
  );

describe("the panel of a confirmed sale", () => {
  it("says it was the first sale, with the two links, as the last line of the card", () => {
    const html = render(true);
    expect(html).toContain(LINE);
    expect(html).toContain('href="/"');
    expect(html).toContain('aria-label="Ver o Resultado"');
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain(" e o resultado estimado em ");
    expect(html.lastIndexOf("1ª venda registrada")).toBeGreaterThan(
      html.indexOf("Ver detalhes e histórico da venda")
    );
    expect(html.lastIndexOf("Resultado</a>.")).toBeGreaterThan(
      html.indexOf("Associar cliente")
    );
  });

  it("has the line described by the panel, with no figure and no promise of profit", () => {
    const html = render(true);
    expect(html).toContain('aria-describedby="sale-first-sale-line"');
    expect(html).toContain('id="sale-first-sale-line"');
    const line = html.slice(
      html.indexOf(">", html.indexOf('id="sale-first-sale-line"')) + 1
    );
    const text = line
      .slice(0, line.indexOf("</p>"))
      .split("<")
      .map((part) => part.slice(part.indexOf(">") + 1))
      .join("");
    expect(text).toBe(
      "1ª venda registrada. Veja o Hoje no Início e o resultado estimado em Resultado."
    );
    expect(text).not.toContain("R$");
    expect(text).not.toContain("lucro");
    expect(html).not.toContain("animate");
  });

  it("gives the two links a 44 px area to touch", () => {
    const links = render(true).match(/<a [^>]*aria-label="Ver o [^>]*>/g);
    expect(links).toHaveLength(2);
    for (const link of links ?? []) {
      expect(link).toContain("touch-hit");
    }
  });

  it("has no line on any other sale", () => {
    const html = render(false);
    expect(html).not.toContain("1ª venda registrada");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("Ver o Início");
  });
});
