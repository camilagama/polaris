import { describe, expect, it } from "vitest";
import {
  decodeInventoryBalanceCursor,
  encodeInventoryBalanceCursor,
  InvalidInventoryBalanceCursorError,
} from "./inventory-repository";

const urlSafeText = /^[A-Za-z0-9_-]+$/;
const cursor = {
  name: "camiseta ação 100% azul_m",
  position: 3,
  productId: "0199c2d0-0000-7000-8000-000000000001",
  variantId: "0199c2d0-0000-7000-8000-000000000002",
};

function encodeRaw(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

describe("inventory balance cursor", () => {
  it("round-trips accents and special characters in URL-safe text", () => {
    const text = encodeInventoryBalanceCursor(cursor);
    expect(text).toMatch(urlSafeText);
    expect(decodeInventoryBalanceCursor(text)).toEqual(cursor);
  });

  it.each([
    ["not base64", "!!!"],
    ["not JSON", btoa("hello")],
    ["wrong shape", encodeRaw({ name: "x" })],
    ["wrong arity", encodeRaw(["x", cursor.productId, 1])],
    ["bad product id", encodeRaw(["x", "nope", 1, cursor.variantId])],
    ["bad variant id", encodeRaw(["x", cursor.productId, 1, "nope"])],
    [
      "negative position",
      encodeRaw(["x", cursor.productId, -1, cursor.variantId]),
    ],
    [
      "fractional position",
      encodeRaw(["x", cursor.productId, 1.5, cursor.variantId]),
    ],
    ["non-text name", encodeRaw([7, cursor.productId, 1, cursor.variantId])],
  ])("rejects a cursor that is %s", (_label, text) => {
    expect(() => decodeInventoryBalanceCursor(text)).toThrow(
      InvalidInventoryBalanceCursorError
    );
  });
});
