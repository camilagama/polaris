import { describe, expect, it } from "vitest";
import {
  calendarDateInTimeZone,
  type ConfirmSaleCommandInput,
  composeConfirmedSale,
  InvalidConfirmSaleCommandError,
  MAX_FUTURE_CLOCK_SKEW_MS,
  normalizeConfirmSaleCommand,
  SaleOccurredInFutureError,
  summarizeConfirmedSaleTotals,
  UnsupportedConfirmSaleCommandVersionError,
} from "./confirm-sale";
import {
  InvalidSaleAdjustmentError,
  SaleDiscountExceedsSubtotalError,
} from "./sale-adjustments";
import {
  InvalidPaymentProfileError,
  type PaymentProfileForSale,
} from "./payment-profile";
import { InvalidSalePaymentError } from "./sale-payment";

const fixedNow = new Date("2026-10-14T00:00:00Z");
const normalize = (input: ConfirmSaleCommandInput, now: Date = fixedNow) =>
  normalizeConfirmSaleCommand(input, now);
const commandId = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a11";
const variantA = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a21";
const variantB = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a22";
const productA = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a31";
const productB = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a32";
const profileId = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a41";
const ruleId = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a51";

function command(
  overrides: Partial<ConfirmSaleCommandInput> = {}
): ConfirmSaleCommandInput {
  return {
    adjustments: [],
    commandId,
    commandVersion: 1,
    items: [
      {
        chargedUnitPrice: "89.90",
        listedUnitPrice: "100",
        quantity: 2,
        variantId: variantA,
      },
    ],
    occurredAt: "2026-10-13T15:30:00-03:00",
    payment: { anticipationRequested: false, method: "cash" },
    paymentProfile: null,
    ...overrides,
  };
}

function creditProfile(
  overrides: Partial<PaymentProfileForSale["rules"][number]> = {}
): PaymentProfileForSale {
  return {
    id: profileId,
    name: "Maquininha",
    rules: [
      {
        anticipationFee: {
          fixedAmount: "0.25",
          mode: "fixed_and_percentage",
          percentage: "0.500000",
        },
        expectedSettlementDays: 45,
        id: ruleId,
        installmentPlan: "issuer",
        installments: 3,
        method: "credit_card",
        processingFee: {
          fixedAmount: "0.10",
          mode: "fixed_and_percentage",
          percentage: "2.495600",
        },
        ...overrides,
      },
    ],
    version: 4,
  };
}

const resolvedA = {
  position: 0,
  productId: productA,
  productLabel: "  Camiseta  ",
  unitCost: "40.123456",
};

