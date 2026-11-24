import type { PaymentProfileReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  paymentOfSentForm,
  salePresetFrom,
  writeLastPayment,
} from "./last-payment-model";
import { refreshedDraftMessage } from "./sale-draft-restore";
import {
  acknowledgeProfileReview,
  acknowledgeSecondProfileReview,
  applySalePreset,
  applySplitAction,
  createBlankSaleForm,
  endSplit,
  evaluateSaleForm,
  isSaleFormDirty,
  NO_PROFILE_CHOICE,
  prepareConfirmation,
  reconcileProfileReload,
  type SaleCommandBody,
  type SaleFormState,
  selectItemProduct,
  selectItemVariant,
  selectPaymentMethod,
  selectProfileChoice,
  selectSecondPaymentMethod,
  selectSecondProfileChoice,
  setFirstPartAmount,
  setSecondPartAmount,
  sharedProfileReview,
  startSplit,
  updateItem,
  updateSecondPayment,
} from "./sale-form-model";
import { SHARED_PROFILE_REVIEW_MESSAGE } from "./sale-split-model";

const productId = "11111111-1111-4111-8111-111111111111";
const variantId = "22222222-2222-4222-8222-222222222222";
const profileId = "44444444-4444-4444-8444-444444444444";
const ruleCardId = "55555555-5555-4555-8555-555555555555";
const noFee = { fixedAmount: null, mode: "none", percentage: null } as const;
const NOW = new Date("2026-11-02T15:00:00.000Z");
const TOTAL_MOVED_ENDING = / O total mudou\. Confira as partes\.$/;

function sequentialIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

function profile(version = 3): PaymentProfileReadModel {
  return {
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: profileId,
    name: "Maquininha Aurora",
    organizationId: "org_1",
    rules: [
      {
        anticipationFee: noFee,
        expectedSettlementDays: 30,
        id: ruleCardId,
        installmentPlan: "merchant",
        installments: 3,
        method: "credit_card",
        processingFee: {
          fixedAmount: null,
          mode: "percentage",
          percentage: "2.99",
        },
      },
    ],
    status: "active",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version,
  };
}

function evaluate(form: SaleFormState, profiles = [profile()]) {
  return evaluateSaleForm(
    form,
    { profiles, stock: {} },
    { now: NOW, showRequired: true }
  );
}

/** One line of 1 × `price`, paid with Pix and no profile: a sale of one part. */
function saleOf(price: string): SaleFormState {
  let form = createBlankSaleForm(sequentialIds());
  const draftId = form.items[0]?.draftId ?? "";
  form = selectItemProduct(form, draftId, productId);
  form = selectItemVariant(form, draftId, variantId, "Camiseta — Azul / M");
  form = updateItem(form, draftId, {
    chargedUnitPrice: price,
    listedUnitPrice: price,
    quantity: "1",
  });
  form = selectPaymentMethod(form, "pix");
  return selectProfileChoice(form, NO_PROFILE_CHOICE, []);
}

/** A sale of `price` split in Pix (`first`) and cash (the rest), the second part with "Sem perfil". */
function splitSale(price: string, first: string): SaleFormState {
  let form = startSplit(saleOf(price));
  form = setFirstPartAmount(form, first, null);
  form = selectSecondPaymentMethod(form, "cash");
  return selectSecondProfileChoice(form, NO_PROFILE_CHOICE, []);
}

function bodyOf(form: SaleFormState): SaleCommandBody {
  const { body } = evaluate(form);
  if (body === null) {
    throw new Error("expected a body");
  }
  return body;
}

describe("a sale paid in one part", () => {
  it("builds the same command as always: payment and paymentProfile, no parts", () => {
    const evaluation = evaluate(saleOf("100,01"));
    expect(evaluation.body).toEqual({
      adjustments: [],
      commandVersion: 1,
      items: [
        {
          chargedUnitPrice: "100.01",
          listedUnitPrice: "100.01",
          quantity: 1,
          variantId,
        },
      ],
      payment: {
        anticipationRequested: false,
        installmentPlan: null,
        installments: null,
        method: "pix",
      },
      paymentProfile: null,
    });
    expect(evaluation.body).not.toHaveProperty("payments");
    expect(evaluation.split).toBeNull();
    expect(evaluation.firstIssueKey).toBeNull();
  });

  it("keeps the texts of a payment without parts", () => {
    const blank = saleOf("10,00");
    const form = selectPaymentMethod(blank, "");
    expect(evaluate(form).errors["payment:method"]).toBe(
      "Escolha o método de pagamento."
    );
    expect(evaluate(form).firstIssueKey).toBe("payment:method");
  });
});

