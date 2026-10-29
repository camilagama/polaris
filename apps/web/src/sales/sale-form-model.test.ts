import type {
  ConfirmedSaleReadModel,
  InventoryBalanceReadModel,
  PaymentProfileReadModel,
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import {
  acknowledgeProfileReview,
  addAdjustment,
  adjustmentFieldKey,
  addItem,
  attemptAfterFailure,
  autoSelectOnlyVariants,
  cancelDiscard,
  canStartSubmission,
  chooseItemVariant,
  confirmSubmission,
  createBlankSaleForm,
  describeFee,
  describeStockRefusal,
  discardLockedSale,
  type EvaluationContext,
  editSaleDate,
  editSaleForm,
  evaluateSaleForm,
  failSubmission,
  formatPercentage,
  formFieldKeys,
  idleSubmission,
  isFormLocked,
  isSaleFormDirty,
  isSubmitting,
  itemFieldKey,
  type Loadable,
  loadErrorMessage,
  MAX_SALE_ADJUSTMENTS,
  MAX_SALE_ITEMS,
  mapSaleSubmitError,
  NO_PROFILE_CHOICE,
  parseLocalDateTime,
  parseMoneyText,
  parsePercentageText,
  prepareConfirmation,
  productsView,
  profilesView,
  reconcileProfileReload,
  removeAdjustment,
  removeItem,
  requestDiscard,
  resolveSaleAttempt,
  type SaleAttempt,
  type SaleFormState,
  type SubmissionState,
  saleDateDetails,
  selectItemProduct,
  selectItemVariant,
  selectPaymentMethod,
  selectProfileChoice,
  startSubmission,
  stepQuantity,
  stockView,
  submitButtonLabel,
  updateAdjustment,
  updateItem,
  updatePayment,
  validateSaleDate,
  variantsView,
} from "./sale-form-model";

const organizationId = "org_1";
const productId = "11111111-1111-4111-8111-111111111111";
const variantId = "22222222-2222-4222-8222-222222222222";
const otherVariantId = "33333333-3333-4333-8333-333333333333";
const profileId = "44444444-4444-4444-8444-444444444444";
const ruleCardId = "55555555-5555-4555-8555-555555555555";
const rulePixId = "66666666-6666-4666-8666-666666666666";
const noFee = { fixedAmount: null, mode: "none", percentage: null } as const;
const unknownFee = {
  fixedAmount: null,
  mode: "unknown",
  percentage: null,
} as const;

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
    organizationId,
    rules: [
      {
        anticipationFee: {
          fixedAmount: null,
          mode: "percentage",
          percentage: "1.5",
        },
        expectedSettlementDays: 30,
        id: ruleCardId,
        installmentPlan: "merchant",
        installments: 3,
        method: "credit_card",
        processingFee: {
          fixedAmount: "0.50",
          mode: "fixed_and_percentage",
          percentage: "2.99",
        },
      },
      {
        anticipationFee: unknownFee,
        expectedSettlementDays: 1,
        id: rulePixId,
        installmentPlan: null,
        installments: null,
        method: "pix",
        processingFee: noFee,
      },
    ],
    status: "active",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version,
  };
}

function balance(
  quantity: number,
  movingAverageCost: string | null
): Loadable<InventoryBalanceReadModel> {
  return {
    status: "ready",
    value: { movingAverageCost, quantity, variantId, version: 1 },
  };
}

function context(
  overrides: Partial<EvaluationContext> = {}
): EvaluationContext {
  return { profiles: [profile()], stock: {}, ...overrides };
}

function lineOf(form: SaleFormState, index = 0) {
  const item = form.items[index];
  if (!item) {
    throw new Error("missing item");
  }
  return item;
}

/** A complete sale: 2 × 49,90 at the charged price, paid with Pix, no profile. */
function validForm(): SaleFormState {
  let form = createBlankSaleForm(sequentialIds());
  const { draftId } = lineOf(form);
  form = selectItemProduct(form, draftId, productId);
  form = selectItemVariant(form, draftId, variantId, "Camiseta — Azul / M");
  form = updateItem(form, draftId, {
    chargedUnitPrice: "49,90",
    listedUnitPrice: "55,00",
    quantity: "2",
  });
  form = selectPaymentMethod(form, "pix");
  return selectProfileChoice(form, NO_PROFILE_CHOICE, []);
}

function creditCardForm(): SaleFormState {
  let form = validForm();
  form = selectPaymentMethod(form, "credit_card");
  form = updatePayment(form, {
    anticipationRequested: false,
    installmentPlan: "merchant",
    installments: "3",
  });
  return selectProfileChoice(form, profileId, [profile()]);
}

function evaluate(
  form: SaleFormState,
  ctx = context(),
  showRequired = true,
  now?: Date
) {
  return evaluateSaleForm(form, ctx, { now, showRequired });
}

describe("decimal input parsing", () => {
  it("accepts comma or dot and always normalizes money to two decimals", () => {
    expect(parseMoneyText("49,9")).toEqual({ kind: "ok", value: "49.90" });
    expect(parseMoneyText(" 0012.5 ")).toEqual({ kind: "ok", value: "12.50" });
    expect(parseMoneyText("7")).toEqual({ kind: "ok", value: "7.00" });
  });

  it("rejects more than two decimals, mixed separators, signs and text", () => {
    for (const text of ["1.234", "1.234,56", "-5", "abc", "1,2,3", "1e3"]) {
      expect(parseMoneyText(text).kind).toBe("invalid");
    }
    expect(parseMoneyText("   ").kind).toBe("empty");
    expect(parseMoneyText(`${"9".repeat(19)}.00`).kind).toBe("too_large");
  });

  it("accepts percentages up to six decimals in percentage points", () => {
    expect(parsePercentageText("2,5")).toEqual({ kind: "ok", value: "2.5" });
    expect(parsePercentageText("0.123456")).toEqual({
      kind: "ok",
      value: "0.123456",
    });
    expect(parsePercentageText("0.1234567").kind).toBe("invalid");
    expect(parsePercentageText("").kind).toBe("empty");
  });
});

describe("formatting", () => {
  it("formats BRL from exact strings, keeping at least two decimals", () => {
    expect(formatBrlAmount("1234567.5")).toBe("R$ 1.234.567,50");
    expect(formatBrlAmount("12.340000")).toBe("R$ 12,34");
    expect(formatBrlAmount("12.345600")).toBe("R$ 12,3456");
    expect(formatBrlAmount("0.00")).toBe("R$ 0,00");
  });

  it("formats percentages in percentage points", () => {
    expect(formatPercentage("2.500000")).toBe("2,5%");
    expect(formatPercentage("10.000000")).toBe("10%");
  });
});

describe("form transitions", () => {
  it("starts blank with no payment method or profile chosen for the operator", () => {
    const form = createBlankSaleForm(sequentialIds());
    expect(form.items).toHaveLength(1);
    expect(form.payment.method).toBe("");
    expect(form.profile.choice).toBe("");
    expect(form.adjustments).toEqual([]);
  });

  it("clears the variant when another product is chosen", () => {
    const form = validForm();
    const { draftId } = lineOf(form);
    const next = selectItemProduct(form, draftId, otherVariantId);
    expect(lineOf(next).variantId).toBe("");
    expect(lineOf(next).label).toBe("");
  });

  it("drops card-only choices when leaving credit card", () => {
    const card = updatePayment(creditCardForm(), {
      anticipationRequested: true,
    });
    const pix = selectPaymentMethod(card, "pix");
    expect(pix.payment).toEqual({
      anticipationRequested: false,
      installmentPlan: "",
      installments: "",
      method: "pix",
    });
  });

  it("keeps freight and payment surcharge as fixed amounts", () => {
    let form = addAdjustment(validForm(), "adj-1");
    form = updateAdjustment(form, "adj-1", { valueType: "percentage" });
    expect(form.adjustments[0]?.valueType).toBe("percentage");
    form = updateAdjustment(form, "adj-1", { kind: "freight" });
    expect(form.adjustments[0]?.valueType).toBe("fixed");
  });

  it("keeps at least one item and respects the item and adjustment limits", () => {
    const form = validForm();
    expect(removeItem(form, lineOf(form).draftId).items).toHaveLength(1);

    let many = form;
    for (let index = 0; index < MAX_SALE_ITEMS + 5; index += 1) {
      many = addItem(many, `item-${index}`);
    }
    expect(many.items).toHaveLength(MAX_SALE_ITEMS);

    let adjusted = form;
    for (let index = 0; index < MAX_SALE_ADJUSTMENTS + 5; index += 1) {
      adjusted = addAdjustment(adjusted, `adj-${index}`);
    }
    expect(adjusted.adjustments).toHaveLength(MAX_SALE_ADJUSTMENTS);
    expect(removeAdjustment(adjusted, "adj-0").adjustments).toHaveLength(
      MAX_SALE_ADJUSTMENTS - 1
    );
  });
});