describe("normalizeConfirmSaleCommand", () => {
  it("prices the sale and derives a payment equal to the total due", () => {
    const normalized = normalize(
      command({
        adjustments: [
          { kind: "discount", value: { percentage: "10", type: "percentage" } },
          { kind: "freight", value: { amount: "5", type: "fixed" } },
        ],
      })
    );

    expect(normalized.calculation).toMatchObject({
      discountTotal: "17.98",
      freightTotal: "5.00",
      subtotal: "179.80",
      totalDue: "166.82",
    });
    expect(normalized.payment.amount).toBe("166.82");
    expect(normalized.commandId).toBe(commandId);
    expect(normalized.items).toEqual([
      {
        chargedUnitPrice: "89.90",
        listedUnitPrice: "100.00",
        position: 0,
        quantity: 2,
        variantId: variantA,
      },
    ]);
    expect(normalized.occurredAt.toISOString()).toBe(
      "2026-10-13T18:30:00.000Z"
    );
    expect(normalized.clientCreatedAt).toBeNull();
  });

  it("lowercases ids and keeps the explicit profile selection", () => {
    const normalized = normalize(
      command({
        commandId: commandId.toUpperCase(),
        paymentProfile: { expectedVersion: 4, id: profileId.toUpperCase() },
      })
    );
    expect(normalized.commandId).toBe(commandId);
    expect(normalized.paymentProfile).toEqual({
      expectedVersion: 4,
      id: profileId,
    });
  });

  it("requires an explicit profile choice instead of defaulting silently", () => {
    const input = {
      ...command(),
      paymentProfile: undefined,
    } as unknown as ConfirmSaleCommandInput;
    expect(() => normalize(input)).toThrow(InvalidConfirmSaleCommandError);
    expect(() =>
      normalize(
        command({ paymentProfile: { expectedVersion: 0, id: profileId } })
      )
    ).toThrow(InvalidConfirmSaleCommandError);
  });

  it("rejects unsupported versions, empty sales and malformed identifiers", () => {
    expect(() => normalize(command({ commandVersion: 2 }))).toThrow(
      UnsupportedConfirmSaleCommandVersionError
    );
    expect(() => normalize(command({ items: [] }))).toThrow(
      InvalidConfirmSaleCommandError
    );
    expect(() => normalize(command({ commandId: "not-a-uuid" }))).toThrow(
      InvalidConfirmSaleCommandError
    );
    expect(() =>
      normalize(
        command({
          items: [
            {
              chargedUnitPrice: "1",
              listedUnitPrice: "1",
              quantity: 1,
              variantId: "x",
            },
          ],
        })
      )
    ).toThrow(InvalidConfirmSaleCommandError);
  });

  it("rejects non-positive, fractional and oversized quantities", () => {
    for (const quantity of [0, -1, 1.5, 2_147_483_648, Number.NaN]) {
      expect(() =>
        normalize(
          command({
            items: [
              {
                chargedUnitPrice: "1",
                listedUnitPrice: "1",
                quantity,
                variantId: variantA,
              },
            ],
          })
        )
      ).toThrow(InvalidConfirmSaleCommandError);
    }
  });

  it("enforces BRL scale: two decimals, no negatives, no exponent", () => {
    for (const price of ["1.001", "-1", "1e3", "", " ", "1,5", "abc"]) {
      expect(() =>
        normalize(
          command({
            items: [
              {
                chargedUnitPrice: price,
                listedUnitPrice: "1",
                quantity: 1,
                variantId: variantA,
              },
            ],
          })
        )
      ).toThrow(InvalidConfirmSaleCommandError);
    }
    expect(() =>
      normalize(
        command({
          items: [
            {
              chargedUnitPrice: "1",
              listedUnitPrice: "1000000000000000000",
              quantity: 1,
              variantId: variantA,
            },
          ],
        })
      )
    ).toThrow(InvalidConfirmSaleCommandError);
  });

  it("requires valid instants with an offset", () => {
    for (const occurredAt of [
      "2026-10-13",
      "2026-10-13T10:00:00",
      "2026-13-40T10:00:00Z",
      "not a date",
      "0000-01-01T00:00:00+05:00",
      "9999-12-31T23:00:00-05:00",
    ]) {
      expect(() => normalize(command({ occurredAt }))).toThrow(
        InvalidConfirmSaleCommandError
      );
    }
    const normalized = normalize(
      command({ clientCreatedAt: "2026-10-13T12:00:00.250Z" })
    );
    expect(normalized.clientCreatedAt?.toISOString()).toBe(
      "2026-10-13T12:00:00.250Z"
    );
    expect(() => normalize(command({ clientCreatedAt: "yesterday" }))).toThrow(
      InvalidConfirmSaleCommandError
    );
  });

  it("rejects discounts above the subtotal and invalid adjustments", () => {
    expect(() =>
      normalize(
        command({
          adjustments: [
            { kind: "discount", value: { amount: "180", type: "fixed" } },
          ],
        })
      )
    ).toThrow(SaleDiscountExceedsSubtotalError);
    expect(() =>
      normalize(
        command({
          adjustments: [
            { kind: "freight", value: { percentage: "5", type: "percentage" } },
          ],
        })
      )
    ).toThrow(InvalidSaleAdjustmentError);
    expect(() =>
      normalize(
        command({
          adjustments: [
            { kind: "freight", value: { amount: "1.001", type: "fixed" } },
          ],
        })
      )
    ).toThrow();
  });

  it("validates payment shape: credit needs plan and installments, others none", () => {
    expect(() =>
      normalize(command({ payment: { method: "credit_card" } }))
    ).toThrow(InvalidSalePaymentError);
    expect(() =>
      normalize(
        command({
          payment: {
            installmentPlan: null,
            installments: 2,
            method: "credit_card",
          },
        })
      )
    ).toThrow(InvalidSalePaymentError);
    expect(() =>
      normalize(command({ payment: { installments: 2, method: "pix" } }))
    ).toThrow(InvalidSalePaymentError);
    expect(() =>
      normalize(
        command({
          payment: { anticipationRequested: true, method: "debit_card" },
        })
      )
    ).toThrow(InvalidSalePaymentError);
    const credit = normalize(
      command({
        payment: {
          anticipationRequested: true,
          installmentPlan: "merchant",
          installments: 12,
          method: "credit_card",
        },
      })
    );
    expect(credit.payment).toMatchObject({
      anticipationRequested: true,
      installmentPlan: "merchant",
      installments: 12,
    });
  });

  it("accepts a total of zero for a fully discounted sale", () => {
    const normalized = normalize(
      command({
        adjustments: [
          {
            kind: "discount",
            value: { percentage: "100", type: "percentage" },
          },
        ],
      })
    );
    expect(normalized.calculation.totalDue).toBe("0.00");
    expect(normalized.payment.amount).toBe("0.00");
  });
});

