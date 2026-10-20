import { describe, expect, it } from "vitest";
import { bigInt, constantFrom, integer, oneof, property } from "fast-check";
import { assertProperty } from "../testing/property";
import { InvalidMoneyError, MoneyLimitError } from "../money/money";
import { InvalidSalePaymentError, normalizeSalePayment } from "./sale-payment";

const maxMoneyMinorUnits = 10n ** 20n - 1n;

function moneyFromMinorUnits(minorUnits: bigint): string {
  const whole = minorUnits / 100n;
  const fraction = (minorUnits % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

describe("normalizeSalePayment", () => {
  it("records the full sale amount and the credit card installment count", () => {
    expect(
      normalizeSalePayment(
        {
          anticipationRequested: true,
          installmentPlan: "merchant",
          installments: 3,
          method: "credit_card",
        },
        "55"
      )
    ).toEqual({
      anticipationRequested: true,
      amount: "55.00",
      installmentPlanUnknown: false,
      installmentPlan: "merchant",
      installments: 3,
      method: "credit_card",
    });
  });

  it("omits installments for non-credit card methods", () => {
    expect(normalizeSalePayment({ method: "cash" }, "12.5")).toEqual({
      anticipationRequested: false,
      amount: "12.50",
      installmentPlanUnknown: false,
      installmentPlan: null,
      installments: null,
      method: "cash",
    });
    expect(
      normalizeSalePayment({ method: "pix", installments: null }, "0")
    ).toEqual({
      anticipationRequested: false,
      amount: "0.00",
      installmentPlanUnknown: false,
      installmentPlan: null,
      installments: null,
      method: "pix",
    });
  });

  it("rejects unsupported methods and installments on other methods", () => {
    expect(() =>
      normalizeSalePayment({ method: "crypto" as never }, "10.00")
    ).toThrow(InvalidSalePaymentError);
    expect(() =>
      normalizeSalePayment({ method: "pix", installments: 1 }, "10.00")
    ).toThrow(InvalidSalePaymentError);
  });

  it("requires positive integer installments only for credit card", () => {
    for (const installments of [undefined, null, 0, -1, 1.5, 2_147_483_648]) {
      const input = {
        installmentPlan: "issuer" as const,
        installments: installments ?? null,
        method: "credit_card" as const,
      };
      expect(() => normalizeSalePayment(input, "10.00")).toThrow(
        InvalidSalePaymentError
      );
    }
  });

  it("validates the due amount as nonnegative BRL without rounding input", () => {
    expect(() => normalizeSalePayment({ method: "cash" }, "-0.01")).toThrow(
      InvalidSalePaymentError
    );
    expect(() => normalizeSalePayment({ method: "cash" }, "1.001")).toThrow(
      InvalidMoneyError
    );
    expect(() =>
      normalizeSalePayment({ method: "cash" }, "1000000000000000000")
    ).toThrow(MoneyLimitError);
  });

  it("normalizes generated amounts without changing their cent value, up to the largest amount", () => {
    assertProperty(
      property(
        oneof(
          bigInt({ min: 0n, max: maxMoneyMinorUnits }),
          constantFrom(0n, 1n, maxMoneyMinorUnits - 1n, maxMoneyMinorUnits)
        ),
        (minorUnits) => {
          const payment = normalizeSalePayment(
            { method: "bank_transfer" },
            moneyFromMinorUnits(minorUnits)
          );
          expect(payment.amount).toBe(moneyFromMinorUnits(minorUnits));
        }
      )
    );
  });

  it("refuses an amount past the largest one, however far", () => {
    assertProperty(
      property(
        oneof(
          bigInt({ min: maxMoneyMinorUnits + 1n, max: 10n ** 30n }),
          constantFrom(maxMoneyMinorUnits + 1n, maxMoneyMinorUnits + 2n)
        ),
        (minorUnits) => {
          expect(() =>
            normalizeSalePayment(
              { method: "bank_transfer" },
              moneyFromMinorUnits(minorUnits)
            )
          ).toThrow(MoneyLimitError);
        }
      )
    );
  });

  it("accepts installment counts throughout PostgreSQL integer range, and refuses 0 and the one past it", () => {
    // literals: moving the limit (or `>` to `>=`) in the code must turn this red
    const max = 2_147_483_647;
    const counts = oneof(
      integer({ min: 1, max }),
      constantFrom(-1, 0, 1, 2, max - 1, max, max + 1, max + 2, 1.5)
    );
    assertProperty(
      property(counts, (installments) => {
        const run = () =>
          normalizeSalePayment(
            {
              installmentPlan: "merchant",
              installments,
              method: "credit_card",
            },
            "10.00"
          );
        if (
          Number.isInteger(installments) &&
          installments >= 1 &&
          installments <= max
        ) {
          expect(run().installments).toBe(installments);
        } else {
          expect(run).toThrow(InvalidSalePaymentError);
        }
      })
    );
  });

  it("requires installment responsibility for credit card and disallows anticipation on other methods", () => {
    expect(() =>
      normalizeSalePayment({ installments: 3, method: "credit_card" }, "10.00")
    ).toThrow(InvalidSalePaymentError);
    expect(() =>
      normalizeSalePayment(
        { installmentPlan: "issuer", method: "credit_card" },
        "10.00"
      )
    ).toThrow(InvalidSalePaymentError);
    expect(() =>
      normalizeSalePayment(
        { anticipationRequested: true, method: "pix" },
        "10.00"
      )
    ).toThrow(InvalidSalePaymentError);
  });
});