describe("validation errors before calling the server", () => {
  it("hides required-field errors until the operator tries to confirm", () => {
    const form = createBlankSaleForm(sequentialIds());
    const quiet = evaluate(form, context(), false);
    expect(quiet.body).toBeNull();
    expect(quiet.issueCount).toBeGreaterThan(0);
    expect(quiet.errors).toEqual({});

    const loud = evaluate(form, context(), true);
    expect(loud.errors[formFieldKeys.method]).toBe(
      "Escolha o método de pagamento."
    );
    expect(loud.errors[formFieldKeys.profile]).toContain("Sem perfil");
    expect(loud.errors[itemFieldKey(lineOf(form).draftId, "product")]).toBe(
      "Escolha um produto."
    );
  });

  it("shows format errors immediately, even before submit", () => {
    const form = validForm();
    const { draftId } = lineOf(form);
    const bad = updateItem(form, draftId, {
      chargedUnitPrice: "1,234",
      quantity: "0",
    });
    const result = evaluate(bad, context(), false);
    expect(result.body).toBeNull();
    expect(result.errors[itemFieldKey(draftId, "chargedUnitPrice")]).toContain(
      "2 casas decimais"
    );
    expect(result.errors[itemFieldKey(draftId, "quantity")]).toContain(
      "maior que zero"
    );
  });

  it("requires integer installments and an installment plan for credit card", () => {
    let form = selectPaymentMethod(validForm(), "credit_card");
    let result = evaluate(form);
    expect(result.errors[formFieldKeys.installments]).toBe(
      "Informe o número de parcelas."
    );
    expect(result.errors[formFieldKeys.installmentPlan]).toBe(
      "Escolha quem parcela."
    );
    form = updatePayment(form, {
      installmentPlan: "issuer",
      installments: "2.5",
    });
    result = evaluate(form);
    expect(result.errors[formFieldKeys.installments]).toContain("inteiro");
    expect(result.body).toBeNull();
  });

  it("surfaces a discount larger than the subtotal as a domain error", () => {
    let form = addAdjustment(validForm(), "adj-1");
    form = updateAdjustment(form, "adj-1", { value: "500" });
    const result = evaluate(form);
    expect(result.errors[formFieldKeys.adjustments]).toBe(
      "O total de descontos não pode ser maior que o subtotal."
    );
    expect(result.body).toBeNull();
    expect(result.summary).toBeNull();
  });

  it("surfaces a total above the BRL limit", () => {
    const form = validForm();
    const huge = updateItem(form, lineOf(form).draftId, {
      chargedUnitPrice: "999999999999999999",
      quantity: "99",
    });
    const result = evaluate(huge);
    expect(result.errors[formFieldKeys.totals]).toContain("limite");
    expect(result.body).toBeNull();
  });

  it("requires an explicit payment profile choice", () => {
    const form = {
      ...validForm(),
      profile: createBlankSaleForm(sequentialIds()).profile,
    };
    const result = evaluate(form);
    expect(result.body).toBeNull();
    expect(result.profileText).toBe("Perfil de pagamento ainda não escolhido");
    expect(result.errors[formFieldKeys.profile]).toBeDefined();
  });
});

