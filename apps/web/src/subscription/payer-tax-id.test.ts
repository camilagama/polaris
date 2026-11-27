import { billingStartCheckoutInput } from "@polaris/contracts";
import { describe, expect, it } from "vitest";

const VALID_CPF = "52998224725";
const VALID_CNPJ = "11222333000181";
const POLARIS_CNPJ = "35584467000100";

const payer = {
  email: "maria@example.com",
  name: "Maria da Silva",
};

function pixCheckout(taxId: string) {
  return {
    cycleMonths: 1,
    method: "pix_automatic",
    organizationId: "org-1",
    payer: { ...payer, taxId },
    trial: false,
  };
}

function accepts(taxId: string): boolean {
  return billingStartCheckoutInput.safeParse(pixCheckout(taxId)).success;
}

function withDigit(value: string, position: number, digit: string): string {
  return `${value.slice(0, position)}${digit}${value.slice(position + 1)}`;
}

describe("Pix Automático payer: CPF check digits", () => {
  it("takes a valid CPF", () => {
    expect(accepts(VALID_CPF)).toBe(true);
  });

  it("takes a valid CPF whose check digit comes from a remainder of 1", () => {
    expect(accepts("00010000470")).toBe(true);
  });

  it("refuses the same CPF with the last digit changed", () => {
    expect(accepts(withDigit(VALID_CPF, 10, "6"))).toBe(false);
  });

  it("refuses the same CPF with the second-to-last digit changed", () => {
    expect(accepts(withDigit(VALID_CPF, 9, "3"))).toBe(false);
  });

  it("only the tax ID decides: the payload around it is valid", () => {
    expect(
      billingStartCheckoutInput
        .safeParse(pixCheckout(withDigit(VALID_CPF, 10, "6")))
        .error?.issues.map((issue) => issue.path.join("."))
    ).toEqual(["payer.taxId"]);
  });
});

describe("Pix Automático payer: CNPJ check digits", () => {
  it("takes a valid CNPJ", () => {
    expect(accepts(VALID_CNPJ)).toBe(true);
  });

  it("refuses the same CNPJ with the 13th digit changed", () => {
    expect(accepts(withDigit(VALID_CNPJ, 12, "9"))).toBe(false);
  });

  it("refuses the 13th digit changed even with the 14th recomputed to match it", () => {
    expect(accepts("11222333000190")).toBe(false);
  });

  it("refuses the same CNPJ with the 14th digit changed", () => {
    expect(accepts(withDigit(VALID_CNPJ, 13, "2"))).toBe(false);
  });

  it("the supplier's own CNPJ (Terms) passes the arithmetic", () => {
    expect(accepts(POLARIS_CNPJ)).toBe(true);
  });
});

describe("Pix Automático payer: repeated digits are not documents", () => {
  const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

  it.each(digits)("refuses 11 times %s", (digit) => {
    expect(accepts(digit.repeat(11))).toBe(false);
  });

  it.each(digits)("refuses 14 times %s", (digit) => {
    expect(accepts(digit.repeat(14))).toBe(false);
  });
});

describe("Pix Automático payer: the shape of the tax ID", () => {
  it.each([
    ["dots and dash", "529.982.247-25"],
    ["10 digits", VALID_CPF.slice(0, 10)],
    ["12 digits", `${VALID_CPF}0`],
    ["13 digits", VALID_CNPJ.slice(0, 13)],
    ["15 digits", `${VALID_CNPJ}0`],
    ["a letter", "5299822472A"],
    ["a space in place of the last digit (Number(' ') is 0)", "0001000047 "],
    ["empty", ""],
  ])("refuses %s", (_name, taxId) => {
    expect(accepts(taxId)).toBe(false);
  });
});

describe("Card checkout asks nothing of the payer", () => {
  it("takes the card without a payer", () => {
    expect(
      billingStartCheckoutInput.safeParse({
        cycleMonths: 1,
        method: "card",
        organizationId: "org-1",
        trial: false,
      }).success
    ).toBe(true);
  });
});
