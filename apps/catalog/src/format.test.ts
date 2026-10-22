import { describe, expect, it } from "vitest";
import {
  hasContact,
  noPriceLabel,
  priceParts,
  productQuestion,
  whatsappLink,
} from "./format";

const ENCODED = /^[A-Za-z0-9\-_.!~*'()%]+$/;

describe("the WhatsApp link", () => {
  it("is on the fixed origin and takes only digits, 10 to 15 of them", () => {
    expect(whatsappLink("5511912345678")).toBe("https://wa.me/5511912345678");
    expect(whatsappLink("1234567890")).toBe("https://wa.me/1234567890");
    expect(whatsappLink("123456789012345")).toBe(
      "https://wa.me/123456789012345"
    );
    for (const bad of [
      "123456789",
      "1234567890123456",
      "+5511912345678",
      "55 11 91234-5678",
      "5511912345678/../x",
      "evil.example/5511912345678",
      "5511912345678?text=x",
      "",
    ]) {
      expect(whatsappLink(bad)).toBeNull();
    }
  });

  it("carries the message encoded, so a hostile product name stays inside it", () => {
    const name = 'Camisa "Tom & Jerry" #1 100% 🎉 a=b?c';
    const page = "https://catalogo.example/loja/p/0199a0a0";
    const link = whatsappLink("5511912345678", productQuestion(name, page));
    expect(link).not.toBeNull();
    const url = new URL(link ?? "");
    expect(url.origin).toBe("https://wa.me");
    expect(url.pathname).toBe("/5511912345678");
    expect(url.hash).toBe("");
    expect([...url.searchParams.keys()]).toEqual(["text"]);
    expect(url.searchParams.get("text")).toBe(productQuestion(name, page));
    expect(url.searchParams.get("text")).toContain(name);
    expect(url.searchParams.get("text")).toContain(page);
    // nothing of the name is left raw in the address
    expect(link?.slice("https://wa.me/5511912345678?text=".length)).toMatch(
      ENCODED
    );
  });
});

describe("the price pieces", () => {
  it("splits the symbol from the amount, and says nothing about what is not a price", () => {
    expect(priceParts("1234.5")).toEqual({ amount: "1.234,50", symbol: "R$" });
    expect(priceParts("abc")).toBeNull();
  });
});

describe("the text of a variant without a price", () => {
  const none = { instagram: null, whatsapp: null };

  it("points to a contact only when the store published one", () => {
    expect(noPriceLabel({ ...none, whatsapp: "5511912345678" })).toBe(
      "Preço sob consulta"
    );
    expect(noPriceLabel({ ...none, instagram: "loja.ana" })).toBe(
      "Preço sob consulta"
    );
    expect(noPriceLabel(none)).toBe("Preço não informado");
  });

  it("does not count a number that is not a valid link as a contact", () => {
    expect(hasContact({ ...none, whatsapp: "123" })).toBe(false);
    expect(noPriceLabel({ ...none, whatsapp: "123" })).toBe(
      "Preço não informado"
    );
  });
});