describe("exact totals and command body", () => {
  it("builds the confirm body with normalized decimal strings", () => {
    const result = evaluate(validForm());
    expect(result.body).toEqual({
      adjustments: [],
      commandVersion: 1,
      items: [
        {
          chargedUnitPrice: "49.90",
          listedUnitPrice: "55.00",
          quantity: 2,
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
  });

  it("does not add the listed-versus-charged difference as an adjustment", () => {
    const result = evaluate(validForm());
    expect(result.body?.adjustments).toEqual([]);
    expect(result.summary?.rows.map((row) => row.key)).toEqual([
      "subtotal",
      "total-due",
    ]);
    expect(result.summary?.lines[0]?.negotiationText).toContain(
      "R$ 5,10 abaixo do preço de tabela"
    );
  });

  it("computes percentage adjustments on the same subtotal without compounding", () => {
    let form = addItem(validForm(), "item-2");
    form = selectItemProduct(form, "item-2", productId);
    form = selectItemVariant(
      form,
      "item-2",
      otherVariantId,
      "Camiseta — Verde"
    );
    form = updateItem(form, "item-2", {
      chargedUnitPrice: "10",
      listedUnitPrice: "10",
      quantity: "1",
    });
    form = addAdjustment(form, "adj-discount");
    form = updateAdjustment(form, "adj-discount", {
      kind: "discount",
      value: "10",
      valueType: "percentage",
    });
    form = addAdjustment(form, "adj-surcharge");
    form = updateAdjustment(form, "adj-surcharge", {
      kind: "surcharge",
      value: "5",
      valueType: "percentage",
    });
    form = addAdjustment(form, "adj-freight");
    form = updateAdjustment(form, "adj-freight", {
      kind: "freight",
      value: "15",
    });
    const result = evaluate(form);
    // subtotal 109,80; -10% = 10,98; +5% = 5,49 (both on 109,80); + frete 15,00
    expect(result.summary?.totalDue).toBe("119.31");
    expect(result.summary?.rows.map((row) => row.value)).toEqual([
      "R$ 109,80",
      "-R$ 10,98",
      "+R$ 5,49",
      "+R$ 15,00",
      "R$ 119,31",
    ]);
    expect(result.body?.adjustments).toEqual([
      { kind: "discount", value: { percentage: "10", type: "percentage" } },
      { kind: "surcharge", value: { percentage: "5", type: "percentage" } },
      { kind: "freight", value: { amount: "15.00", type: "fixed" } },
    ]);
  });

  describe("percentage adjustment above the cap", () => {
    const genericAdjustmentMessage =
      "Revise os ajustes: os valores devem ser positivos e percentual só vale para desconto e acréscimo.";

    function withAdjustment(
      kind: "discount" | "surcharge",
      value: string,
      valueType: "fixed" | "percentage" = "percentage"
    ) {
      return updateAdjustment(
        addAdjustment(validForm(), "adj-cap"),
        "adj-cap",
        { kind, value, valueType }
      );
    }

    it("says the cap for a discount of 150%", () => {
      const result = evaluate(withAdjustment("discount", "150"));
      expect(result.body).toBeNull();
      expect(result.errors[formFieldKeys.adjustments]).toBe(
        "O percentual vai até 100%."
      );
    });

    it("says the cap for a surcharge above 100% and for 100,000001", () => {
      for (const value of ["150", "100,000001", "101", "0150", "00150,5"]) {
        const result = evaluate(withAdjustment("surcharge", value));
        expect(result.errors[formFieldKeys.adjustments], value).toBe(
          "O percentual vai até 100%."
        );
      }
    });

    it("accepts exactly 100% and 100,000000%", () => {
      for (const value of ["100", "100,000000", "0100"]) {
        const result = evaluate(withAdjustment("discount", value));
        expect(result.errors[formFieldKeys.adjustments], value).toBeUndefined();
        expect(result.body, value).not.toBeNull();
      }
    });

    it("keeps the current message for a negative fixed value", () => {
      const result = evaluate(withAdjustment("discount", "-5", "fixed"));
      // the form refuses a minus sign as a format error before any calculation (the generic text is the server's)
      expect(result.errors[adjustmentFieldKey("adj-cap")]).toBe(
        "Use até 2 casas decimais, com vírgula ou ponto (ex.: 49,90)."
      );
      expect(result.body).toBeNull();
    });

    it("keeps the current message for the other invalid adjustment, and for the server when the percentage is within the cap", () => {
      expect(
        mapSaleSubmitError(
          { code: "BAD_REQUEST", data: { reason: "invalid_sale_adjustment" } },
          [
            {
              kind: "discount",
              value: { percentage: "100", type: "percentage" },
            },
          ]
        ).message
      ).toBe(genericAdjustmentMessage);
      expect(
        mapSaleSubmitError({
          code: "BAD_REQUEST",
          data: { reason: "invalid_sale_adjustment" },
        }).message
      ).toBe(genericAdjustmentMessage);
    });

    it("says the cap when the server refuses an adjustment and the sent percentage is above 100", () => {
      const failure = mapSaleSubmitError(
        { code: "BAD_REQUEST", data: { reason: "invalid_sale_adjustment" } },
        [
          {
            kind: "surcharge",
            value: { percentage: "150", type: "percentage" },
          },
        ]
      );
      expect(failure.message).toBe("O percentual vai até 100%.");
      expect(failure.reason).toBe("invalid_sale_adjustment");
      expect(failure.refreshData).toBe(false);
    });
  });

  it("warns, without blocking, when the quantity exceeds the shown balance", () => {
    const form = validForm();
    const result = evaluate(
      form,
      context({ stock: { [variantId]: balance(1, null) } })
    );
    expect(result.body).not.toBeNull();
    expect(result.stockWarnings[lineOf(form).draftId]).toContain(
      "Quantidade acima do saldo exibido (1)"
    );
  });

  it("sums repeated lines of the same variant for the stock warning", () => {
    let form = addItem(validForm(), "item-2");
    form = selectItemProduct(form, "item-2", productId);
    form = selectItemVariant(form, "item-2", variantId, "Camiseta — Azul / M");
    form = updateItem(form, "item-2", {
      chargedUnitPrice: "10",
      listedUnitPrice: "10",
      quantity: "2",
    });
    const result = evaluate(
      form,
      context({ stock: { [variantId]: balance(3, "10.000000") } })
    );
    expect(Object.keys(result.stockWarnings)).toHaveLength(2);
  });
});

describe("payment profile choice and fee preview", () => {
  it("sends the chosen profile id with the version the operator saw", () => {
    const result = evaluate(creditCardForm());
    expect(result.body?.paymentProfile).toEqual({
      expectedVersion: 3,
      id: profileId,
    });
    expect(result.profileText).toBe("Maquininha Aurora");
  });

  it("without a profile, fees and settlement are unknown, not zero", () => {
    const result = evaluate(validForm());
    expect(result.profileText).toBe(
      "Sem perfil de pagamento (taxas e prazo desconhecidos)"
    );
    expect(result.feePreview?.profileText).toBe("Sem perfil de pagamento");
    expect(result.feePreview?.ruleText).toBe(
      "Sem perfil — nenhuma regra aplicada"
    );
    expect(result.feePreview?.processing).toEqual({
      text: "desconhecida — não é zero",
      tone: "unknown",
    });
    expect(result.feePreview?.settlementText).toContain("prazo desconhecido");
    expect(result.feePreview?.anticipation.tone).toBe("not_applicable");
  });

  it("applies the exact rule with half-up cents and a settlement estimate", () => {
    const result = evaluate(creditCardForm());
    // total 99,80: 0,50 + 2,99% = 0,50 + 2,98402 -> 3,48
    expect(result.feePreview?.ruleMatched).toBe(true);
    expect(result.feePreview?.ruleText).toBe(
      "Regra exata: Cartão de crédito · 3x · Parcelado pelo lojista"
    );
    expect(result.feePreview?.processing.tone).toBe("known");
    expect(result.feePreview?.processing.text).toContain("R$ 3,48");
    expect(result.feePreview?.settlementText).toBe(
      "prazo estimado de 30 dias — estimativa, não data de liquidação"
    );
  });

  it("shows anticipation only when requested and a rule gives its fee", () => {
    const form = updatePayment(creditCardForm(), {
      anticipationRequested: true,
    });
    const result = evaluate(form);
    // 1,5% of 99,80 = 1,497 -> 1,50
    expect(result.feePreview?.anticipation.text).toContain("R$ 1,50");
    expect(result.body?.payment.anticipationRequested).toBe(true);
  });

  it("reports no exact rule when installments do not match any rule", () => {
    const form = updatePayment(creditCardForm(), { installments: "4" });
    const result = evaluate(form);
    expect(result.feePreview?.ruleMatched).toBe(false);
    expect(result.feePreview?.ruleText).toBe(
      "Nenhuma regra exata para este método/parcelas"
    );
    expect(result.feePreview?.processing.tone).toBe("unknown");
    expect(result.feePreview?.settlementText).toContain("prazo desconhecido");
  });

  it("keeps anticipation unknown when requested without a matching rule", () => {
    const form = updatePayment(creditCardForm(), {
      anticipationRequested: true,
      installments: "4",
    });
    expect(evaluate(form).feePreview?.anticipation.tone).toBe("unknown");
  });

  it("distinguishes a known zero from an unknown fee", () => {
    const pix = selectPaymentMethod(creditCardForm(), "pix");
    const result = evaluate(pix);
    expect(result.feePreview?.processing).toEqual({
      text: "R$ 0,00 (sem taxa no perfil)",
      tone: "zero",
    });
    expect(
      describeFee({
        amount: null,
        fixedAmount: null,
        mode: "unknown",
        percentage: null,
      }).tone
    ).toBe("unknown");
    expect(
      describeFee({
        amount: "0.00",
        fixedAmount: null,
        mode: "not_applicable",
        percentage: null,
      }).text
    ).toBe("não se aplica");
  });

  it("requires a review when a reload changed the chosen profile version", () => {
    const form = creditCardForm();
    const reloaded = [profile(4)];
    const stale = reconcileProfileReload(form, reloaded);
    expect(stale.profile.reviewNotice).toBe(
      "O perfil “Maquininha Aurora” mudou desde a última venda. Revise a prévia de taxas e prazo e confirme para continuar."
    );
    expect(stale.profile.reviewNotice).not.toContain("versão");
    const blocked = evaluate(stale, context({ profiles: reloaded }));
    expect(blocked.body).toBeNull();
    expect(blocked.errors[formFieldKeys.profile]).toContain("revisão");

    const reviewed = acknowledgeProfileReview(stale, reloaded);
    const ready = evaluate(reviewed, context({ profiles: reloaded }));
    expect(ready.body?.paymentProfile).toEqual({
      expectedVersion: 4,
      id: profileId,
    });
  });

  it("leaves the choice untouched when the profile did not change", () => {
    const form = creditCardForm();
    expect(reconcileProfileReload(form, [profile(3)])).toBe(form);
  });

  it("asks for a new choice when the chosen profile is no longer active", () => {
    const reset = reconcileProfileReload(creditCardForm(), []);
    expect(reset.profile.choice).toBe("");
    expect(reset.profile.reviewNotice).toContain("não está mais ativo");
  });
});

describe("a profile that left the list after a lost answer", () => {
  const now = new Date("2026-05-01T12:00:00.000Z");
  const ids = sequentialIds();

  function attemptOf(form: SaleFormState, previous: SaleAttempt | null) {
    const { body } = evaluate(form, context({ profiles: [profile()] }));
    if (body === null) {
      throw new Error("expected a valid body");
    }
    return resolveSaleAttempt(previous, body, organizationId, ids, now);
  }

  it("keeps the body and the command ID while the outcome is unknown", () => {
    const form = creditCardForm();
    const sent = attemptOf(form, null);
    const reloaded = reconcileProfileReload(form, [], true);
    expect(reloaded).toBe(form);
    expect(evaluate(reloaded, context({ profiles: [profile()] })).body).toEqual(
      evaluate(form).body
    );
    expect(attemptOf(reloaded, sent).commandId).toBe(sent.commandId);
    expect(
      evaluate(reloaded, context({ profiles: [] })).errors[
        formFieldKeys.profile
      ]
    ).toContain("não está na lista");
  });

  it("clears the choice and the next choice is a new attempt when no outcome is unknown", () => {
    const form = creditCardForm();
    const sent = attemptOf(form, null);
    const reloaded = reconcileProfileReload(form, [], false);
    expect(reloaded.profile.choice).toBe("");
    expect(reloaded.profile.reviewNotice).toContain("não está mais ativo");
    const retyped = selectProfileChoice(reloaded, NO_PROFILE_CHOICE, []);
    expect(attemptOf(retyped, sent).commandId).not.toBe(sent.commandId);
  });

  it("asks for the review of a changed version and keeps the choice", () => {
    const form = creditCardForm();
    const reloaded = reconcileProfileReload(form, [profile(4)], true);
    expect(reloaded.profile.reviewNotice).toContain("mudou");
    expect(reloaded.profile.choice).toBe(form.profile.choice);
  });
});

describe("loading and empty states", () => {
  const loading = { status: "loading" } as const;

  it("reports loading for products and profiles", () => {
    expect(productsView(loading).kind).toBe("loading");
    expect(profilesView(loading).kind).toBe("loading");
    expect(variantsView(loading)?.kind).toBe("loading");
    expect(variantsView(undefined)).toBeNull();
  });

  it("reports an empty catalog and still allows selling without a profile", () => {
    const products = productsView({ status: "ready", value: [] });
    expect(products).toEqual({
      href: "/products?novo=1",
      kind: "empty",
      message: "Cadastre um produto para vender.",
    });
    const profiles = profilesView({ status: "ready", value: [] });
    expect(profiles).toMatchObject({ kind: "empty" });
    expect("message" in profiles && profiles.message).toContain("Sem perfil");
  });

  it("lists only active products, sorted by name", () => {
    const base: ProductReadModel = {
      archivedAt: null,
      categoryId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      description: null,
      id: productId,
      name: "Zebra",
      organizationId,
      status: "active",
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    };
    const view = productsView({
      status: "ready",
      value: [
        base,
        { ...base, id: otherVariantId, name: "Álbum" },
        { ...base, id: profileId, name: "Velho", status: "archived" },
      ],
    });
    expect(view).toEqual({
      kind: "ready",
      options: [
        { id: otherVariantId, label: "Álbum" },
        { id: productId, label: "Zebra" },
      ],
    });
  });

  it("labels variants by option values, or as the default variant", () => {
    const configuration: ProductVariantConfigurationReadModel = {
      configured: true,
      options: [],
      productVersion: 1,
      variants: [
        {
          id: variantId,
          isDefault: false,
          listPrice: null,
          position: 0,
          sku: null,
          values: [
            {
              optionName: "color",
              optionValueId: productId,
              optionValueName: "Azul",
            },
            {
              optionName: "size",
              optionValueId: profileId,
              optionValueName: "M",
            },
          ],
        },
        {
          id: otherVariantId,
          isDefault: true,
          listPrice: null,
          position: null,
          sku: null,
          values: [],
        },
      ],
    };
    expect(variantsView({ status: "ready", value: configuration })).toEqual({
      kind: "ready",
      options: [
        { id: variantId, label: "Azul / M" },
        { id: otherVariantId, label: "Variante padrão" },
      ],
    });
  });

  it("reports stock states, never treating an unknown cost as zero", () => {
    expect(stockView(undefined, true)).toBeNull();
    expect(stockView(loading, true)?.text).toBe("Consultando estoque…");
    expect(stockView({ message: "Falhou.", status: "error" }, true)?.tone).toBe(
      "warning"
    );
    const none = stockView(balance(0, null), true);
    expect(none?.text).toBe(
      "Sem estoque: saldo 0. Para vender, dê entrada no estoque."
    );
    expect(none?.needsEntry).toBe(true);
    expect(none?.costText).toBe("Custo desconhecido. Margem indeterminada.");
    const some = stockView(balance(5, "12.340000"), true);
    expect(some?.needsEntry).toBe(false);
    expect(some?.text).toBe("Saldo atual: 5 unidades.");
    expect(some?.costText).toBe("Custo médio: R$ 12,34.");
  });

  it("maps load failures to actionable messages", () => {
    expect(loadErrorMessage({ code: "UNAUTHORIZED" }, "produtos")).toBe(
      "Não foi possível carregar produtos."
    );
    expect(loadErrorMessage({ code: "FORBIDDEN" }, "o estoque")).toBe(
      "Sua conta não tem acesso a esta loja ou a esta ação."
    );
    expect(loadErrorMessage(new Error("x"), "produtos")).toBe(
      "Não foi possível carregar produtos. Tente novamente."
    );
  });
});

describe("variant choice", () => {
  const configuration = (
    variants: ProductVariantConfigurationReadModel["variants"]
  ): Loadable<ProductVariantConfigurationReadModel> => ({
    status: "ready",
    value: {
      configured: variants.length > 1,
      options: [],
      productVersion: 1,
      variants,
    },
  });
  const names = new Map([[productId, "Camiseta"]]);

  it("selects the only variant automatically, keeping the plain product name", () => {
    const base = selectItemProduct(
      createBlankSaleForm(sequentialIds()),
      "00000000-0000-4000-8000-000000000001",
      productId
    );
    const loaded = {
      [productId]: configuration([
        {
          id: variantId,
          isDefault: true,
          listPrice: null,
          position: null,
          sku: null,
          values: [],
        },
      ]),
    };
    const next = autoSelectOnlyVariants(base, loaded, names);
    expect(lineOf(next).variantId).toBe(variantId);
    expect(lineOf(next).label).toBe("Camiseta");
    expect(autoSelectOnlyVariants(next, loaded, names)).toBe(next);
  });

  it("waits while variants load and never picks among several", () => {
    const base = selectItemProduct(
      createBlankSaleForm(sequentialIds()),
      "00000000-0000-4000-8000-000000000001",
      productId
    );
    expect(
      autoSelectOnlyVariants(
        base,
        { [productId]: { status: "loading" } },
        names
      )
    ).toBe(base);
    const two = {
      [productId]: configuration([
        {
          id: variantId,
          isDefault: false,
          listPrice: null,
          position: 0,
          sku: null,
          values: [],
        },
        {
          id: otherVariantId,
          isDefault: false,
          listPrice: null,
          position: 1,
          sku: null,
          values: [],
        },
      ]),
    };
    expect(autoSelectOnlyVariants(base, two, names)).toBe(base);
  });

  it("labels the chosen variant with its option values", () => {
    const base = selectItemProduct(
      createBlankSaleForm(sequentialIds()),
      "00000000-0000-4000-8000-000000000001",
      productId
    );
    const loaded = {
      [productId]: configuration([
        {
          id: variantId,
          isDefault: false,
          listPrice: null,
          position: 0,
          sku: null,
          values: [
            {
              optionName: "color",
              optionValueId: productId,
              optionValueName: "Azul",
            },
            {
              optionName: "size",
              optionValueId: profileId,
              optionValueName: "M",
            },
          ],
        },
        {
          id: otherVariantId,
          isDefault: false,
          listPrice: null,
          position: 1,
          sku: null,
          values: [],
        },
      ]),
    };
    const next = chooseItemVariant(
      base,
      lineOf(base).draftId,
      variantId,
      loaded,
      names
    );
    expect(lineOf(next).label).toBe("Camiseta — Azul / M");
  });
});

describe("idempotent attempts", () => {
  const body = () => {
    const { body: built } = evaluate(validForm());
    if (!built) {
      throw new Error("expected a valid body");
    }
    return built;
  };

  it("keeps the same command ID and instant for an identical retry", () => {
    const ids = sequentialIds();
    const first = resolveSaleAttempt(
      null,
      body(),
      organizationId,
      ids,
      new Date("2026-05-01T12:00:00.000Z")
    );
    const retry = resolveSaleAttempt(
      first,
      body(),
      organizationId,
      ids,
      new Date("2026-05-01T12:05:00.000Z")
    );
    expect(retry).toBe(first);
    expect(retry.occurredAt).toBe("2026-05-01T12:00:00.000Z");
  });

  it("creates a fresh command ID when any field of the sale changed", () => {
    const ids = sequentialIds();
    const first = resolveSaleAttempt(
      null,
      body(),
      organizationId,
      ids,
      new Date("2026-05-01T12:00:00.000Z")
    );
    const edited = evaluate(
      updateItem(validForm(), lineOf(validForm()).draftId, { quantity: "3" })
    ).body;
    expect(edited).not.toBeNull();
    const second = resolveSaleAttempt(
      first,
      edited ?? body(),
      organizationId,
      ids,
      new Date("2026-05-01T12:05:00.000Z")
    );
    expect(second.commandId).not.toBe(first.commandId);
    expect(second.occurredAt).toBe("2026-05-01T12:05:00.000Z");
  });

  it("treats a new profile version as a new payload", () => {
    const ids = sequentialIds();
    const now = new Date("2026-05-01T12:00:00.000Z");
    const v3 = evaluate(creditCardForm()).body;
    const form4 = acknowledgeProfileReview(
      reconcileProfileReload(creditCardForm(), [profile(4)]),
      [profile(4)]
    );
    const v4 = evaluate(form4, context({ profiles: [profile(4)] })).body;
    if (!(v3 && v4)) {
      throw new Error("expected valid bodies");
    }
    const first = resolveSaleAttempt(null, v3, organizationId, ids, now);
    expect(
      resolveSaleAttempt(first, v4, organizationId, ids, now).commandId
    ).not.toBe(first.commandId);
  });

  it("prepares one confirm request with the version 1 command", () => {
    const prepared = prepareConfirmation({
      body: body(),
      createId: sequentialIds(),
      now: new Date("2026-05-01T12:00:00.000Z"),
      organizationId,
      previousAttempt: null,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.request).toMatchObject({
      commandId: "00000000-0000-4000-8000-000000000001",
      commandVersion: 1,
      occurredAt: "2026-05-01T12:00:00.000Z",
      organizationId,
      paymentProfile: null,
    });
    expect(prepared.request).toHaveProperty(
      "recordedAt",
      "2026-05-01T12:00:00.000Z"
    );
    expect(prepared.request).not.toHaveProperty("clientCreatedAt");
  });
});

describe("server errors", () => {
  it("maps each oRPC code to a message", () => {
    expect(mapSaleSubmitError({ code: "UNAUTHORIZED" }).kind).toBe(
      "unauthorized"
    );
    // the sentence about the session is the notice's, not the red box's
    expect(mapSaleSubmitError({ code: "UNAUTHORIZED" }).message).toBe(
      "A venda não foi registrada."
    );
    expect(mapSaleSubmitError({ code: "FORBIDDEN" }).message).toContain(
      "permissão"
    );
    expect(mapSaleSubmitError({ code: "BAD_REQUEST" }).kind).toBe(
      "bad_request"
    );
    const notFound = mapSaleSubmitError({ code: "NOT_FOUND" });
    expect(notFound.kind).toBe("not_found");
    expect(notFound.refreshData).toBe(true);
  });

  it("a refusal for lack of the legal acceptance keeps the items and says what is missing", () => {
    const refused = mapSaleSubmitError({
      code: "FORBIDDEN",
      data: { reason: "legal_acceptance_required" },
      status: 403,
    });
    expect(refused.kind).toBe("forbidden");
    expect(refused.discardAttempt).toBe(false);
    expect(refused.message).toContain("Termos de Uso");
    expect(refused.message).toContain("Os itens continuam aqui");
    // a plain FORBIDDEN keeps the permission message
    const plain = mapSaleSubmitError({ code: "FORBIDDEN" });
    expect(plain.message).toContain("permissão");
    expect(plain.message).not.toContain("Termos de Uso");
  });

  it("explains a conflict generically and asks to refresh data", () => {
    const conflict = mapSaleSubmitError({ code: "CONFLICT" });
    expect(conflict.kind).toBe("conflict");
    expect(conflict.message).toBe(
      "A venda não foi registrada: algo mudou (estoque, produto ou perfil de pagamento). Atualize os dados e revise a venda."
    );
    expect(conflict.refreshData).toBe(true);
    expect(conflict.unknownOutcome).toBe(false);
  });

  it("uses the stable data.reason for a specific message", () => {
    const stock = mapSaleSubmitError({
      code: "CONFLICT",
      data: { reason: "insufficient_stock" },
    });
    expect(stock.message).toBe(
      "A venda não foi registrada: falta estoque em um ou mais itens. Confira o saldo de cada um."
    );
    expect(stock.refreshData).toBe(true);
    expect(stock.reason).toBe("insufficient_stock");

    const future = mapSaleSubmitError({
      code: "BAD_REQUEST",
      data: { reason: "sale_occurred_in_future" },
    });
    expect(future.message).toBe(
      "O horário da venda está adiantado em relação ao servidor. Verifique o relógio do dispositivo."
    );
    expect(future.kind).toBe("bad_request");
    expect(future.discardAttempt).toBe(true);
    expect(future.unknownOutcome).toBe(false);
  });

  it("maps every known reason, refreshing data only when it is stale", () => {
    const refreshing = [
      ["CONFLICT", "insufficient_stock"],
      ["CONFLICT", "sale_product_unavailable"],
      ["NOT_FOUND", "inventory_variant_not_found"],
      ["NOT_FOUND", "product_not_found"],
      ["CONFLICT", "payment_profile_version_conflict"],
      ["CONFLICT", "payment_profile_lifecycle_conflict"],
      ["NOT_FOUND", "payment_profile_not_found"],
    ] as const;
    const generic = mapSaleSubmitError({ code: "CONFLICT" }).message;
    for (const [code, reason] of refreshing) {
      const failure = mapSaleSubmitError({ code, data: { reason } });
      expect(failure.refreshData, reason).toBe(true);
      expect(failure.message, reason).not.toBe(generic);
      expect(failure.unknownOutcome, reason).toBe(false);
    }
    const validation = [
      "inventory_quantity_limit",
      "sale_discount_exceeds_subtotal",
      "invalid_sale_payment",
      "invalid_sale_adjustment",
      "invalid_confirm_sale_command",
      "sale_adjustment_limit",
    ] as const;
    for (const reason of validation) {
      const failure = mapSaleSubmitError({
        code: "BAD_REQUEST",
        data: { reason },
      });
      expect(failure.refreshData, reason).toBe(false);
      expect(failure.reason).toBe(reason);
      expect(failure.message, reason).not.toBe(
        mapSaleSubmitError({ code: "BAD_REQUEST" }).message
      );
    }
    expect(
      mapSaleSubmitError({
        code: "CONFLICT",
        data: { reason: "payment_profile_version_conflict" },
      }).message
    ).toContain("revise a prévia");
  });

  it("starts a fresh attempt after a command conflict", () => {
    const failure = mapSaleSubmitError({
      code: "CONFLICT",
      data: { reason: "sale_command_conflict" },
    });
    expect(failure.discardAttempt).toBe(true);
    expect(failure.message).toContain("nova tentativa será criada");
    const attempt = {
      commandId: "x",
      occurredAt: "y",
      recordedAt: "r",
      signature: "z",
    };
    const conflict = failSubmission({
      code: "CONFLICT",
      data: { reason: "sale_command_conflict" },
    });
    const stock = failSubmission({
      code: "CONFLICT",
      data: { reason: "insufficient_stock" },
    });
    expect(attemptAfterFailure(conflict, attempt)).toBeNull();
    expect(attemptAfterFailure(stock, attempt)).toBeNull();
  });

  it("falls back to the generic per-code message for a missing or unknown reason", () => {
    const generic = mapSaleSubmitError({ code: "CONFLICT" }).message;
    for (const data of [
      { reason: "something_new" },
      undefined,
      { reason: 42 },
    ]) {
      expect(mapSaleSubmitError({ code: "CONFLICT", data }).message).toBe(
        generic
      );
    }
    expect(
      mapSaleSubmitError({ code: "BAD_REQUEST", data: { reason: "nope" } }).kind
    ).toBe("bad_request");
  });

  it("ignores a reason on authorization errors", () => {
    const forbidden = mapSaleSubmitError({
      code: "FORBIDDEN",
      data: { reason: "insufficient_stock" },
    });
    expect(forbidden.kind).toBe("forbidden");
    expect(forbidden.reason).toBeNull();
  });

  it("treats network, 5xx and unknown failures as an unknown outcome", () => {
    const network = mapSaleSubmitError(new TypeError("Failed to fetch"));
    expect(network.kind).toBe("network");
    expect(network.message).toContain("não sabemos se a venda foi registrada");
    const server = mapSaleSubmitError({ code: "SERVICE_UNAVAILABLE" });
    expect(server.kind).toBe("server");
    const unknown = mapSaleSubmitError(new Error("boom"));
    expect(unknown.kind).toBe("unknown");
    for (const failure of [network, server, unknown]) {
      expect(failure.unknownOutcome).toBe(true);
      expect(failure.refreshData).toBe(false);
      expect(failure.message).toContain("Tentar novamente (seguro)");
      expect(failure.message).not.toContain("nova venda");
    }
  });
});

describe("submission state", () => {
  const confirmed: ConfirmedSaleReadModel = {
    adjustments: [
      {
        amount: "10.98",
        kind: "discount",
        percentage: "10.000000",
        position: 0,
        valueType: "percentage",
      },
    ],
    items: [
      {
        chargedUnitPrice: "49.90",
        listedUnitPrice: "55.00",
        position: 0,
        productId,
        productLabel: "Camiseta — Azul / M",
        quantity: 2,
        unitCost: null,
        variantId,
      },
    ],
    payment: {
      amount: "88.82",
      anticipationFee: {
        amount: "0.00",
        fixedAmount: null,
        mode: "not_applicable",
        percentage: null,
      },
      anticipationRequested: false,
      expectedSettlementDays: null,
      installmentPlan: null,
      installments: null,
      method: "pix",
      paymentProfileId: null,
      paymentProfileName: null,
      paymentProfileRuleId: null,
      paymentProfileVersion: null,
      processingFee: {
        amount: null,
        fixedAmount: null,
        mode: "unknown",
        percentage: null,
      },
    },
    replayed: false,
    sale: {
      commandId: "00000000-0000-4000-8000-000000000001",
      confirmedAt: "2026-05-01T12:00:01.000Z",
      currency: "BRL",
      id: "77777777-7777-4777-8777-777777777777",
      occurredAt: "2026-05-01T12:00:00.000Z",
      occurredOn: "2026-05-01",
      recordedAt: null,
    },
    totals: {
      discountTotal: "10.98",
      freightTotal: "0.00",
      paymentSurchargeTotal: "0.00",
      subtotal: "99.80",
      surchargeTotal: "0.00",
      totalDue: "88.82",
    },
  };

  it("blocks a second submit while one is in flight", () => {
    const valid = evaluate(validForm());
    expect(canStartSubmission(idleSubmission, valid)).toBe(true);
    const submitting = startSubmission(idleSubmission);
    expect(isSubmitting(submitting)).toBe(true);
    expect(canStartSubmission(submitting, valid)).toBe(false);
    expect(startSubmission(submitting)).toBe(submitting);
    expect(submitButtonLabel(submitting)).toBe("Confirmando venda…");
  });

  it("does not allow submitting an invalid form", () => {
    const invalid = evaluate(createBlankSaleForm(sequentialIds()));
    expect(canStartSubmission(idleSubmission, invalid)).toBe(false);
  });

  it("locks the sale on network, 5xx and unknown failures", () => {
    for (const error of [
      new TypeError("Failed to fetch"),
      { code: "SERVICE_UNAVAILABLE" },
      { code: "INTERNAL_SERVER_ERROR" },
      new Error("boom"),
    ]) {
      const state = failSubmission(error);
      expect(state.phase).toBe("locked");
      expect(isFormLocked(state)).toBe(true);
      expect(submitButtonLabel(state)).toBe("Tentar novamente (seguro)");
    }
  });

  it("does not lock on definite 4xx failures, which keep editing open", () => {
    for (const error of [
      { code: "CONFLICT", data: { reason: "insufficient_stock" } },
      { code: "BAD_REQUEST", data: { reason: "invalid_sale_payment" } },
      { code: "NOT_FOUND", data: { reason: "payment_profile_not_found" } },
      { code: "CONFLICT" },
      { code: "UNAUTHORIZED" },
      { code: "FORBIDDEN" },
    ]) {
      const state = failSubmission(error);
      expect(state.phase).toBe("failed");
      expect(isFormLocked(state)).toBe(false);
      expect(submitButtonLabel(state)).toBe("Confirmar venda");
    }
    expect(submitButtonLabel(idleSubmission)).toBe("Confirmar venda");
  });

  it("rejects edits while the sale is locked or in flight", () => {
    const form = validForm();
    const { draftId } = lineOf(form);
    const edit = (current: SaleFormState) =>
      updateItem(current, draftId, { quantity: "9" });
    const locked = failSubmission(new TypeError("x"));
    expect(editSaleForm(locked, form, edit)).toBe(form);
    expect(editSaleForm(startSubmission(idleSubmission), form, edit)).toBe(
      form
    );
    expect(lineOf(editSaleForm(idleSubmission, form, edit)).quantity).toBe("9");
    const rejected = failSubmission({ code: "CONFLICT" });
    expect(lineOf(editSaleForm(rejected, form, edit)).quantity).toBe("9");
  });

  it("retries a locked sale with the same command ID and instant", () => {
    const ids = sequentialIds();
    const { body } = evaluate(validForm());
    if (!body) {
      throw new Error("expected a valid body");
    }
    const first = prepareConfirmation({
      body,
      createId: ids,
      now: new Date("2026-05-01T12:00:00.000Z"),
      organizationId,
      previousAttempt: null,
    });
    if (!first.ok) {
      throw new Error("expected a prepared request");
    }
    const locked = failSubmission(new TypeError("x"));
    expect(attemptAfterFailure(locked, first.attempt)).toBe(first.attempt);
    expect(canStartSubmission(locked, evaluate(validForm()))).toBe(true);
    expect(startSubmission(locked)).toEqual({ phase: "submitting" });
    const retry = prepareConfirmation({
      body,
      createId: ids,
      now: new Date("2026-05-01T12:30:00.000Z"),
      organizationId,
      previousAttempt: first.attempt,
    });
    expect(retry.ok && retry.request).toEqual(first.request);
  });

  it("needs an explicit second step to discard a locked sale", () => {
    const locked = failSubmission({ code: "BAD_GATEWAY" });
    expect(discardLockedSale(locked, sequentialIds())).toBeNull();
    const confirming = requestDiscard(locked);
    expect(confirming).toMatchObject({
      confirmingDiscard: true,
      phase: "locked",
    });
    expect(isFormLocked(confirming)).toBe(true);
    const cancelled = cancelDiscard(confirming);
    expect(cancelled).toMatchObject({ confirmingDiscard: false });
    expect(discardLockedSale(cancelled, sequentialIds())).toBeNull();
    expect(discardLockedSale(idleSubmission, sequentialIds())).toBeNull();
  });

  it("discards into a blank form with a fresh attempt", () => {
    const ids = sequentialIds();
    const { body } = evaluate(validForm());
    if (!body) {
      throw new Error("expected a valid body");
    }
    const now = new Date("2026-05-01T12:00:00.000Z");
    const old = resolveSaleAttempt(null, body, organizationId, ids, now);
    const confirming = requestDiscard(failSubmission(new TypeError("x")));
    const discarded = discardLockedSale(confirming, ids);
    expect(discarded).not.toBeNull();
    if (!discarded) {
      return;
    }
    expect(discarded.submission).toBe(idleSubmission);
    expect(discarded.attempt).toBeNull();
    expect(discarded.form.items).toHaveLength(1);
    expect(lineOf(discarded.form).productId).toBe("");
    expect(discarded.form.payment.method).toBe("");
    expect(isFormLocked(discarded.submission)).toBe(false);
    const next = resolveSaleAttempt(
      discarded.attempt,
      body,
      organizationId,
      ids,
      now
    );
    expect(next.commandId).not.toBe(old.commandId);
  });

  it("unlocks after a locked retry succeeds and reports a replay", () => {
    let state: SubmissionState = failSubmission(new TypeError("x"));
    state = startSubmission(state);
    expect(isFormLocked(state)).toBe(true);
    state = confirmSubmission({ ...confirmed, replayed: true });
    expect(isFormLocked(state)).toBe(false);
    expect(state.phase === "confirmed" && state.sale.headline).toBe(
      "Esta venda já estava confirmada. Nada foi duplicado."
    );
  });

  it("locks again if the retry also ends with an unknown outcome", () => {
    expect(failSubmission({ code: "GATEWAY_TIMEOUT" }).phase).toBe("locked");
  });

  it("shows the confirmed sale as the server snapshot returned it", () => {
    const state = confirmSubmission(confirmed);
    expect(state.phase).toBe("confirmed");
    if (state.phase !== "confirmed") {
      return;
    }
    expect(state.sale.headline).toBe("Venda confirmada.");
    expect(state.sale.totals.map((row) => row.value)).toEqual([
      "R$ 99,80",
      "-R$ 10,98",
      "R$ 88,82",
    ]);
    expect(state.sale.items[0]?.costText).toBe(
      "Custo desconhecido. Margem indeterminada."
    );
    const processing = state.sale.paymentDetails.find(
      (detail) => detail.label === "Taxa de processamento"
    );
    expect(processing).toEqual({
      label: "Taxa de processamento",
      tone: "unknown",
      value: "desconhecida — não é zero",
    });
    expect(state.sale.note).toContain("não comprova liquidação");
  });

  it("puts the three dates in the confirmed sale view", () => {
    const state = confirmSubmission({
      ...confirmed,
      sale: { ...confirmed.sale, recordedAt: "2026-05-01T11:59:00.000Z" },
    });
    const labels =
      state.phase === "confirmed"
        ? state.sale.saleDetails.map((row) => row.label)
        : [];
    expect(labels).toContain("Data da venda");
    expect(labels).toContain("Registrada no dispositivo");
    expect(labels).toContain("Confirmada no servidor");
  });

  it("says the sale was already confirmed when the server replayed it", () => {
    const state = confirmSubmission({ ...confirmed, replayed: true });
    expect(state.phase === "confirmed" && state.sale.headline).toBe(
      "Esta venda já estava confirmada. Nada foi duplicado."
    );
  });
});

describe("sale date and time", () => {
  const now = new Date(2026, 4, 1, 12, 0, 0);

  it("reads a datetime-local value in the device time zone", () => {
    const parsed = parseLocalDateTime("2026-04-20T09:30");
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.date.getFullYear()).toBe(2026);
      expect(parsed.date.getMonth()).toBe(3);
      expect(parsed.date.getDate()).toBe(20);
      expect(parsed.date.getHours()).toBe(9);
      expect(parsed.date.getMinutes()).toBe(30);
    }
    expect(parseLocalDateTime("2026-04-20T09:30:15").kind).toBe("ok");
  });

  it("treats empty as now and rejects anything unparsable", () => {
    expect(parseLocalDateTime("  ").kind).toBe("empty");
    for (const text of [
      "abc",
      "2026-04-20",
      "2026-13-01T10:00",
      "2026-02-31T10:00",
      "2026-04-20T25:00",
    ]) {
      expect(parseLocalDateTime(text).kind, text).toBe("invalid");
    }
  });

  it("validates: empty is fine, invalid and future are errors, past is accepted", () => {
    expect(validateSaleDate("", now)).toEqual({
      error: null,
      occurredAt: null,
    });
    expect(validateSaleDate("nope", now).error).toBe(
      "Informe uma data e hora válidas."
    );
    expect(validateSaleDate("2026-05-01T12:06", now).error).toBe(
      "A data e hora da venda não podem estar no futuro."
    );
    expect(validateSaleDate("2026-05-01T12:04", now).error).toBeNull();
    const past = validateSaleDate("2026-03-01T08:00", now);
    expect(past.error).toBeNull();
    expect(past.occurredAt).toBe(new Date(2026, 2, 1, 8, 0, 0).toISOString());
  });

  it("does not check the retroactive limit in the browser", () => {
    expect(validateSaleDate("2020-01-01T08:00", now).error).toBeNull();
  });

  it("blocks the form on a bad date and shows the error at once", () => {
    const bad = editSaleDate(validForm(), "2026-05-01T13:00");
    const result = evaluate(bad, context(), false, now);
    expect(result.body).toBeNull();
    expect(result.errors[formFieldKeys.occurredAt]).toContain("futuro");
  });

  it("carries the chosen date, or says it will be now", () => {
    expect(evaluate(validForm(), context(), true, now)).toMatchObject({
      dateText: "Agora, ao confirmar",
      occurredAtOverride: null,
    });
    const chosen = evaluate(
      editSaleDate(validForm(), "2026-04-25T10:00"),
      context(),
      true,
      now
    );
    expect(chosen.body).not.toBeNull();
    expect(chosen.occurredAtOverride).toBe(
      new Date(2026, 3, 25, 10, 0, 0).toISOString()
    );
    expect(chosen.dateText).not.toBe("Agora, ao confirmar");
  });

  const body = () => {
    const { body: built } = evaluate(validForm());
    if (!built) {
      throw new Error("expected a valid body");
    }
    return built;
  };

  it("freezes occurredAt and recordedAt for an identical retry", () => {
    const ids = sequentialIds();
    const first = resolveSaleAttempt(
      null,
      body(),
      organizationId,
      ids,
      new Date("2026-05-01T12:00:00.000Z")
    );
    expect(first.occurredAt).toBe("2026-05-01T12:00:00.000Z");
    expect(first.recordedAt).toBe("2026-05-01T12:00:00.000Z");
    const retry = resolveSaleAttempt(
      first,
      body(),
      organizationId,
      ids,
      new Date("2026-05-01T12:30:00.000Z")
    );
    expect(retry).toBe(first);
  });

  it("uses the chosen instant as occurredAt and the device clock as recordedAt", () => {
    const override = new Date(2026, 3, 25, 10, 0, 0).toISOString();
    const attempt = resolveSaleAttempt(
      null,
      body(),
      organizationId,
      sequentialIds(),
      new Date("2026-05-01T12:00:00.000Z"),
      override
    );
    expect(attempt.occurredAt).toBe(override);
    expect(attempt.recordedAt).toBe("2026-05-01T12:00:00.000Z");
  });

  it("gives a fresh command ID when only the date changes", () => {
    const ids = sequentialIds();
    const at = new Date("2026-05-01T12:00:00.000Z");
    const first = resolveSaleAttempt(
      null,
      body(),
      organizationId,
      ids,
      at,
      null
    );
    const dated = resolveSaleAttempt(
      first,
      body(),
      organizationId,
      ids,
      at,
      "2026-04-25T13:00:00.000Z"
    );
    expect(dated.commandId).not.toBe(first.commandId);
    const same = resolveSaleAttempt(
      dated,
      body(),
      organizationId,
      ids,
      at,
      "2026-04-25T13:00:00.000Z"
    );
    expect(same).toBe(dated);
  });

  it("sends recordedAt in the request, never clientCreatedAt", () => {
    const override = new Date(2026, 3, 25, 10, 0, 0).toISOString();
    const prepared = prepareConfirmation({
      body: body(),
      createId: sequentialIds(),
      now: new Date("2026-05-01T12:00:00.000Z"),
      occurredAtOverride: override,
      organizationId,
      previousAttempt: null,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.request).toMatchObject({
      occurredAt: override,
      recordedAt: "2026-05-01T12:00:00.000Z",
    });
    expect(prepared.request).not.toHaveProperty("clientCreatedAt");
  });

  it("refuses a future instant before any request", () => {
    const prepared = prepareConfirmation({
      body: body(),
      createId: sequentialIds(),
      now: new Date("2026-05-01T12:00:00.000Z"),
      occurredAtOverride: "2026-05-01T12:10:00.000Z",
      organizationId,
      previousAttempt: null,
    });
    expect(prepared).toEqual({
      message: "A data e hora da venda não podem estar no futuro.",
      ok: false,
    });
  });

  it("maps a sale too old to a message, without lock, with a fresh attempt", () => {
    const failure = mapSaleSubmitError({
      code: "BAD_REQUEST",
      data: { reason: "sale_occurred_too_old" },
    });
    expect(failure.message).toContain("limite retroativo de 30 dias");
    expect(failure.message).toContain("mais recente");
    expect(failure.discardAttempt).toBe(true);
    expect(failure.unknownOutcome).toBe(false);
    expect(
      failSubmission({
        code: "BAD_REQUEST",
        data: { reason: "sale_occurred_too_old" },
      }).phase
    ).toBe("failed");
    expect(
      mapSaleSubmitError({
        code: "BAD_REQUEST",
        data: { reason: "sale_occurred_in_future" },
      }).message
    ).toContain("adiantado");
  });

  it("formats the commercial date from the organization's calendar day", () => {
    expect(formatCalendarDate("2026-05-01")).toBe("01/05/2026");
  });

  const dates = {
    confirmedAt: "2026-05-10T12:00:00.000Z",
    occurredAt: "2026-05-10T11:00:00.000Z",
    occurredOn: "2026-05-10",
    recordedAt: "2026-05-10T11:59:00.000Z",
  };

  it("shows the three dates, in order, with the device evidence when present", () => {
    const rows = saleDateDetails(dates);
    expect(rows.map((row) => row.label).slice(0, 3)).toEqual([
      "Data da venda",
      "Registrada no dispositivo",
      "Confirmada no servidor",
    ]);
    expect(rows[0]?.value.startsWith("10/05/2026")).toBe(true);
    expect(rows[0]?.value).toContain("(horário deste dispositivo)");
    const without = saleDateDetails({ ...dates, recordedAt: null });
    expect(without.map((row) => row.label)).not.toContain(
      "Registrada no dispositivo"
    );
  });

  it("marks a retroactive sale only when its date is before the confirmation day", () => {
    const retro = saleDateDetails({
      ...dates,
      occurredAt: "2026-04-01T11:00:00.000Z",
      occurredOn: "2026-04-01",
    });
    expect(retro.at(-1)).toMatchObject({ label: "Venda retroativa" });
    expect(saleDateDetails(dates).map((row) => row.label)).not.toContain(
      "Venda retroativa"
    );
  });
});

describe("isSaleFormDirty (the sign that the session notice warns about)", () => {
  it("does not count a blank form, whose quantity already says 1", () => {
    expect(isSaleFormDirty(createBlankSaleForm(sequentialIds()))).toBe(false);
  });

  it("counts a cart built only by taps and selections, with no field typed", () => {
    const blank = createBlankSaleForm(sequentialIds());
    const { draftId } = lineOf(blank);
    const picked = selectItemVariant(
      selectItemProduct(blank, draftId, productId),
      draftId,
      variantId,
      "Camiseta — Azul / M"
    );

    expect(isSaleFormDirty(picked)).toBe(true);
    expect(isSaleFormDirty(addAdjustment(blank, "adjustment-1"))).toBe(true);
    expect(isSaleFormDirty(selectPaymentMethod(blank, "pix"))).toBe(true);
  });

  it("counts a typed quantity or price, and not a field put back to its start", () => {
    const blank = createBlankSaleForm(sequentialIds());
    const { draftId } = lineOf(blank);

    expect(isSaleFormDirty(updateItem(blank, draftId, { quantity: "3" }))).toBe(
      true
    );
    expect(
      isSaleFormDirty(updateItem(blank, draftId, { chargedUnitPrice: "9,90" }))
    ).toBe(true);
    expect(isSaleFormDirty(updateItem(blank, draftId, { quantity: "1" }))).toBe(
      false
    );
  });

  it("counts a complete sale", () => {
    expect(isSaleFormDirty(validForm())).toBe(true);
  });
});

describe("stepQuantity", () => {
  it("adds and removes one unit", () => {
    expect(stepQuantity("2", 1)).toBe("3");
    expect(stepQuantity("2", -1)).toBe("1");
    expect(stepQuantity(" 9 ", 1)).toBe("10");
  });

  it("never goes below 1", () => {
    expect(stepQuantity("1", -1)).toBeNull();
    expect(stepQuantity("1", 1)).toBe("2");
  });

  it("never goes above the maximum the server accepts", () => {
    expect(stepQuantity("2147483646", 1)).toBe("2147483647");
    expect(stepQuantity("2147483647", 1)).toBeNull();
    expect(stepQuantity("2147483647", -1)).toBe("2147483646");
  });

  it("starts an empty field at 1 and cannot take from it", () => {
    expect(stepQuantity("", 1)).toBe("1");
    expect(stepQuantity("  ", -1)).toBeNull();
  });

  it("leaves a text that is not a whole number for the person to fix", () => {
    for (const text of ["0", "1,5", "abc", "-2", "99999999999"]) {
      expect(stepQuantity(text, 1)).toBeNull();
      expect(stepQuantity(text, -1)).toBeNull();
    }
  });

  it("gives a text the form accepts as the quantity", () => {
    const form = validForm();
    const item = lineOf(form);
    const next = stepQuantity(item.quantity, 1);
    expect(next).toBe("3");
    const stepped = updateItem(form, item.draftId, { quantity: next ?? "" });
    const evaluation = evaluate(stepped);
    expect(evaluation.errors).toEqual({});
    expect(evaluation.summary?.lines[0]?.quantity).toBe(3);
  });
});

describe("the refusal for stock", () => {
  const first = "77777777-7777-4777-8777-777777777771";
  const second = "77777777-7777-4777-8777-777777777772";
  const third = "77777777-7777-4777-8777-777777777773";
  const fourth = "77777777-7777-4777-8777-777777777774";
  const fifth = "77777777-7777-4777-8777-777777777775";
  const labels = new Map([
    [first, "Caneca esmaltada"],
    [second, "Vela aromática"],
    [third, "Sabonete"],
    [fourth, "Toalha"],
    [fifth, "Chaveiro"],
  ]);
  const body = () => {
    const { body: built } = evaluate(validForm());
    if (!built) {
      throw new Error("expected a valid body");
    }
    return built;
  };
  const refused = failSubmission({
    code: "CONFLICT",
    data: { reason: "insufficient_stock" },
  });
  const stockOf = (quantities: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(quantities).map(([id, quantity]) => [
        id,
        {
          status: "ready" as const,
          value: {
            movingAverageCost: null,
            quantity,
            variantId: id,
            version: 1,
          },
        },
      ])
    ) as EvaluationContext["stock"];
  const refuse = (
    items: { quantity: number; variantId: string }[],
    quantities: Record<string, number>,
    canAdjustStock = true
  ) => {
    const described = describeStockRefusal(refused, {
      canAdjustStock,
      items,
      labels,
      stock: stockOf(quantities),
    });
    if (described.phase !== "failed") {
      throw new Error("the refusal stays a definite failure");
    }
    return described.failure;
  };

  it("drops the attempt: the sale after the entry is a new one, with its own command and instant", () => {
    expect(refused.phase === "failed" && refused.failure.discardAttempt).toBe(
      true
    );
  });

  it("after the refusal and the entry, the next confirmation is a new sale: new command, instant after the entry", () => {
    const ids = sequentialIds();
    const refusedAttempt = prepareConfirmation({
      body: body(),
      createId: ids,
      now: new Date("2026-05-01T12:00:00.000Z"),
      organizationId,
      previousAttempt: null,
    });
    if (!refusedAttempt.ok) {
      throw new Error("expected a prepared request");
    }
    const kept = attemptAfterFailure(refused, refusedAttempt.attempt);
    expect(kept).toBeNull();
    const afterEntry = prepareConfirmation({
      body: body(),
      createId: ids,
      now: new Date("2026-05-01T12:20:00.000Z"),
      organizationId,
      previousAttempt: kept,
    });
    if (!afterEntry.ok) {
      throw new Error("expected a prepared request");
    }
    expect(afterEntry.request.commandId).not.toBe(
      refusedAttempt.request.commandId
    );
    expect(afterEntry.request.occurredAt).toBe("2026-05-01T12:20:00.000Z");
    expect(afterEntry.request.recordedAt).toBe("2026-05-01T12:20:00.000Z");
  });

  it("names the one line that lacks stock, with what was asked and the balance, and points the link at it", () => {
    const failure = refuse(
      [
        { quantity: 2, variantId: first },
        { quantity: 1, variantId: second },
      ],
      { [first]: 0, [second]: 4 }
    );
    expect(failure.message).toBe(
      "A venda não foi registrada: falta estoque de Caneca esmaltada (pediu 2, saldo 0)."
    );
    expect(failure.entry).toEqual({
      label: "Caneca esmaltada",
      variantId: first,
    });
  });

  it("counts the lines of one variant together", () => {
    const failure = refuse(
      [
        { quantity: 2, variantId: first },
        { quantity: 2, variantId: first },
      ],
      { [first]: 3 }
    );
    expect(failure.message).toBe(
      "A venda não foi registrada: falta estoque de Caneca esmaltada (pediu 4, saldo 3)."
    );
  });

  it("says how many lines lack stock, lists them, and links the first", () => {
    const failure = refuse(
      [
        { quantity: 2, variantId: first },
        { quantity: 1, variantId: second },
      ],
      { [first]: 0, [second]: 0 }
    );
    expect(failure.message).toBe(
      "A venda não foi registrada: faltam 2 itens no estoque. Caneca esmaltada (pediu 2, saldo 0) e Vela aromática (pediu 1, saldo 0)."
    );
    expect(failure.entry?.variantId).toBe(first);
  });

  it("lists three lines and says how many more", () => {
    const items = [first, second, third, fourth, fifth].map((id) => ({
      quantity: 1,
      variantId: id,
    }));
    const failure = refuse(items, {
      [first]: 0,
      [fifth]: 0,
      [fourth]: 0,
      [second]: 0,
      [third]: 0,
    });
    expect(failure.message).toBe(
      "A venda não foi registrada: faltam 5 itens no estoque. Caneca esmaltada (pediu 1, saldo 0), Vela aromática (pediu 1, saldo 0), Sabonete (pediu 1, saldo 0) e mais 2."
    );
  });

  it("asks for whoever takes care of the stock, with no link, when the role cannot make the entry", () => {
    const one = refuse(
      [{ quantity: 2, variantId: first }],
      { [first]: 0 },
      false
    );
    expect(one.message).toBe(
      "A venda não foi registrada: falta estoque de Caneca esmaltada. Peça a quem cuida do estoque para dar entrada."
    );
    expect(one.entry).toBeNull();
    const many = refuse(
      [
        { quantity: 2, variantId: first },
        { quantity: 1, variantId: second },
      ],
      { [first]: 0, [second]: 0 },
      false
    );
    expect(many.message).toBe(
      "A venda não foi registrada: faltam 2 itens no estoque. Caneca esmaltada e Vela aromática. Peça a quem cuida do estoque para dar entrada."
    );
    expect(many.entry).toBeNull();
  });

  it("says so plainly, with no link, when no line can be pointed at", () => {
    const failure = refuse([{ quantity: 1, variantId: first }], {
      [first]: 9,
    });
    expect(failure.message).toBe(
      "A venda não foi registrada: falta estoque em um ou mais itens. Confira o saldo de cada um."
    );
    expect(failure.entry).toBeNull();
    const unread = describeStockRefusal(refused, {
      canAdjustStock: true,
      items: [{ quantity: 1, variantId: first }],
      labels,
      stock: {},
    });
    expect(unread.phase === "failed" && unread.failure.entry).toBeNull();
  });

  it("leaves every other failure as it was", () => {
    const other = failSubmission({ code: "CONFLICT" });
    expect(
      describeStockRefusal(other, {
        canAdjustStock: true,
        items: [{ quantity: 2, variantId: first }],
        labels,
        stock: stockOf({ [first]: 0 }),
      })
    ).toBe(other);
  });

  it("offers the entry on the zero-balance line only to who can make it", () => {
    const zero = balance(0, null);
    expect(stockView(zero, false)?.text).toBe(
      "Sem estoque: saldo 0. Peça a quem cuida do estoque para dar entrada."
    );
    expect(stockView(zero, false)?.text).not.toContain("servidor");
  });
});
