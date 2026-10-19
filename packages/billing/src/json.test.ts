import { describe, expect, it } from "vitest";
import {
  AMOUNT_PLACEHOLDER,
  JsonNumber,
  moneyFromJsonNumber,
  parseProviderJson,
  stringifyWithAmount,
} from "./json";
import { ProviderResponseMalformedError } from "./provider-port";

function numberAt(text: string): unknown {
  return (parseProviderJson(text) as { value: unknown }).value;
}

describe("parseProviderJson", () => {
  it.each([
    ["49.90", "49.90"],
    ["0.1", "0.1"],
    ["24.9", "24.9"],
    ["100", "100"],
    ["12345678901234567.89", "12345678901234567.89"],
  ])("keeps the source text of the number %s", (written, source) => {
    const value = numberAt(`{"value":${written}}`);
    expect(value).toBeInstanceOf(JsonNumber);
    expect((value as JsonNumber).source).toBe(source);
  });

  it("keeps a long number without losing digits that a float would drop", () => {
    expect(Number("12345678901234567.89").toString()).not.toBe(
      "12345678901234567.89"
    );
    expect(
      moneyFromJsonNumber(numberAt('{"value":12345678901234567.89}'))
    ).toBe("12345678901234567.89");
  });

  it("reads numbers inside arrays and nested objects, leaving other types alone", () => {
    const parsed = parseProviderJson(
      '{"data":[{"value":1.50,"ok":true,"name":"x","none":null}],"hasMore":false}'
    ) as {
      data: { value: JsonNumber; ok: boolean; name: string; none: null }[];
      hasMore: boolean;
    };
    expect(parsed.data[0]?.value.source).toBe("1.50");
    expect(parsed.data[0]?.ok).toBe(true);
    expect(parsed.data[0]?.name).toBe("x");
    expect(parsed.data[0]?.none).toBeNull();
    expect(parsed.hasMore).toBe(false);
  });

  it.each(["", "{", "not json", '{"value":}'])(
    "throws ProviderResponseMalformedError for %j",
    (text) => {
      expect(() => parseProviderJson(text)).toThrow(
        ProviderResponseMalformedError
      );
    }
  );
});

describe("moneyFromJsonNumber", () => {
  it.each([
    ["49.9", "49.90"],
    ["49.90", "49.90"],
    ["24.9", "24.90"],
    ["0.1", "0.10"],
    ["100", "100.00"],
    ["0", "0.00"],
  ])("normalizes %s to %s", (source, expected) => {
    expect(moneyFromJsonNumber(new JsonNumber(source))).toBe(expected);
  });

  it("returns null for anything that is not a JsonNumber", () => {
    expect(moneyFromJsonNumber("49.90")).toBeNull();
    expect(moneyFromJsonNumber(49.9)).toBeNull();
    expect(moneyFromJsonNumber(null)).toBeNull();
    expect(moneyFromJsonNumber(undefined)).toBeNull();
    expect(moneyFromJsonNumber({ source: "49.90" })).toBeNull();
  });

  it.each(["abc", "1e3", "", "49.999", "1234567890123456789012.00"])(
    "returns null for the invalid amount %j",
    (source) => {
      expect(moneyFromJsonNumber(new JsonNumber(source))).toBeNull();
    }
  );
});

describe("stringifyWithAmount", () => {
  const body = () => ({
    items: [{ quantity: 1, value: AMOUNT_PLACEHOLDER }],
    name: "Polaris",
  });

  it("writes the decimal text as a JSON number, not a string", () => {
    const text = stringifyWithAmount(body(), "24.90");
    expect(text).toContain('"value":24.90');
    expect(text).not.toContain('"value":"');
    expect(text).not.toContain("polaris-amount");
  });

  it("keeps the trailing zero a number would lose", () => {
    expect(JSON.stringify({ value: Number("24.90") })).toBe('{"value":24.9}');
    expect(stringifyWithAmount(body(), "24.90")).toContain("24.90");
    expect(stringifyWithAmount(body(), "249.00")).toContain('"value":249.00');
  });

  it("writes a long amount with every digit", () => {
    expect(stringifyWithAmount(body(), "12345678901234567.89")).toContain(
      '"value":12345678901234567.89'
    );
  });

  it("produces valid JSON whose other fields are untouched", () => {
    const text = stringifyWithAmount(body(), "24.90");
    const parsed = parseProviderJson(text) as {
      name: string;
      items: { quantity: JsonNumber; value: JsonNumber }[];
    };
    expect(parsed.name).toBe("Polaris");
    expect(parsed.items[0]?.value.source).toBe("24.90");
  });

  it.each(["0", "0.00", "-1.00", "-0.01"])(
    "refuses the amount %s",
    (amount) => {
      expect(() => stringifyWithAmount(body(), amount)).toThrow(RangeError);
    }
  );

  it("refuses an amount that is not a decimal", () => {
    expect(() => stringifyWithAmount(body(), "abc")).toThrow();
    expect(() => stringifyWithAmount(body(), "24.9.0")).toThrow();
    expect(() => stringifyWithAmount(body(), "")).toThrow();
  });

  it("refuses a body without the placeholder", () => {
    expect(() => stringifyWithAmount({ value: "x" }, "24.90")).toThrow(
      "amount_placeholder_misplaced"
    );
  });

  it("refuses a body with the placeholder twice", () => {
    expect(() =>
      stringifyWithAmount(
        { a: AMOUNT_PLACEHOLDER, b: AMOUNT_PLACEHOLDER },
        "24.90"
      )
    ).toThrow("amount_placeholder_misplaced");
  });
});
