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

function render(
  action: "cost" | "count" | "receive" | "write_off",
  standalone: boolean,
  from: StockTarget = target
) {
  return renderToStaticMarkup(
    <StockCommandPanel
      action={action}
      onBalance={noop}
      onClose={noop}
      onReloadList={noop}
      organizationId="org-1"
      standalone={standalone}
      target={from}
      today="2026-11-03"
    />
  );
}

const TITLE_LINE =
  'Saldo atual: 26 · custo médio <span class="whitespace-nowrap font-mono tabular-nums">R$ 12,00</span>';

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

const OPTIONAL_BADGE =
  '<span class="font-normal text-muted-foreground">Opcional</span>';
const NO_COST: StockTarget = { ...target, movingAverageCost: null };

const labelOf = (html: string, text: string) =>
  new RegExp(`<label[^>]*>${text}( ${OPTIONAL_BADGE})?</label>`).exec(html);

describe("the cost field of the movement panel", () => {
  it.each([
    ["receive", target],
    ["cost", NO_COST],
    ["count", NO_COST],
  ] as const)(
    'is %s\'s "Custo de cada unidade" with the R$ inside the field, never "(R$)" in the label',
    (action, from) => {
      const html = render(action, false, from);
      expect(labelOf(html, "Custo de cada unidade")).not.toBeNull();
      expect(html).toContain(">R$</div>");
      expect(html).not.toContain("(R$)");
      expect(html).not.toContain("Custo unitário");
    }
  );

  it("carries the Opcional badge only when counting, and the hint does not say it again", () => {
    expect(
      labelOf(render("count", false, NO_COST), "Custo de cada unidade")?.[1]
    ).toBe(` ${OPTIONAL_BADGE}`);
    expect(
      labelOf(render("cost", false, NO_COST), "Custo de cada unidade")?.[1]
    ).toBeUndefined();
    expect(
      labelOf(render("receive", false), "Custo de cada unidade")?.[1]
    ).toBeUndefined();
    expect(render("count", false, NO_COST)).toContain(
      "Vale só se a quantidade contada for maior que zero."
    );
    expect(render("count", false, NO_COST)).not.toContain("Opcional. Vale");
  });
});

describe("the note of the write-off", () => {
  it('is "Observação" with the Opcional badge, not "(opcional)" in the label', () => {
    const html = render("write_off", false);
    expect(labelOf(html, "Observação")?.[1]).toBe(` ${OPTIONAL_BADGE}`);
    expect(html).not.toContain("Observação (opcional)");
  });
});
