import { describe, expect, it } from "vitest";
import { readSaleAttempt, writeSaleAttempt } from "./sale-attempt-storage";
import { readSaleDraft, writeSaleDraft } from "./sale-draft-storage";
import {
  createBlankSaleForm,
  evaluateSaleForm,
  NO_PROFILE_CHOICE,
  prepareConfirmation,
  type SaleAttempt,
  type SaleFormState,
  selectPaymentMethod,
  selectProfileChoice,
  updateItem,
} from "./sale-form-model";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const STARTED = new Date("2026-10-28T15:00:00.000Z");
const CLICKED = new Date("2026-10-28T15:02:00.000Z");
// past the 30 min an attempt lasts alone
const RELOADED = new Date("2026-10-28T16:00:00.000Z");

function cart(): SaleFormState {
  let form = createBlankSaleForm(() => "draft-1");
  form = updateItem(form, "draft-1", {
    chargedUnitPrice: "49,90",
    label: "Camiseta · Azul",
    listedUnitPrice: "49,90",
    productId: "0199c2d0-0000-7000-8000-0000000000f1",
    quantity: "1",
    variantId: "0199c2d0-0000-7000-8000-0000000000b1",
  });
  form = selectPaymentMethod(form, "pix");
  return selectProfileChoice(form, NO_PROFILE_CHOICE, []);
}

let created = 0;
const newId = () => {
  created += 1;
  return `0199c2d0-0000-7000-8000-${String(created).padStart(12, "0")}`;
};

function confirmation(
  form: SaleFormState,
  now: Date,
  previous: SaleAttempt | null
) {
  const { body } = evaluateSaleForm(
    form,
    { profiles: [], stock: {} },
    { now, showRequired: true }
  );
  if (body === null) {
    throw new Error("the cart must be valid");
  }
  const prepared = prepareConfirmation({
    body,
    createId: newId,
    now,
    organizationId: ORG,
    previousAttempt: previous,
  });
  if (!prepared.ok) {
    throw new Error(prepared.message);
  }
  return prepared;
}

/**
 * Confirm, the answer is lost, the app reloads, the cart comes back and is confirmed again: the second request carries
 * the first command ID, which the server replays instead of recording a second sale.
 */
describe("a lost answer, a reload and the same cart confirmed again", () => {
  it("send the same command ID: one sale", () => {
    const tab = memoryStorage();
    const startedAt = STARTED.toISOString();
    writeSaleDraft(tab, ORG, { form: cart(), startedAt });
    const first = confirmation(cart(), CLICKED, null);
    // sent, and no answer: the outcome is unknown
    writeSaleAttempt(tab, ORG, first.attempt, true);

    const restored = readSaleDraft(tab, ORG, RELOADED, "America/Sao_Paulo");
    if (restored.kind !== "restored") {
      throw new Error("the draft must come back");
    }
    const previous = readSaleAttempt(
      tab,
      ORG,
      RELOADED,
      restored.draft.startedAt
    );
    const second = confirmation(restored.draft.form, RELOADED, previous);

    expect(second.request.commandId).toBe(first.request.commandId);
    expect(second.request.occurredAt).toBe(first.request.occurredAt);
  });

  it("without the draft the attempt alone has expired: a new command ID", () => {
    const tab = memoryStorage();
    const first = confirmation(cart(), CLICKED, null);
    writeSaleAttempt(tab, ORG, first.attempt, true);

    const previous = readSaleAttempt(tab, ORG, RELOADED);
    const second = confirmation(cart(), RELOADED, previous);

    expect(second.request.commandId).not.toBe(first.request.commandId);
  });
});
