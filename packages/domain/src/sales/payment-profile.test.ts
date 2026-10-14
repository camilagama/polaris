import { describe, expect, it } from "vitest";
import {
  calculatePaymentFee,
  InvalidPaymentProfileError,
  type NormalizedPaymentProfileRule,
  normalizePaymentProfile,
  type PaymentProfileForSale,
  snapshotPaymentProfileForSale,
} from "./payment-profile";

const zeroFee = { mode: "none" as const };

function rule(
  overrides: Partial<NormalizedPaymentProfileRule> = {}
): NormalizedPaymentProfileRule {
  return {
    anticipationFee: { fixedAmount: null, mode: "unknown", percentage: null },
    expectedSettlementDays: 2,
    installmentPlan: null,
    installments: null,
    method: "pix",
    processingFee: { fixedAmount: null, mode: "none", percentage: null },
    ...overrides,
  };
}

function profile(
  overrides: Partial<PaymentProfileForSale> = {}
): PaymentProfileForSale {
  return {
    id: "64a12b6d-c7c1-40cb-b944-85fdced3bcf0",
    name: "Stone",
    rules: [
      {
        ...rule(),
        id: "fd8f4aa6-9c91-4576-a48a-9fa770b95257",
      },
    ],
    version: 1,
    ...overrides,
  };
}

describe("normalizePaymentProfile", () => {
  it("trims profile names and normalizes fixed and percentage fee inputs", () => {
    const result = normalizePaymentProfile({
      name: "  Stone  ",
      rules: [
        {
          anticipationFee: {
            fixedAmount: "0",
            mode: "fixed_and_percentage",
            percentage: "1.25",
          },
          expectedSettlementDays: 0,
          method: "pix",
          processingFee: {
            fixedAmount: "1.5",
            mode: "fixed_and_percentage",
            percentage: "2.5",
          },
        },
      ],
    });

    expect(result).toEqual({
      name: "Stone",
      rules: [
        {
          anticipationFee: {
            fixedAmount: "0.00",
            mode: "fixed_and_percentage",
            percentage: "1.250000",
          },
          expectedSettlementDays: 0,
          installmentPlan: null,
          installments: null,
          method: "pix",
          processingFee: {
            fixedAmount: "1.50",
            mode: "fixed_and_percentage",
            percentage: "2.500000",
          },
        },
      ],
    });
  });

  it("requires an exact card installment rule and a supported plan", () => {
    for (const invalid of [
      { installmentPlan: "merchant", installments: 0 },
      { installmentPlan: null, installments: 1 },
      { installmentPlan: "issuer", installments: 2_147_483_648 },
    ]) {
      expect(() =>
        normalizePaymentProfile({
          name: "Perfil",
          rules: [
            {
              anticipationFee: zeroFee,
              installmentPlan: invalid.installmentPlan as never,
              installments: invalid.installments,
              method: "credit_card",
              processingFee: zeroFee,
            },
          ],
        })
      ).toThrow(InvalidPaymentProfileError);
    }
  });

  it("rejects duplicate rules for the same payment method and card plan", () => {
    const cardRule = {
      anticipationFee: zeroFee,
      installmentPlan: "merchant" as const,
      installments: 3,
      method: "credit_card",
      processingFee: zeroFee,
    };

    expect(() =>
      normalizePaymentProfile({
        name: "Perfil",
        rules: [cardRule, cardRule],
      })
    ).toThrow(InvalidPaymentProfileError);
  });

  it("preserves the distinction between unknown and known zero fees", () => {
    const unknown = calculatePaymentFee("80.00", {
      fixedAmount: null,
      mode: "unknown",
      percentage: null,
    });
    const knownZero = calculatePaymentFee("80.00", {
      fixedAmount: null,
      mode: "none",
      percentage: null,
    });

    expect(unknown.amount).toBeNull();
    expect(knownZero.amount).toBe("0.00");
  });

  it("calculates fixed plus percentage against the full due amount and rounds once", () => {
    const result = calculatePaymentFee("100.00", {
      fixedAmount: "1.00",
      mode: "fixed_and_percentage",
      percentage: "2.5",
    });
    const halfCentTie = calculatePaymentFee("0.02", {
      fixedAmount: "0.00",
      mode: "fixed_and_percentage",
      percentage: "25",
    });

    expect(result.amount).toBe("3.50");
    expect(halfCentTie.amount).toBe("0.01");
  });
});