describe("a sale paid in two parts", () => {
  it("builds payments with the amount and the profile of each part, and no payment", () => {
    let form = splitSale("100,01", "33,33");
    form = selectSecondProfileChoice(form, profileId, [profile()]);
    const evaluation = evaluate(form);

    expect(evaluation.body?.payments).toEqual([
      {
        amount: "33.33",
        anticipationRequested: false,
        installmentPlan: null,
        installments: null,
        method: "pix",
        paymentProfile: null,
      },
      {
        amount: "66.68",
        anticipationRequested: false,
        installmentPlan: null,
        installments: null,
        method: "cash",
        paymentProfile: { expectedVersion: 3, id: profileId },
      },
    ]);
    expect(evaluation.body).not.toHaveProperty("payment");
    expect(evaluation.body).not.toHaveProperty("paymentProfile");
    expect(evaluation.firstIssueKey).toBeNull();
  });

  it("takes the amount typed in part 2 and sends it as typed", () => {
    const form = setSecondPartAmount(
      splitSale("100,01", "40,00"),
      "60,01",
      "100.01"
    );
    expect(
      bodyOf(form).payments?.map((part) => (part as { amount: string }).amount)
    ).toEqual(["40.00", "60.01"]);
  });

  it("is accepted by the same check the server runs, and the request carries the parts", () => {
    const prepared = prepareConfirmation({
      body: bodyOf(splitSale("100,01", "33,33")),
      createId: sequentialIds(),
      now: NOW,
      organizationId: "org_1",
      previousAttempt: null,
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.request.payments).toHaveLength(2);
      expect(prepared.request.payment).toBeUndefined();
    }
  });

  it("previews the fees of each part on its own amount", () => {
    let form = splitSale("100,00", "40,00");
    form = selectSecondPaymentMethod(form, "credit_card");
    form = updateSecondPayment(form, {
      installmentPlan: "merchant",
      installments: "3",
    });
    form = selectSecondProfileChoice(form, profileId, [profile()]);
    const { split } = evaluate(form);

    expect(split?.partPreviews[0]?.profileText).toBe("Sem perfil de pagamento");
    expect(split?.partPreviews[1]?.profileText).toBe("Maquininha Aurora");
    expect(split?.partPreviews[1]?.processing.text).toContain("1,79");
  });

  it("follows the total with the rest in part 2 until the person types there", () => {
    let form = splitSale("100,01", "33,33");
    expect(evaluate(form).split?.balance?.second).toBe(6668n);

    form = setFirstPartAmount(form, "50,00", "100.01");
    expect(evaluate(form).split?.balance?.second).toBe(5001n);
    expect(
      bodyOf(form).payments?.map((part) => (part as { amount: string }).amount)
    ).toEqual(["50.00", "50.01"]);

    form = setSecondPartAmount(form, "50,01", "100.01");
    form = setFirstPartAmount(form, "30,00", "100.01");
    expect(evaluate(form).split?.balance?.second).toBe(5001n);
    expect(evaluate(form).split?.balance?.kind).toBe("short");
  });
});

