import { describe, expect, it } from "vitest";
import { assert as fcAssert, bigInt, integer, property } from "fast-check";
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
      normalizeSalePayment({ installments: 3, method: "credit_card" }, "55")
    ).toEqual({
      amount: "55.00",
      installments: 3,
      method: "credit_card",
    });
  });

  it("omits installments for non-credit card methods", () => {
    expect(normalizeSalePayment({ method: "cash" }, "12.5")).toEqual({
      amount: "12.50",
      installments: null,
      method: "cash",
    });
    expect(
      normalizeSalePayment({ method: "pix", installments: null }, "0")
    ).toEqual({
      amount: "0.00",
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
      const input =
        installments === undefined
          ? { method: "credit_card" as const }
          : { installments, method: "credit_card" as const };
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

  it("normalizes generated amounts without changing their cent value", async () => {
    await fcAssert(
      property(bigInt({ min: 0n, max: maxMoneyMinorUnits }), (minorUnits) => {
        const payment = normalizeSalePayment(
          { method: "bank_transfer" },
          moneyFromMinorUnits(minorUnits)
        );
        expect(payment.amount).toBe(moneyFromMinorUnits(minorUnits));
      }),
      { numRuns: 300 }
    );
  });

  it("accepts installment counts throughout PostgreSQL integer range", async () => {
    await fcAssert(
      property(integer({ min: 1, max: 2_147_483_647 }), (installments) => {
        expect(
          normalizeSalePayment({ method: "credit_card", installments }, "10.00")
            .installments
        ).toBe(installments);
      }),
      { numRuns: 300 }
    );
  });
});