describe("composeConfirmedSale", () => {
  const creditCommand = () =>
    normalize(
      command({
        items: [
          {
            chargedUnitPrice: "100.00",
            listedUnitPrice: "100.00",
            quantity: 1,
            variantId: variantA,
          },
        ],
        payment: {
          anticipationRequested: true,
          installmentPlan: "issuer",
          installments: 3,
          method: "credit_card",
        },
        paymentProfile: { expectedVersion: 4, id: profileId },
      })
    );

  it("snapshots known fees from the exact rule (half-up once per cost)", () => {
    const composed = composeConfirmedSale(
      creditCommand(),
      [resolvedA],
      creditProfile()
    );
    expect(composed.paymentProfile).toEqual({
      anticipationFee: {
        amount: "0.75",
        fixedAmount: "0.25",
        mode: "fixed_and_percentage",
        percentage: "0.500000",
      },
      expectedSettlementDays: 45,
      paymentProfileId: profileId,
      paymentProfileName: "Maquininha",
      paymentProfileRuleId: ruleId,
      paymentProfileVersion: 4,
      processingFee: {
        amount: "2.60",
        fixedAmount: "0.10",
        mode: "fixed_and_percentage",
        percentage: "2.495600",
      },
    });
    expect(composed.sale.items[0]).toMatchObject({
      productId: productA,
      productLabel: "Camiseta",
      unitCost: "40.123456",
    });
  });

  it("keeps fees and settlement unknown when no profile is selected", () => {
    const composed = composeConfirmedSale(creditCommand(), [resolvedA], null);
    expect(composed.paymentProfile).toEqual({
      anticipationFee: {
        amount: null,
        fixedAmount: null,
        mode: "unknown",
        percentage: null,
      },
      expectedSettlementDays: null,
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
    });
  });

  it("does not block a sale whose profile lacks the exact rule", () => {
    const composed = composeConfirmedSale(
      creditCommand(),
      [resolvedA],
      creditProfile({ installments: 4 })
    );
    expect(composed.paymentProfile.paymentProfileId).toBe(profileId);
    expect(composed.paymentProfile.paymentProfileVersion).toBe(4);
    expect(composed.paymentProfile.paymentProfileRuleId).toBeNull();
    expect(composed.paymentProfile.processingFee.mode).toBe("unknown");
    expect(composed.paymentProfile.processingFee.amount).toBeNull();
    expect(composed.paymentProfile.anticipationFee.mode).toBe("unknown");
    expect(composed.paymentProfile.expectedSettlementDays).toBeNull();
  });

  it("does not match a rule with a different installment plan", () => {
    const composed = composeConfirmedSale(
      creditCommand(),
      [resolvedA],
      creditProfile({ installmentPlan: "merchant" })
    );
    expect(composed.paymentProfile.paymentProfileRuleId).toBeNull();
    expect(composed.paymentProfile.processingFee.amount).toBeNull();
  });

  it("applies only requested anticipation, as non applicable zero otherwise", () => {
    const withoutAnticipation = normalize(
      command({
        items: [
          {
            chargedUnitPrice: "100.00",
            listedUnitPrice: "100.00",
            quantity: 1,
            variantId: variantA,
          },
        ],
        payment: {
          anticipationRequested: false,
          installmentPlan: "issuer",
          installments: 3,
          method: "credit_card",
        },
        paymentProfile: { expectedVersion: 4, id: profileId },
      })
    );
    const composed = composeConfirmedSale(
      withoutAnticipation,
      [resolvedA],
      creditProfile()
    );
    expect(composed.paymentProfile.anticipationFee).toEqual({
      amount: "0.00",
      fixedAmount: null,
      mode: "not_applicable",
      percentage: null,
    });
    expect(composed.paymentProfile.processingFee.amount).toBe("2.60");
  });

  it("keeps a known zero distinct from an unknown fee", () => {
    const zeroProfile = creditProfile({
      anticipationFee: { fixedAmount: null, mode: "none", percentage: null },
      processingFee: { fixedAmount: null, mode: "none", percentage: null },
    });
    const zero = composeConfirmedSale(
      creditCommand(),
      [resolvedA],
      zeroProfile
    );
    expect(zero.paymentProfile.processingFee).toEqual({
      amount: "0.00",
      fixedAmount: null,
      mode: "none",
      percentage: null,
    });
    expect(zero.paymentProfile.anticipationFee.amount).toBe("0.00");

    const unknownProfile = creditProfile({
      anticipationFee: {
        fixedAmount: null,
        mode: "unknown",
        percentage: null,
      },
      processingFee: { fixedAmount: null, mode: "unknown", percentage: null },
    });
    const unknown = composeConfirmedSale(
      creditCommand(),
      [resolvedA],
      unknownProfile
    );
    expect(unknown.paymentProfile.processingFee.amount).toBeNull();
    expect(unknown.paymentProfile.anticipationFee.amount).toBeNull();
    expect(unknown.paymentProfile.paymentProfileRuleId).toBe(ruleId);
  });

  it("applies the percentage to the total due after adjustments", () => {
    const pix = normalize(
      command({
        adjustments: [
          { kind: "freight", value: { amount: "10", type: "fixed" } },
        ],
        items: [
          {
            chargedUnitPrice: "90.00",
            listedUnitPrice: "100.00",
            quantity: 1,
            variantId: variantA,
          },
        ],
        payment: { method: "pix" },
        paymentProfile: { expectedVersion: 4, id: profileId },
      })
    );
    const composed = composeConfirmedSale(pix, [resolvedA], {
      ...creditProfile(),
      rules: [
        {
          anticipationFee: {
            fixedAmount: null,
            mode: "none",
            percentage: null,
          },
          expectedSettlementDays: 1,
          id: ruleId,
          installmentPlan: null,
          installments: null,
          method: "pix",
          processingFee: {
            fixedAmount: null,
            mode: "percentage",
            percentage: "1.5",
          },
        },
      ],
    });
    // total due is 100.00 (90.00 + 10.00 freight); 1.5% of it is 1.50
    expect(composed.calculation.totalDue).toBe("100.00");
    expect(composed.paymentProfile.processingFee.amount).toBe("1.50");
  });

  it("rejects mismatched resolved items and invalid labels", () => {
    expect(() => composeConfirmedSale(creditCommand(), [], null)).toThrow(
      InvalidConfirmSaleCommandError
    );
    expect(() =>
      composeConfirmedSale(
        creditCommand(),
        [{ ...resolvedA, position: 3 }],
        null
      )
    ).toThrow(InvalidConfirmSaleCommandError);
    expect(() =>
      composeConfirmedSale(
        creditCommand(),
        [{ ...resolvedA, productLabel: "   " }],
        null
      )
    ).toThrow();
  });

  it("preserves unknown item cost instead of inferring zero", () => {
    const composed = composeConfirmedSale(
      normalize(command()),
      [{ ...resolvedA, unitCost: null }],
      null
    );
    expect(composed.sale.items[0]?.unitCost).toBeNull();
  });

  it("propagates an invalid profile rule as a payment profile error", () => {
    const badProfile = creditProfile({
      processingFee: {
        fixedAmount: "-1",
        mode: "fixed",
        percentage: null,
      },
    });
    expect(() =>
      composeConfirmedSale(creditCommand(), [resolvedA], badProfile)
    ).toThrow(InvalidPaymentProfileError);
  });

  it("keeps multi-item positions in order", () => {
    const normalized = normalize(
      command({
        items: [
          {
            chargedUnitPrice: "10.00",
            listedUnitPrice: "12.00",
            quantity: 1,
            variantId: variantA,
          },
          {
            chargedUnitPrice: "5.50",
            listedUnitPrice: "5.50",
            quantity: 3,
            variantId: variantB,
          },
        ],
      })
    );
    const composed = composeConfirmedSale(
      normalized,
      [
        { position: 1, productId: productB, productLabel: "B", unitCost: null },
        { ...resolvedA },
      ],
      null
    );
    expect(composed.sale.items.map((item) => item.position)).toEqual([0, 1]);
    expect(composed.sale.items.map((item) => item.productId)).toEqual([
      productA,
      productB,
    ]);
    expect(composed.calculation.subtotal).toBe("26.50");
  });
});

