import { describe, expect, it } from "vitest";
import {
  formatFeePercentage,
  PERCENTAGE_RULE_TEXT,
  percentageFieldText,
  percentageProblem,
} from "./payment-fee-model";

describe("formatFeePercentage (U-30)", () => {
  it("shows the server's six decimals as the person reads them, in pt-BR", () => {
    expect(formatFeePercentage("3.000000")).toBe("3%");
    expect(formatFeePercentage("2.500000")).toBe("2,5%");
    expect(formatFeePercentage("2.990000")).toBe("2,99%");
    expect(formatFeePercentage("0.000000")).toBe("0%");
    expect(formatFeePercentage("100.000000")).toBe("100%");
  });

  it("never shows more than two decimals", () => {
    expect(formatFeePercentage("2.123456")).toBe("2,12%");
    expect(formatFeePercentage("2.126000")).toBe("2,13%");
  });

  it("never shows a fee that is not zero as 0%", () => {
    expect(formatFeePercentage("0.004000")).toBe("<0,01%");
    expect(formatFeePercentage("0.005000")).toBe("0,01%");
  });

  it("takes a value that is not a number as it came", () => {
    expect(formatFeePercentage("abc")).toBe("abc%");
    expect(formatFeePercentage("")).toBe("%");
  });
});

describe("percentageFieldText (U-30)", () => {
  it("fills the field without the zeros the server adds, keeping the digits that count", () => {
    expect(percentageFieldText("3.000000")).toBe("3");
    expect(percentageFieldText("2.500000")).toBe("2.5");
    expect(percentageFieldText("2.123456")).toBe("2.123456");
    expect(percentageFieldText("100")).toBe("100");
    expect(percentageFieldText(null)).toBe("");
  });
});

describe("percentageProblem (U-29)", () => {
  it("accepts what the server accepts", () => {
    for (const text of [
      "0",
      "2.5",
      "2.99",
      "100",
      "0.000001",
      " 3 ",
      "2.123456",
    ]) {
      expect(percentageProblem(text)).toBeNull();
    }
  });

  it("refuses with the limit that is accepted", () => {
    for (const text of [
      "",
      "  ",
      "abc",
      "-1",
      "100.01",
      "250",
      "2.1234567",
      "2,5",
      "1e2",
    ]) {
      expect(percentageProblem(text)).toBe(PERCENTAGE_RULE_TEXT);
    }
    expect(PERCENTAGE_RULE_TEXT).toBe(
      "Informe um percentual de 0 a 100, por exemplo 2,5."
    );
    // the six decimals are only enforced: the text does not ask the shopkeeper to count them
    expect(PERCENTAGE_RULE_TEXT).not.toContain("casas");
  });
});
