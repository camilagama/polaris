import { describe, expect, it } from "vitest";
import {
  isTaxIdDigits,
  isWooviGlobalId,
  isWooviPayerCorrelationId,
  wooviLogId,
} from "./ids";
import {
  globalId,
  INSTALLMENT_ID,
  INSTALLMENT_LOG_ID,
  SUBSCRIPTION_ID,
  SUBSCRIPTION_LOG_ID,
} from "./test-fixtures";

describe("isWooviGlobalId", () => {
  it("accepts the canonical ID of the right kind only", () => {
    expect(isWooviGlobalId("subscription", SUBSCRIPTION_ID)).toBe(true);
    expect(isWooviGlobalId("installment", INSTALLMENT_ID)).toBe(true);
    expect(isWooviGlobalId("installment", SUBSCRIPTION_ID)).toBe(false);
    expect(isWooviGlobalId("subscription", INSTALLMENT_ID)).toBe(false);
  });

  it.each([
    ["a path", "../x"],
    ["a query", `${SUBSCRIPTION_ID}?x=1`],
    ["empty", ""],
    ["a number", 1],
    ["null", null],
    ["another type", globalId("Customer")],
    [
      "upper-case hex",
      globalId("PaymentSubscription", "0123456789ABCDEF01234567"),
    ],
    [
      "a short ObjectId",
      globalId("PaymentSubscription", "0123456789abcdef0123"),
    ],
    [
      "a long ObjectId",
      globalId("PaymentSubscription", "0123456789abcdef012345678"),
    ],
    ["no padding", SUBSCRIPTION_ID.replace("=", "")],
    ["no type", btoa(":0123456789abcdef01234567")],
    ["a type prefix", btoa("XPaymentSubscription:0123456789abcdef01234567")],
  ])("refuses %s", (_name, value) => {
    expect(isWooviGlobalId("subscription", value)).toBe(false);
  });
});

describe("wooviLogId", () => {
  it("decodes a valid ID", () => {
    expect(wooviLogId("subscription", SUBSCRIPTION_ID)).toBe(
      SUBSCRIPTION_LOG_ID
    );
    expect(wooviLogId("installment", INSTALLMENT_ID)).toBe(INSTALLMENT_LOG_ID);
  });

  it("gives only the kind for anything else", () => {
    expect(wooviLogId("subscription", "../x")).toBe("PaymentSubscription:?");
    expect(wooviLogId("subscription", INSTALLMENT_ID)).toBe(
      "PaymentSubscription:?"
    );
  });
});

describe("isTaxIdDigits", () => {
  it.each(["52998224725", "11222333000181"])("accepts %s", (value) => {
    expect(isTaxIdDigits(value)).toBe(true);
  });

  it.each([
    "529.982.247-25",
    "5299822472",
    "529982247255",
    "",
    "5299822472a",
    11_222_333_000,
    null,
  ])("refuses %s", (value) => {
    expect(isTaxIdDigits(value)).toBe(false);
  });
});

describe("isWooviPayerCorrelationId", () => {
  it("accepts polaris-payer- and 32 lower-case hex digits", () => {
    expect(
      isWooviPayerCorrelationId(
        "polaris-payer-0123456789abcdef0123456789abcdef"
      )
    ).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["a dot", "."],
    ["a path step", ".."],
    ["a path", "../x"],
    ["a CPF", "52998224725"],
    ["a CNPJ", "11222333000181"],
    ["a plain key", "cust-fake_0001.a:b"],
    ["the prefix alone", "polaris-payer-"],
    ["31 hex digits", `polaris-payer-${"a".repeat(31)}`],
    ["33 hex digits", `polaris-payer-${"a".repeat(33)}`],
    ["upper-case hex", `polaris-payer-${"A".repeat(32)}`],
    ["non-hex digits", `polaris-payer-${"g".repeat(32)}`],
    ["a path after the key", `polaris-payer-${"a".repeat(32)}/x`],
    ["a query after the key", `polaris-payer-${"a".repeat(32)}?x=1`],
    ["a line break after the key", `polaris-payer-${"a".repeat(32)}\n`],
    ["a prefix before the key", `x-polaris-payer-${"a".repeat(32)}`],
    ["a number", 1],
    ["null", null],
  ])("refuses %s", (_name, value) => {
    expect(isWooviPayerCorrelationId(value)).toBe(false);
  });
});
