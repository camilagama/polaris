import { describe, expect, it } from "vitest";
import {
  announceSaleSettled,
  clearSaleDrafts,
  isSaleFormState,
  readSaleDraft,
  SALE_DRAFT_KEY_PREFIX,
  SALE_DRAFT_SHAPE,
  type SaleDraft,
  subscribeSaleSettled,
  writeSaleDraft,
} from "./sale-draft-storage";
import {
  addAdjustment,
  addItem,
  createBlankSaleForm,
  type SaleFormState,
  selectPaymentMethod,
  updateItem,
} from "./sale-form-model";

/** A tab's storage that lists its keys, as `sessionStorage` does. */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER = "0199c2d0-0000-7000-8000-00000000a002";
const SAO_PAULO = "America/Sao_Paulo";
const VARIANT = "0199c2d0-0000-7000-8000-0000000000b1";
const PRODUCT = "0199c2d0-0000-7000-8000-0000000000f1";

function ids() {
  let next = 0;
  return () => {
    next += 1;
    return `draft-${next}`;
  };
}

/** A cart with a shirt, a discount and a method: what a person builds at the counter. */
function cart(): SaleFormState {
  const createId = ids();
  let form = createBlankSaleForm(createId);
  form = updateItem(form, "draft-1", {
    chargedUnitPrice: "49,90",
    label: "Camiseta · Azul",
    listedUnitPrice: "49,90",
    productId: PRODUCT,
    quantity: "2",
    variantId: VARIANT,
  });
  form = addAdjustment(form, createId());
  form = selectPaymentMethod(form, "pix");
  return form;
}

// 23:59 in São Paulo (UTC−3) is already the next day in UTC: the store's day, not the UTC one, decides
const STARTED = "2026-10-28T13:00:00.000Z";
const LAST_MINUTE = new Date("2026-10-29T02:59:00.000Z");
const NEXT_DAY = new Date("2026-10-29T03:00:00.000Z");

describe("the sale draft of the tab", () => {
  it("gives back the same cart after a reload, on the same store day", () => {
    const storage = memoryStorage();
    const draft: SaleDraft = { form: cart(), startedAt: STARTED };
    writeSaleDraft(storage, ORG, draft);

    expect(readSaleDraft(storage, ORG, LAST_MINUTE, SAO_PAULO)).toEqual({
      draft,
      kind: "restored",
    });
  });

  it("ends at the turn of the store's day, in the store's time zone, and is dropped", () => {
    const storage = memoryStorage();
    writeSaleDraft(storage, ORG, { form: cart(), startedAt: STARTED });

    expect(readSaleDraft(storage, ORG, NEXT_DAY, SAO_PAULO)).toEqual({
      kind: "expired",
    });
    expect(storage.data.size).toBe(0);
    // in UTC the same instant is still the 29th for both: the zone of the store is what made it expire
    writeSaleDraft(storage, ORG, {
      form: cart(),
      startedAt: "2026-10-29T01:00:00.000Z",
    });
    expect(readSaleDraft(storage, ORG, NEXT_DAY, "UTC").kind).toBe("restored");
  });

  it("is kept per store: another store never sees it", () => {
    const storage = memoryStorage();
    writeSaleDraft(storage, ORG, { form: cart(), startedAt: STARTED });

    expect(readSaleDraft(storage, OTHER, LAST_MINUTE, SAO_PAULO)).toEqual({
      kind: "none",
    });
    expect([...storage.data.keys()]).toEqual([
      `${SALE_DRAFT_KEY_PREFIX}${ORG}`,
    ]);
  });

  it("drops what does not have the shape this build writes, and says so", () => {
    const cases = [
      "not json",
      JSON.stringify({ form: { items: [] }, startedAt: STARTED }),
      JSON.stringify({ form: cart(), startedAt: "ontem" }),
      // a customer's data is not part of the draft: a field more is refused
      JSON.stringify({
        form: { ...cart(), customer: { name: "Maria", phone: "11999990000" } },
        startedAt: STARTED,
      }),
      JSON.stringify({
        form: {
          ...cart(),
          items: [{ ...cart().items[0], customerName: "Maria" }],
        },
        startedAt: STARTED,
      }),
      JSON.stringify({
        form: { ...cart(), payment: { ...cart().payment, method: "cheque" } },
        startedAt: STARTED,
      }),
      JSON.stringify({
        form: { ...cart(), items: [cart().items[0], cart().items[0]] },
        startedAt: STARTED,
      }),
      JSON.stringify({
        form: {
          ...cart(),
          items: [{ ...cart().items[0], label: "x".repeat(2001) }],
        },
        startedAt: STARTED,
      }),
    ];
    for (const text of cases) {
      const storage = memoryStorage();
      storage.setItem(`${SALE_DRAFT_KEY_PREFIX}${ORG}`, text);

      expect(readSaleDraft(storage, ORG, LAST_MINUTE, SAO_PAULO)).toEqual({
        kind: "unreadable",
      });
      expect(storage.data.size).toBe(0);
    }
  });

  it("accepts every form the screen builds", () => {
    let form = cart();
    form = addItem(form, "another-line");
    form = selectPaymentMethod(form, "credit_card");
    expect(isSaleFormState(form)).toBe(true);
    expect(isSaleFormState(createBlankSaleForm(ids()))).toBe(true);
  });

  it("is forgotten when null is written, and a storage that refuses does not break the screen", () => {
    const storage = memoryStorage();
    writeSaleDraft(storage, ORG, { form: cart(), startedAt: STARTED });
    writeSaleDraft(storage, ORG, null);
    expect(storage.data.size).toBe(0);

    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(() =>
      writeSaleDraft(refusing, ORG, { form: cart(), startedAt: STARTED })
    ).not.toThrow();
    expect(readSaleDraft(refusing, ORG, LAST_MINUTE, SAO_PAULO)).toEqual({
      kind: "none",
    });
    expect(readSaleDraft(null, ORG, LAST_MINUTE, SAO_PAULO)).toEqual({
      kind: "none",
    });
  });

  it("clears every store's draft, or all but the store just chosen, and nothing else of the tab", () => {
    const storage = memoryStorage();
    writeSaleDraft(storage, ORG, { form: cart(), startedAt: STARTED });
    writeSaleDraft(storage, OTHER, { form: cart(), startedAt: STARTED });
    storage.setItem("polaris.sale.attempt.v1:x", "{}");

    clearSaleDrafts(storage, OTHER);
    expect([...storage.data.keys()].sort()).toEqual([
      "polaris.sale.attempt.v1:x",
      `${SALE_DRAFT_KEY_PREFIX}${OTHER}`,
    ]);

    clearSaleDrafts(storage);
    expect([...storage.data.keys()]).toEqual(["polaris.sale.attempt.v1:x"]);
  });
});