describe("parts that do not close the total", () => {
  it("builds no command, says Falta and points at the second amount", () => {
    const form = setSecondPartAmount(
      splitSale("100,01", "33,33"),
      "60,00",
      "100.01"
    );
    const evaluation = evaluate(form);

    expect(evaluation.body).toBeNull();
    expect(evaluation.split?.balance?.text).toBe("Falta R$ 6,68");
    expect(evaluation.errors["payment2:amount"]).toBe(
      "A soma das partes precisa ser R$ 100,01. Falta R$ 6,68."
    );
    expect(evaluation.split?.mismatchKey).toBe("payment2:amount");
    expect(evaluation.firstIssueKey).toBe("payment2:amount");
  });

  it("builds no command and says Passou; the change hint comes only with the cash part", () => {
    let form = setSecondPartAmount(
      splitSale("100,00", "40,00"),
      "110,00",
      "100.00"
    );
    expect(evaluate(form).body).toBeNull();
    expect(evaluate(form).errors["payment2:amount"]).toBe(
      "A soma das partes precisa ser R$ 100,00. Passou R$ 50,00."
    );
    expect(evaluate(form).split?.balance?.hint).toBe(
      "Se for troco, a parte em dinheiro é R$ 60,00."
    );

    form = selectSecondPaymentMethod(form, "pix");
    expect(evaluate(form).split?.balance?.hint).toBeNull();
  });

  it("closes again with the action that puts the difference in part 2", () => {
    let form = setSecondPartAmount(
      splitSale("100,00", "40,00"),
      "50,00",
      "100.00"
    );
    const action = evaluate(form).split?.balance?.action;
    expect(action?.label).toBe("Pôr na parte 2");
    form = applySplitAction(form, action ?? { amount: 0n }, "100.00");
    expect(evaluate(form).split?.balance?.kind).toBe("closed");
    expect(evaluate(form).body).not.toBeNull();
  });

  it("puts the Passou of a first part bigger than the total at the first part, not at the rest", () => {
    const evaluation = evaluate(splitSale("100,00", "120,00"));
    expect(evaluation.body).toBeNull();
    expect(evaluation.errors["payment:amount"]).toBe(
      "A soma das partes precisa ser R$ 100,00. Passou R$ 20,00."
    );
    expect(evaluation.split?.mismatchKey).toBe("payment:amount");
    expect(evaluation.firstIssueKey).toBe("payment:amount");
  });

  it("sums up the profile of each part", () => {
    let form = splitSale("100,00", "40,00");
    form = selectProfileChoice(form, profileId, [profile()]);
    expect(evaluate(form).profileText).toBe(
      "Maquininha Aurora + Sem perfil de pagamento (taxas e prazo desconhecidos)"
    );
    expect(evaluate(form).methodText).toBe("Pix + Dinheiro");
  });

  it("refuses a part 2 with nothing left for it, with its own message", () => {
    const evaluation = evaluate(splitSale("100,00", "100,00"));
    expect(evaluation.body).toBeNull();
    expect(evaluation.errors["payment2:amount"]).toBe(
      "O valor da parte 2 deve ser maior que zero."
    );
  });

  it("says the total moved when typed parts met another total, and not when part 2 is the rest", () => {
    const typed = setSecondPartAmount(
      splitSale("100,00", "40,00"),
      "60,00",
      "100.00"
    );
    const moved = updateItem(typed, typed.items[0]?.draftId ?? "", {
      chargedUnitPrice: "120,00",
      listedUnitPrice: "120,00",
    });
    const evaluation = evaluate(moved);
    expect(evaluation.split?.totalChangedNotice).toBe(
      "O total mudou. Confira as partes."
    );
    expect(evaluation.errors["payment2:amount"]).toBe(
      "A soma das partes precisa ser R$ 120,00. Falta R$ 20,00. O total mudou. Confira as partes."
    );

    const followed = updateItem(
      splitSale("100,00", "40,00"),
      typed.items[0]?.draftId ?? "",
      { chargedUnitPrice: "120,00", listedUnitPrice: "120,00" }
    );
    expect(evaluate(followed).split?.totalChangedNotice).toBeNull();
    expect(evaluate(followed).split?.balance?.kind).toBe("closed");
  });

  it("says it in the message of a restored cart that was repriced", () => {
    const typed = setSecondPartAmount(
      splitSale("100,00", "40,00"),
      "60,00",
      "100.00"
    );
    const repriced = [
      {
        chargedUnitPrice: "120,00",
        followedList: true,
        label: "Camiseta",
        listPrice: "120.00",
      },
    ];
    expect(
      refreshedDraftMessage({ form: typed, removed: [], repriced })
    ).toMatch(TOTAL_MOVED_ENDING);
    expect(
      refreshedDraftMessage({
        form: splitSale("100,00", "40,00"),
        removed: [],
        repriced,
      })
    ).not.toContain("O total mudou");
    expect(
      refreshedDraftMessage({ form: typed, removed: [], repriced: [] })
    ).toBeNull();
  });
});

