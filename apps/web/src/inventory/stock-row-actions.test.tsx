import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PANEL_OPEN_REASON_ID, RowActions } from "./stock-row-actions";
import { type StockRow, stockRowActions } from "./stock-list-model";

const DISABLED_ATTR = /\sdisabled=/;
const ARIA_DISABLED_BUTTONS = /<button[^>]*aria-disabled="true"/g;
const BUTTONS = /<button\b/g;
const BUTTON_NAME = /<button\b[^>]*\saria-label="([^"]*)"/g;

const row: StockRow = {
  archived: false,
  costText: "R$ 10,00",
  costUnknown: false,
  id: "variant-1",
  productName: "Camiseta Polaris",
  quantity: 5,
  quantityText: "5",
  skuText: null,
  target: {
    archived: false,
    movingAverageCost: "10.000000",
    productName: "Camiseta Polaris",
    quantity: 5,
    variantId: "variant-1",
    variantText: "Azul / M",
    version: 3,
  },
  tone: "ok",
  variantText: "Azul / M",
};

const noop = () => undefined;

const actions = (disabled: boolean) =>
  renderToStaticMarkup(
    <RowActions disabled={disabled} onOpen={noop} row={row} />
  );

describe("the row buttons while another panel is open", () => {
  it("are aria-disabled, still reachable, and name the line that says why", () => {
    const markup = actions(true);
    expect(markup.match(BUTTONS)).toHaveLength(3);
    expect(markup.match(ARIA_DISABLED_BUTTONS)).toHaveLength(3);
    expect(
      markup.split(`aria-describedby="${PANEL_OPEN_REASON_ID}"`)
    ).toHaveLength(4);
    // `aria-disabled`, not `disabled`: the focus and the screen reader still reach them
    expect(markup).not.toMatch(DISABLED_ATTR);
  });

  it("are plain buttons with no reason when no panel is open", () => {
    const markup = actions(false);
    expect(markup).not.toContain(`aria-disabled="`);
    expect(markup).not.toContain(`aria-describedby="`);
    expect(markup).not.toMatch(DISABLED_ATTR);
  });
});

describe("the row of buttons in a narrow row", () => {
  it("has the three buttons in order, each with its own accessible name (the stacking is measured in e2e/estoque-reflow.e2e.ts)", () => {
    const names = [...actions(false).matchAll(BUTTON_NAME)].map(
      (match) => match[1]
    );
    expect(names).toEqual(stockRowActions(row.target).map(({ name }) => name));
    expect(new Set(names).size).toBe(3);
  });

  it("keeps the group one control with the same name", () => {
    expect(actions(false)).toContain(
      'aria-label="Movimentos de Camiseta Polaris, Azul / M"'
    );
  });
});