/**
 * A field added to or taken from the sale form changes what a draft of the previous build holds: the version in the
 * key goes up in the same change (the old drafts are then simply not read). This pins the two together: changing the
 * shape fails here until the key and this list are updated side by side.
 */
describe("the shape of the draft and the version of its key", () => {
  it("v1 holds exactly these fields, the ones the blank form has", () => {
    const blank = createBlankSaleForm(ids());
    const keys = (value: object) => Object.keys(value).sort();
    expect(SALE_DRAFT_KEY_PREFIX).toBe("polaris.sale.draft.v1:");
    expect({
      form: keys(blank),
      item: keys(blank.items[0] ?? {}),
      payment: keys(blank.payment),
      profile: keys(blank.profile),
    }).toEqual({
      form: [...SALE_DRAFT_SHAPE.form],
      item: [...SALE_DRAFT_SHAPE.item],
      payment: [...SALE_DRAFT_SHAPE.payment],
      profile: [...SALE_DRAFT_SHAPE.profile],
    });
    expect(keys(addAdjustment(blank, "a").adjustments[0] ?? {})).toEqual([
      ...SALE_DRAFT_SHAPE.adjustment,
    ]);
    expect(SALE_DRAFT_SHAPE).toEqual({
      adjustment: ["draftId", "kind", "value", "valueType"],
      form: ["adjustments", "items", "occurredAtLocal", "payment", "profile"],
      item: [
        "chargedUnitPrice",
        "draftId",
        "label",
        "listedUnitPrice",
        "productId",
        "quantity",
        "variantId",
      ],
      payment: [
        "anticipationRequested",
        "installmentPlan",
        "installments",
        "method",
      ],
      profile: ["choice", "reviewNotice", "seenVersion"],
    });
  });
});

describe("a sale settled while another Vender of the page shows its cart", () => {
  it("is told to every Vender listening, with the store and the command", () => {
    const heard: string[] = [];
    const stop = subscribeSaleSettled((organizationId, commandId) =>
      heard.push(`${organizationId}:${commandId}`)
    );
    announceSaleSettled(ORG, "command-1");
    stop();
    announceSaleSettled(ORG, "command-2");

    expect(heard).toEqual([`${ORG}:command-1`]);
  });
});