describe("summarizeConfirmedSaleTotals", () => {
  it("sums persisted amounts exactly without re-deriving percentages", () => {
    expect(
      summarizeConfirmedSaleTotals(
        [{ chargedUnitPrice: "89.90", quantity: 2 }],
        [
          { amount: "17.98", kind: "discount" },
          { amount: "5.00", kind: "freight" },
          { amount: "1.00", kind: "surcharge" },
          { amount: "2.00", kind: "payment_surcharge" },
        ]
      )
    ).toEqual({
      discountTotal: "17.98",
      freightTotal: "5.00",
      paymentSurchargeTotal: "2.00",
      subtotal: "179.80",
      surchargeTotal: "1.00",
      totalDue: "169.82",
    });
  });

  it("rejects an unknown adjustment kind", () => {
    expect(() =>
      summarizeConfirmedSaleTotals(
        [{ chargedUnitPrice: "1.00", quantity: 1 }],
        [{ amount: "1.00", kind: "tip" }]
      )
    ).toThrow(InvalidConfirmSaleCommandError);
  });
});

describe("calendarDateInTimeZone", () => {
  it("uses the organization time zone, not UTC, for the ledger date", () => {
    const instant = new Date("2026-10-14T01:30:00Z");
    expect(calendarDateInTimeZone(instant, "America/Sao_Paulo")).toBe(
      "2026-10-13"
    );
    expect(calendarDateInTimeZone(instant, "UTC")).toBe("2026-10-14");
    expect(calendarDateInTimeZone(instant, "Asia/Tokyo")).toBe("2026-10-14");
  });
});

describe("commercial time bounds", () => {
  const now = new Date("2026-10-14T12:00:00Z");

  it("accepts sales from any time in the past (offline confirmation)", () => {
    expect(() =>
      normalize(command({ occurredAt: "2024-01-02T03:04:05Z" }), now)
    ).not.toThrow();
    expect(() =>
      normalize(command({ occurredAt: "2026-10-14T11:59:59Z" }), now)
    ).not.toThrow();
  });

  it("allows clock skew up to the tolerance and rejects the future beyond it", () => {
    const edge = new Date(now.getTime() + MAX_FUTURE_CLOCK_SKEW_MS);
    expect(() =>
      normalize(command({ occurredAt: edge.toISOString() }), now)
    ).not.toThrow();
    const beyond = new Date(now.getTime() + MAX_FUTURE_CLOCK_SKEW_MS + 1000);
    expect(() =>
      normalize(command({ occurredAt: beyond.toISOString() }), now)
    ).toThrow(SaleOccurredInFutureError);
    expect(() =>
      normalize(command({ occurredAt: "2026-10-15T12:00:00Z" }), now)
    ).toThrow(SaleOccurredInFutureError);
  });
});
