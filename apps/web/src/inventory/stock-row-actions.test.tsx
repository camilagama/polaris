import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type StockRow, stockRows } from "./stock-list-model";
import {
  PANEL_OPEN_REASON_ID,
  RowActions,
  triggerId,
} from "./stock-row-actions";

const DISABLED_ATTR = /\sdisabled=/;
const ARIA_DISABLED_BUTTONS = /<button[^>]*aria-disabled="true"/g;
const BUTTONS = /<button\b/g;
const BUTTON_NAME = /<button\b[^>]*\saria-label="([^"]*)"/g;
const BUTTON_LABEL = /<button\b[^>]*>([^<]*)<\/button>/g;
const BUTTON_ID = /<button\b[^>]*\sid="([^"]*)"/g;
const BUTTON_ACTION = /<button\b[^>]*\sdata-stock-action="([^"]*)"/g;

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
    const markup = actions(false);
    const names = [...markup.matchAll(BUTTON_NAME)].map((match) => match[1]);
    expect(names).toEqual([
      "Receber estoque de Camiseta Polaris, Azul / M",
      "Contar estoque de Camiseta Polaris, Azul / M",
      "Baixar estoque de Camiseta Polaris, Azul / M",
    ]);
    const labels = [...markup.matchAll(BUTTON_LABEL)].map((match) => match[1]);
    expect(labels).toEqual(["Receber", "Contar", "Baixar"]);
  });

  it("keeps the group one control with the same name", () => {
    expect(actions(false)).toContain(
      'aria-label="Movimentos de Camiseta Polaris, Azul / M"'
    );
  });
});

const entry = (
  overrides: Partial<InventoryBalanceEntryReadModel>
): InventoryBalanceEntryReadModel => ({
  isDefaultVariant: false,
  listPrice: null,
  movingAverageCost: "10.000000",
  productId: "11111111-1111-4111-8111-111111111111",
  productName: "Camiseta Polaris",
  productStatus: "active",
  quantity: 5,
  sku: null,
  updatedAt: "2026-10-09T12:00:00.000Z",
  values: [
    { optionName: "color", optionValueName: "Azul" },
    { optionName: "size", optionValueName: "M" },
  ],
  variantId: "variant-1",
  version: 3,
  ...overrides,
});

const markupOf = (
  overrides: Partial<InventoryBalanceEntryReadModel>,
  costUnavailable = false
) => {
  const [built] = stockRows([entry(overrides)], costUnavailable);
  if (!built) {
    throw new Error("no row");
  }
  return {
    built,
    markup: renderToStaticMarkup(
      <RowActions disabled={false} onOpen={noop} row={built} />
    ),
  };
};

const read = (markup: string, pattern: RegExp) =>
  [...markup.matchAll(pattern)].map((match) => match[1]);

