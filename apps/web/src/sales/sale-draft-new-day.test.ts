import { describe, expect, it } from "vitest";
import { DRAFT_EXPIRED_MESSAGE, draftNewDayNotice } from "./sale-draft-restore";
import { readSaleDraft, writeSaleDraft } from "./sale-draft-storage";
import {
  createBlankSaleForm,
  evaluateSaleForm,
  NO_PROFILE_CHOICE,
  prepareConfirmation,
  type SaleFormState,
  selectPaymentMethod,
  selectProfileChoice,
  updateItem,
} from "./sale-form-model";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const SAO_PAULO = "America/Sao_Paulo";
const VARIANT = "0199c2d0-0000-7000-8000-0000000000b1";
const PRODUCT = "0199c2d0-0000-7000-8000-0000000000f1";

// 23:50 in São Paulo (UTC−3), the evening before
const STARTED = "2026-11-11T02:50:00.000Z";
const AT_0005 = new Date("2026-11-11T03:05:00.000Z");
const SAME_DAY = new Date("2026-11-11T02:55:00.000Z");
const TWO_DAYS_LATER = new Date("2026-11-12T03:05:00.000Z");

const ONLINE_TEXT =
  "Esta venda começou ontem. Ela será registrada com a data de hoje, a não ser que você preencha “Data e hora da venda”.";

const notice = (changes: Partial<Parameters<typeof draftNewDayNotice>[0]>) =>
  draftNewDayNotice({
    dateEmpty: true,
    now: AT_0005,
    offline: false,
    startedAt: STARTED,
    timezone: SAO_PAULO,
    ...changes,
  });

describe("the notice of a cart that began on another store day", () => {
  it("says it began yesterday and will be dated today, with the date empty", () => {
    expect(notice({})).toBe(ONLINE_TEXT);
  });

  it("says nothing with a date typed, on the same day, or without a cart", () => {
    expect(notice({ dateEmpty: false })).toBeNull();
    expect(notice({ now: SAME_DAY })).toBeNull();
    expect(notice({ startedAt: null })).toBeNull();
  });

  it("appears for a cart left on the screen when the clock passes midnight", () => {
    expect(notice({ now: SAME_DAY })).toBeNull();
    expect(notice({ now: AT_0005 })).toBe(ONLINE_TEXT);
  });

  it("says another day when it began before yesterday", () => {
    expect(notice({ now: TWO_DAYS_LATER })).toBe(
      "Esta venda começou em outro dia. Ela será registrada com a data de hoje, a não ser que você preencha “Data e hora da venda”."
    );
  });

  it("without a connection, ends at the date of today: there is no date field", () => {
    expect(notice({ dateEmpty: false, offline: true })).toBeNull();
    expect(notice({ offline: true })).toBe(
      "Esta venda começou ontem. Ela será registrada com a data de hoje."
    );
  });

  it("uses the store's day, not the UTC one", () => {
    // 23:30 in São Paulo is already the next day in UTC
    expect(
      notice({
        now: new Date("2026-11-11T02:40:00.000Z"),
        startedAt: "2026-11-11T02:30:00.000Z",
      })
    ).toBeNull();
  });
});

describe("the discard says why", () => {
  it("is about the time it sat still, not about another day", () => {
    expect(DRAFT_EXPIRED_MESSAGE).toBe(
      "A venda em andamento ficou parada por muito tempo e foi descartada."
    );
  });
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function cart(): SaleFormState {
  let form = createBlankSaleForm(() => "draft-1");
  form = updateItem(form, "draft-1", {
    chargedUnitPrice: "49,90",
    label: "Camiseta · Azul",
    listedUnitPrice: "49,90",
    productId: PRODUCT,
    quantity: "1",
    variantId: VARIANT,
  });
  form = selectPaymentMethod(form, "pix");
  return selectProfileChoice(form, NO_PROFILE_CHOICE, []);
}

describe("a cart restored after midnight keeps the date empty: it is dated at the confirmation", () => {
  it("carries no typed date, and the sale gets the instant of the new day", () => {
    const storage = memoryStorage();
    writeSaleDraft(storage, ORG, {
      form: cart(),
      startedAt: STARTED,
      updatedAt: STARTED,
    });
    const read = readSaleDraft(storage, ORG, AT_0005, SAO_PAULO);
    if (read.kind !== "restored") {
      throw new Error("the cart must come back at 00:05");
    }
    expect(read.draft.form.occurredAtLocal).toBe("");

    const evaluation = evaluateSaleForm(
      read.draft.form,
      { profiles: [], stock: {} },
      { now: AT_0005, showRequired: true }
    );
    expect(evaluation.occurredAtOverride).toBeNull();
    if (evaluation.body === null) {
      throw new Error("the cart must be valid");
    }
    const prepared = prepareConfirmation({
      attemptUnsettled: false,
      body: evaluation.body,
      createId: () => "0199c2d0-0000-7000-8000-000000000001",
      now: AT_0005,
      occurredAtOverride: evaluation.occurredAtOverride,
      organizationId: ORG,
      previousAttempt: null,
    });
    if (!prepared.ok) {
      throw new Error(prepared.message);
    }
    expect(prepared.request.occurredAt).toBe(AT_0005.toISOString());
  });
});

describe("the draft of the redo of a refused sale", () => {
  const redoDraft = () => ({
    form: cart(),
    startedAt: STARTED,
    updatedAt: STARTED,
  });

  it("is read at 05:50 and dropped at 05:51 after it was made at 23:50", () => {
    const storage = memoryStorage();
    writeSaleDraft(storage, ORG, redoDraft());
    expect(
      readSaleDraft(
        storage,
        ORG,
        new Date("2026-11-11T08:50:00.000Z"),
        SAO_PAULO
      ).kind
    ).toBe("restored");
    expect(
      readSaleDraft(
        storage,
        ORG,
        new Date("2026-11-11T08:51:00.000Z"),
        SAO_PAULO
      ).kind
    ).toBe("expired");
  });
});
