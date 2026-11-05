import { describe, expect, it } from "vitest";
import { jsonByteLength } from "./json-bytes";

const encoder = new TextEncoder();
const exact = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).byteLength;

describe("jsonByteLength", () => {
  it.each([
    ["null", null],
    ["text", "R$ 1.926,30"],
    ["text with quotes and a backslash", 'a "b" \\ c'],
    ["text with a line break and a tab", "a\nb\tc"],
    ["text in Portuguese and an emoji", "Pão de açúcar 🍞"],
    ["a control character", "\u0001"],
    ["numbers", [0, -1, 12.5, 1e21, 1_234_567_890_123]],
    ["booleans", [true, false]],
    ["an empty object and array", { a: {}, b: [] }],
    [
      "undefined in an object and in an array",
      { a: undefined, b: [undefined, 1] },
    ],
    [
      "a summary-like answer",
      {
        cards: { items: 3, marginPercent: null, netSales: "10.00" },
        daily: [
          { costs: null, date: "2026-01-01", netSales: "0.00", salesCount: 0 },
          {
            costs: "1.00",
            date: "2026-02-01",
            days: 28,
            to: "2026-02-28",
            unknownDays: 0,
          },
        ],
        generatedAt: "2026-11-04T12:00:00.000Z",
        topProducts: [{ deleted: false, name: 'Café "forte"', quantity: 2 }],
      },
    ],
  ])("is the size of JSON.stringify for %s", (_, value) => {
    expect(jsonByteLength(value)).toBe(exact(value));
  });

  it("uses toJSON as JSON.stringify does", () => {
    const value = { at: new Date(Date.UTC(2026, 0, 1)) };
    expect(jsonByteLength(value)).toBe(exact(value));
  });
});