describe("the validation of each part", () => {
  it("names the part and points at the first field with a problem, in the order of the screen", () => {
    let form = startSplit(saleOf("100,00"));
    form = selectPaymentMethod(form, "");
    const evaluation = evaluate(form);

    expect(evaluation.body).toBeNull();
    expect(evaluation.firstIssueKey).toBe("payment:method");
    expect(evaluation.errors).toMatchObject({
      "payment2:method": "Escolha o método da parte 2.",
      "payment:amount": "Informe o valor da parte 1.",
      "payment:method": "Escolha o método da parte 1.",
      profile2: "Escolha um perfil de pagamento ou “Sem perfil” na parte 2.",
    });
  });

  it("points at the amount of part 1 before its profile, as the screen has them", () => {
    let form = startSplit(saleOf("100,00"));
    form = selectProfileChoice(form, "", [profile()]);
    const evaluation = evaluate(form);
    expect(evaluation.firstIssueKey).toBe("payment:amount");
    expect(evaluation.errors.profile).toBe(
      "Escolha um perfil de pagamento ou “Sem perfil” na parte 1."
    );
  });

  it("refuses an amount that is not a number, in the field of the part", () => {
    const form = setFirstPartAmount(
      startSplit(saleOf("100,00")),
      "12,3,4",
      "100.00"
    );
    const evaluation = evaluate(form);
    expect(evaluation.body).toBeNull();
    expect(evaluation.errors["payment:amount"]).toBeDefined();
    expect(evaluation.split?.balance).toBeNull();
    const typedSecond = setSecondPartAmount(
      splitSale("60,00", "40,00"),
      "abc",
      "100.00"
    );
    expect(evaluate(typedSecond).errors["payment2:amount"]).toBeDefined();
    expect(evaluate(typedSecond).body).toBeNull();
  });

  it("asks for the amount of part 2 once the person typed there and emptied it", () => {
    const form = setSecondPartAmount(
      splitSale("100,00", "40,00"),
      "",
      "100.00"
    );
    expect(evaluate(form).errors["payment2:amount"]).toBe(
      "Informe o valor da parte 2."
    );
  });

  it("carries the number of the part into the credit messages", () => {
    let form = splitSale("100,00", "40,00");
    form = selectSecondPaymentMethod(form, "credit_card");
    const { errors } = evaluate(form);
    expect(errors["payment2:installments"]).toBe(
      "Informe o número de parcelas da parte 2."
    );
    expect(errors["payment2:installmentPlan"]).toBe(
      "Escolha quem parcela na parte 2."
    );
    expect(evaluate(form).firstIssueKey).toBe("payment2:installments");
  });

  it("keeps the card choices of one part out of the other", () => {
    let form = splitSale("100,00", "40,00");
    form = selectSecondPaymentMethod(form, "credit_card");
    form = updateSecondPayment(form, {
      anticipationRequested: true,
      installmentPlan: "issuer",
      installments: "2",
    });
    expect(form.payment.installments).toBe("");
    form = selectSecondPaymentMethod(form, "pix");
    expect(form.split?.second.payment).toEqual({
      anticipationRequested: false,
      installmentPlan: "",
      installments: "",
      method: "pix",
    });
  });
});

describe("the profile of each part", () => {
  it("is reviewed once for both parts when both use the profile that changed", () => {
    let form = splitSale("100,00", "40,00");
    form = selectProfileChoice(form, profileId, [profile(3)]);
    form = selectSecondProfileChoice(form, profileId, [profile(3)]);
    const reconciled = reconcileProfileReload(form, [profile(4)]);

    expect(reconciled.profile.reviewNotice).toContain("da parte 1");
    expect(reconciled.split?.second.profile.reviewNotice).toContain(
      "da parte 2"
    );
    expect(sharedProfileReview(reconciled)).toBe(true);
    expect(SHARED_PROFILE_REVIEW_MESSAGE).toBe(
      "Revise a prévia das duas partes."
    );

    for (const acknowledge of [
      acknowledgeProfileReview,
      acknowledgeSecondProfileReview,
    ]) {
      const acknowledged = acknowledge(reconciled, [profile(4)]);
      const reviewed = {
        choice: profileId,
        reviewNotice: null,
        seenVersion: 4,
      };
      expect(acknowledged.profile).toEqual(reviewed);
      expect(acknowledged.split?.second.profile).toEqual(reviewed);
      expect(sharedProfileReview(acknowledged)).toBe(false);
      expect(evaluate(acknowledged, [profile(4)]).errors.profile).toBeUndefined();
    }
  });

  it("is reviewed per part, with the number of the part, when each part has its own profile", () => {
    const otherId = "66666666-6666-4666-8666-666666666666";
    const other = (version: number): PaymentProfileReadModel => ({
      ...profile(version),
      id: otherId,
      name: "Pix da loja",
    });
    let form = splitSale("100,00", "40,00");
    form = selectProfileChoice(form, profileId, [profile(3), other(1)]);
    form = selectSecondProfileChoice(form, otherId, [profile(3), other(1)]);
    const reconciled = reconcileProfileReload(form, [profile(4), other(2)]);
    expect(sharedProfileReview(reconciled)).toBe(false);

    const acknowledged = acknowledgeSecondProfileReview(reconciled, [
      profile(4),
      other(2),
    ]);
    expect(acknowledged.split?.second.profile).toEqual({
      choice: otherId,
      reviewNotice: null,
      seenVersion: 2,
    });
    expect(acknowledged.profile).toEqual(reconciled.profile);
    expect(evaluate(acknowledged, [profile(4), other(2)]).errors.profile).toBe(
      "Confirme a revisão da prévia da parte 1 antes de continuar."
    );
  });

  it("leaves the form as it was when nothing changed", () => {
    const form = splitSale("100,00", "40,00");
    expect(reconcileProfileReload(form, [profile()])).toBe(form);
  });

  it("clears only the part whose profile left the list", () => {
    let form = splitSale("100,00", "40,00");
    form = selectSecondProfileChoice(form, profileId, [profile()]);
    const reconciled = reconcileProfileReload(form, []);
    expect(reconciled.profile).toBe(form.profile);
    expect(reconciled.split?.second.profile.choice).toBe("");
    expect(reconciled.split?.second.profile.reviewNotice).toContain("parte 2");
  });

  it("keeps the sent version of each part when an unanswered attempt is sent again", () => {
    let form = splitSale("100,00", "40,00");
    form = selectSecondProfileChoice(form, profileId, [profile(3)]);
    const first = prepareConfirmation({
      body: bodyOf(form),
      createId: sequentialIds(),
      now: NOW,
      organizationId: "org_1",
      previousAttempt: null,
    });
    if (!first.ok) {
      throw new Error("expected a request");
    }
    expect(first.attempt.paymentProfiles).toEqual([
      null,
      { expectedVersion: 3, id: profileId },
    ]);

    const edited = selectSecondProfileChoice(form, profileId, [profile(4)]);
    const again = prepareConfirmation({
      attemptUnsettled: true,
      body: bodyOf(edited),
      createId: sequentialIds(),
      now: NOW,
      organizationId: "org_1",
      previousAttempt: first.attempt,
    });
    expect(again.ok && again.attempt.commandId).toBe(first.attempt.commandId);
    expect(again.ok && again.request.payments?.[1]?.paymentProfile).toEqual({
      expectedVersion: 3,
      id: profileId,
    });
  });
});