describe("the row buttons for each real state of a variant", () => {
  it("unknown cost with units: Informar custo stands where Contar was, with the same id", () => {
    const { built, markup } = markupOf({
      movingAverageCost: null,
      quantity: 3,
    });
    expect(built.costUnknown).toBe(true);
    expect(built.target.movingAverageCost).toBeNull();
    expect(read(markup, BUTTON_NAME)).toEqual([
      "Receber estoque de Camiseta Polaris, Azul / M",
      "Informar custo de Camiseta Polaris, Azul / M",
      "Baixar estoque de Camiseta Polaris, Azul / M",
    ]);
    expect(read(markup, BUTTON_LABEL)).toEqual([
      "Receber",
      "Informar custo",
      "Baixar",
    ]);
    expect(read(markup, BUTTON_ACTION)).toEqual([
      "receive",
      "cost",
      "write_off",
    ]);
    expect(read(markup, BUTTON_ID)).toEqual([
      "stock-trigger-variant-1-receive",
      "stock-trigger-variant-1-count",
      "stock-trigger-variant-1-write_off",
    ]);
  });

  it("the id of Informar custo is the id Contar has once the cost is known", () => {
    const unknown = markupOf({ movingAverageCost: null, quantity: 3 });
    const known = markupOf({ quantity: 3 });
    const [, costId] = read(unknown.markup, BUTTON_ID);
    expect(costId).toBe(triggerId("variant-1", "cost"));
    expect(costId).toBe(triggerId("variant-1", "count"));
    expect(read(known.markup, BUTTON_LABEL)[1]).toBe("Contar");
    expect(read(known.markup, BUTTON_ID)[1]).toBe(costId);
  });

  it("no units and no cost: Dar entrada, then Contar and Baixar", () => {
    const { built, markup } = markupOf({
      movingAverageCost: null,
      quantity: 0,
    });
    expect(built.costUnknown).toBe(true);
    expect(read(markup, BUTTON_NAME)).toEqual([
      "Dar entrada no estoque de Camiseta Polaris, Azul / M",
      "Contar estoque de Camiseta Polaris, Azul / M",
      "Baixar estoque de Camiseta Polaris, Azul / M",
    ]);
    expect(read(markup, BUTTON_LABEL)).toEqual([
      "Dar entrada",
      "Contar",
      "Baixar",
    ]);
    expect(read(markup, BUTTON_ID)).toEqual([
      "stock-trigger-variant-1-receive",
      "stock-trigger-variant-1-count",
      "stock-trigger-variant-1-write_off",
    ]);
  });

  it("known cost with no units keeps Receber, Contar and Baixar", () => {
    const { markup } = markupOf({ quantity: 0 });
    expect(read(markup, BUTTON_LABEL)).toEqual(["Receber", "Contar", "Baixar"]);
  });

  it("without a connection the unknown cost is not known: the three stay as they are", () => {
    const withUnits = markupOf({ movingAverageCost: null, quantity: 3 }, true);
    expect(withUnits.built.costUnknown).toBe(false);
    expect(read(withUnits.markup, BUTTON_NAME)).toEqual([
      "Receber estoque de Camiseta Polaris, Azul / M",
      "Contar estoque de Camiseta Polaris, Azul / M",
      "Baixar estoque de Camiseta Polaris, Azul / M",
    ]);
    expect(read(withUnits.markup, BUTTON_LABEL)).toEqual([
      "Receber",
      "Contar",
      "Baixar",
    ]);
    const noUnits = markupOf({ movingAverageCost: null, quantity: 0 }, true);
    expect(read(noUnits.markup, BUTTON_LABEL)).toEqual([
      "Receber",
      "Contar",
      "Baixar",
    ]);
  });

  it("an archived product changes no button, with a known or an unknown cost", () => {
    const known = markupOf({ productStatus: "archived", quantity: 3 });
    expect(known.built.archived).toBe(true);
    expect(read(known.markup, BUTTON_LABEL)).toEqual([
      "Receber",
      "Contar",
      "Baixar",
    ]);
    const unknown = markupOf({
      movingAverageCost: null,
      productStatus: "archived",
      quantity: 3,
    });
    expect(unknown.built.archived).toBe(true);
    expect(read(unknown.markup, BUTTON_NAME)).toEqual([
      "Receber estoque de Camiseta Polaris, Azul / M",
      "Informar custo de Camiseta Polaris, Azul / M",
      "Baixar estoque de Camiseta Polaris, Azul / M",
    ]);
    expect(read(unknown.markup, BUTTON_ID)[1]).toBe(
      "stock-trigger-variant-1-count"
    );
  });

  it("an archived product with no units and no cost still offers Dar entrada", () => {
    const { built, markup } = markupOf({
      movingAverageCost: null,
      productStatus: "archived",
      quantity: 0,
    });
    expect(built.archived).toBe(true);
    expect(read(markup, BUTTON_LABEL)).toEqual([
      "Dar entrada",
      "Contar",
      "Baixar",
    ]);
  });

  it("a variant without options is named by its fallback text in the group and the buttons", () => {
    const { markup } = markupOf({
      isDefaultVariant: true,
      movingAverageCost: null,
      quantity: 3,
      values: [],
    });
    expect(markup).toContain(
      'aria-label="Movimentos de Camiseta Polaris, Variante padrão"'
    );
    expect(read(markup, BUTTON_NAME)).toEqual([
      "Receber estoque de Camiseta Polaris, Variante padrão",
      "Informar custo de Camiseta Polaris, Variante padrão",
      "Baixar estoque de Camiseta Polaris, Variante padrão",
    ]);
  });
});
