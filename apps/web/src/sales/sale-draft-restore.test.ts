import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  chosenItemCount,
  clearSaleConsequence,
  draftVariantIds,
  refreshedDraftMessage,
  refreshRestoredItems,
} from "./sale-draft-restore";
import {
  addItem,
  createBlankSaleForm,
  evaluateSaleForm,
  type ItemDraft,
  NO_PROFILE_CHOICE,
  type SaleFormState,
  selectPaymentMethod,
  selectProfileChoice,
  updateItem,
} from "./sale-form-model";

const SHIRT = "0199c2d0-0000-7000-8000-0000000000b1";
const CAP = "0199c2d0-0000-7000-8000-0000000000b2";
const MUG = "0199c2d0-0000-7000-8000-0000000000b3";

function entry(
  variantId: string,
  changes: Partial<InventoryBalanceEntryReadModel> = {}
): InventoryBalanceEntryReadModel {
  return {
    isDefaultVariant: false,
    listPrice: "50.00",
    movingAverageCost: null,
    productId: "0199c2d0-0000-7000-8000-0000000000f1",
    productName: "Camiseta",
    productStatus: "active",
    quantity: 5,
    sku: null,
    updatedAt: null,
    values: [{ optionName: "Cor", optionValueName: "Azul" }],
    variantId,
    version: 1,
    ...changes,
  };
}

function ids() {
  let next = 0;
  return () => {
    next += 1;
    return `draft-${next}`;
  };
}

function line(variantId: string, prices: Partial<ItemDraft> = {}) {
  return {
    chargedUnitPrice: "50,00",
    label: "Antigo",
    listedUnitPrice: "50,00",
    productId: "0199c2d0-0000-7000-8000-0000000000f1",
    quantity: "1",
    variantId,
    ...prices,
  };
}

/** Three lines: the shirt, the cap and the mug, as the cart was left. */
function cartOfThree(): SaleFormState {
  const createId = ids();
  let form = createBlankSaleForm(createId);
  form = addItem(form, createId());
  form = addItem(form, createId());
  form = updateItem(form, "draft-1", line(SHIRT));
  form = updateItem(form, "draft-2", line(CAP, { chargedUnitPrice: "45,00" }));
  form = updateItem(form, "draft-3", line(MUG));
  form = selectPaymentMethod(form, "pix");
  return selectProfileChoice(form, NO_PROFILE_CHOICE, []);
}

describe("a cart that came back from the tab, read again", () => {
  it("takes out the line whose variant left the catalog or whose product was archived, and says how many", () => {
    const form = cartOfThree();
    const readIds = draftVariantIds(form);
    const refreshed = refreshRestoredItems(
      form,
      readIds,
      [entry(SHIRT), entry(CAP, { productStatus: "archived" })],
      ids()
    );

    expect(refreshed.form.items.map((item) => item.variantId)).toEqual([SHIRT]);
    expect(refreshed.removed).toBe(2);
    expect(refreshedDraftMessage(refreshed)).toBe(
      "2 itens saíram do catálogo e foram tirados da venda."
    );
    expect(
      refreshedDraftMessage({ ...refreshed, removed: 1, repriced: 0 })
    ).toBe("1 item saiu do catálogo e foi tirado da venda.");
  });

  it("takes the current list price; a negotiated price stays the person's", () => {
    const form = cartOfThree();
    const refreshed = refreshRestoredItems(
      form,
      draftVariantIds(form),
      [
        entry(SHIRT, { listPrice: "55.00" }),
        entry(CAP, { listPrice: "60.00" }),
        entry(MUG),
      ],
      ids()
    );
    const [shirt, cap, mug] = refreshed.form.items;

    expect(shirt).toMatchObject({
      chargedUnitPrice: "55,00",
      label: "Camiseta · Azul",
      listedUnitPrice: "55,00",
    });
    expect(cap).toMatchObject({
      chargedUnitPrice: "45,00",
      listedUnitPrice: "60,00",
    });
    expect(mug).toMatchObject({ chargedUnitPrice: "50,00" });
    expect(refreshed.repriced).toBe(2);
    expect(refreshedDraftMessage(refreshed)).toBe(
      "O preço de tabela de 2 itens foi atualizado."
    );
  });

  it("the total is computed from the lines that stayed, never kept", () => {
    const form = cartOfThree();
    const refreshed = refreshRestoredItems(
      form,
      draftVariantIds(form),
      [entry(SHIRT, { listPrice: "55.00" })],
      ids()
    );
    const evaluation = evaluateSaleForm(
      refreshed.form,
      { profiles: [], stock: {} },
      { now: new Date("2026-10-28T15:00:00.000Z"), showRequired: false }
    );

    expect(evaluation.summary?.totalDue).toBe("55.00");
  });

  it("judges only the variants read: a line picked after the read stays", () => {
    const form = updateItem(cartOfThree(), "draft-3", line(MUG));
    const refreshed = refreshRestoredItems(form, [SHIRT], [], ids());

    expect(refreshed.form.items.map((item) => item.variantId)).toEqual([
      CAP,
      MUG,
    ]);
    expect(refreshed.removed).toBe(1);
  });

  it("with every line gone, the cart has one empty line to start again", () => {
    const form = cartOfThree();
    const refreshed = refreshRestoredItems(
      form,
      draftVariantIds(form),
      [],
      () => "fresh"
    );

    expect(refreshed.form.items).toEqual(
      createBlankSaleForm(() => "fresh").items
    );
    expect(refreshed.form.payment.method).toBe("pix");
  });

  it("says nothing when the read changed nothing", () => {
    const form = cartOfThree();
    const refreshed = refreshRestoredItems(
      form,
      draftVariantIds(form),
      [entry(SHIRT), entry(CAP), entry(MUG)],
      ids()
    );
    expect(refreshedDraftMessage(refreshed)).toBeNull();
  });
});

describe("Limpar venda", () => {
  it("counts only the lines with a variant chosen, and says the consequence", () => {
    expect(chosenItemCount(cartOfThree())).toBe(3);
    expect(chosenItemCount(createBlankSaleForm(ids()))).toBe(0);
    expect(clearSaleConsequence(3)).toBe("Isso tira os 3 itens da venda.");
    expect(clearSaleConsequence(1)).toBe("Isso tira o item da venda.");
  });
});