describe("going back to one payment", () => {
  it("is one part again, with the method and the profile part 1 had", () => {
    const back = endSplit(splitSale("100,00", "40,00"));
    expect(back.split).toBeNull();
    expect(back.payment.method).toBe("pix");
    expect(back.profile.choice).toBe(NO_PROFILE_CHOICE);
    expect(bodyOf(back).payment?.method).toBe("pix");
    expect(bodyOf(back)).not.toHaveProperty("payments");
  });

  it("does nothing on a form that is not split, and splitting twice keeps the parts", () => {
    const one = saleOf("10,00");
    expect(endSplit(one)).toBe(one);
    const split = startSplit(one);
    expect(startSplit(split)).toBe(split);
  });

  it("opens part 2 with the rest and with neither method nor profile", () => {
    const { split } = startSplit(saleOf("10,00"));
    expect(split?.second).toEqual({
      amount: null,
      payment: {
        anticipationRequested: false,
        installmentPlan: "",
        installments: "",
        method: "",
      },
      profile: { choice: "", reviewNotice: null, seenVersion: null },
    });
  });
});

describe("what a split sale leaves behind", () => {
  it("never writes the memory of the last payment", () => {
    expect(paymentOfSentForm(splitSale("100,00", "40,00"))).toBeNull();
    expect(paymentOfSentForm(saleOf("100,00"))).toEqual({
      method: "pix",
      profile: null,
    });
  });

  it("makes the next sale open with one part, from the memory of the last one of one part", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => {
        store.delete(key);
      },
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const single = paymentOfSentForm(saleOf("10,00"));
    if (single) {
      writeLastPayment(storage, "org_1", single);
    }
    const sentSplit = paymentOfSentForm(splitSale("10,00", "4,00"));
    if (sentSplit) {
      writeLastPayment(storage, "org_1", sentSplit);
    }
    expect([...store.keys()]).toEqual(["polaris.sale.lastPayment.v1:org_1"]);

    const next = applySalePreset(
      createBlankSaleForm(sequentialIds()),
      salePresetFrom({ method: "pix", profile: null }, 0)
    );
    expect(next.split).toBeNull();
    expect(next.payment.method).toBe("pix");
  });

  it("counts as work on the sale", () => {
    expect(isSaleFormDirty(createBlankSaleForm(sequentialIds()))).toBe(false);
    expect(
      isSaleFormDirty(startSplit(createBlankSaleForm(sequentialIds())))
    ).toBe(true);
  });
});