describe("snapshotPaymentProfileForSale", () => {
  it("snapshots the matching profile rule and calculated processing fee", () => {
    const selected = profile({
      rules: [
        {
          ...rule({
            expectedSettlementDays: 14,
            installmentPlan: "issuer",
            installments: 3,
            method: "credit_card",
            processingFee: {
              fixedAmount: "0.50",
              mode: "fixed_and_percentage",
              percentage: "2.5",
            },
          }),
          id: "fd8f4aa6-9c91-4576-a48a-9fa770b95257",
        },
      ],
      version: 4,
    });

    expect(
      snapshotPaymentProfileForSale(
        "100.00",
        {
          anticipationRequested: false,
          installmentPlan: "issuer",
          installments: 3,
          method: "credit_card",
        },
        selected
      )
    ).toEqual({
      anticipationFee: {
        amount: "0.00",
        fixedAmount: null,
        mode: "not_applicable",
        percentage: null,
      },
      expectedSettlementDays: 14,
      paymentProfileId: selected.id,
      paymentProfileName: "Stone",
      paymentProfileRuleId: selected.rules[0]?.id,
      paymentProfileVersion: 4,
      processingFee: {
        amount: "3.00",
        fixedAmount: "0.50",
        mode: "fixed_and_percentage",
        percentage: "2.500000",
      },
    });
  });

  it("keeps fees unknown without a profile or exact matching rule", () => {
    const withoutProfile = snapshotPaymentProfileForSale(
      "20.00",
      {
        anticipationRequested: false,
        installmentPlan: null,
        installments: null,
        method: "cash",
      },
      null
    );
    const unmatched = snapshotPaymentProfileForSale(
      "20.00",
      {
        anticipationRequested: false,
        installmentPlan: null,
        installments: null,
        method: "cash",
      },
      profile()
    );

    expect(withoutProfile.paymentProfileId).toBeNull();
    expect(withoutProfile.processingFee.amount).toBeNull();
    expect(unmatched.paymentProfileName).toBe("Stone");
    expect(unmatched.paymentProfileRuleId).toBeNull();
    expect(unmatched.processingFee.amount).toBeNull();
  });

  it("charges configured anticipation only when requested on the sale", () => {
    const selected = profile({
      rules: [
        {
          ...rule({
            anticipationFee: {
              fixedAmount: "1.00",
              mode: "fixed_and_percentage",
              percentage: "2",
            },
            installmentPlan: "merchant",
            installments: 2,
            method: "credit_card",
          }),
          id: "fd8f4aa6-9c91-4576-a48a-9fa770b95257",
        },
      ],
    });
    const payment = {
      installmentPlan: "merchant" as const,
      installments: 2,
      method: "credit_card",
    };

    const notRequested = snapshotPaymentProfileForSale(
      "50.00",
      { ...payment, anticipationRequested: false },
      selected
    );
    const requested = snapshotPaymentProfileForSale(
      "50.00",
      { ...payment, anticipationRequested: true },
      selected
    );

    expect(notRequested.anticipationFee).toEqual({
      amount: "0.00",
      fixedAmount: null,
      mode: "not_applicable",
      percentage: null,
    });
    expect(requested.anticipationFee).toEqual({
      amount: "2.00",
      fixedAmount: "1.00",
      mode: "fixed_and_percentage",
      percentage: "2.000000",
    });
  });

  it("keeps requested anticipation unknown when its profile rule is missing", () => {
    const result = snapshotPaymentProfileForSale(
      "20.00",
      {
        anticipationRequested: true,
        installmentPlan: "merchant",
        installments: 1,
        method: "credit_card",
      },
      profile()
    );

    expect(result.anticipationFee.mode).toBe("unknown");
    expect(result.anticipationFee.amount).toBeNull();
  });

  it("rejects anticipation requested for non-credit-card methods", () => {
    expect(() =>
      snapshotPaymentProfileForSale(
        "20.00",
        {
          anticipationRequested: true,
          installmentPlan: null,
          installments: null,
          method: "pix",
        },
        null
      )
    ).toThrow(InvalidPaymentProfileError);
  });
});

describe("payment profile limits", () => {
  const ruleWith = (override: Record<string, unknown>) => ({
    method: "pix",
    ...override,
  });
  const unknownFee = {
    fixedAmount: null,
    mode: "unknown",
    percentage: null,
  } as const;

  it("refuses a fee percentage above 100 points and an absurd settlement estimate", () => {
    const build = (ruleOverride: Record<string, unknown>) =>
      normalizePaymentProfile({
        name: "Limites",
        rules: [
          ruleWith({
            anticipationFee: unknownFee,
            processingFee: unknownFee,
            ...ruleOverride,
          }),
        ],
      } as never);
    expect(() =>
      build({
        processingFee: {
          fixedAmount: null,
          mode: "percentage",
          percentage: "250",
        },
      })
    ).toThrow(InvalidPaymentProfileError);
    expect(() =>
      build({
        processingFee: {
          fixedAmount: null,
          mode: "percentage",
          percentage: "100",
        },
      })
    ).not.toThrow();
    expect(() => build({ expectedSettlementDays: 3651 })).toThrow(
      InvalidPaymentProfileError
    );
    expect(() => build({ expectedSettlementDays: 3650 })).not.toThrow();
  });
});
