import { describe, expect, it } from "vitest";
import { formatPrice, instagramLink, whatsappLink } from "./format";
import type { PageHead } from "./seo";
import {
  normalizeOrigin,
  productHead,
  productPath,
  storeHead,
  summarize,
} from "./seo";

const profile = {
  description: null,
  instagram: "loja.ana",
  name: "Loja da Ana",
  slug: "loja-da-ana",
  whatsapp: "5511912345678",
};
const product = {
  description: "Vestido de algodão, feito à mão.",
  id: "0199a0a0-0000-7000-8000-000000000001",
  media: [],
  name: "Vestido Azul",
  variants: [
    { id: "a", label: "Azul", price: "149.90" },
    { id: "b", label: "Preto", price: "129.9" },
    { id: "c", label: null, price: null },
  ],
};

const metaValue = (head: PageHead, key: string) =>
  head.meta.find((entry) => entry.name === key || entry.property === key)
    ?.content;

describe("the head of a store page", () => {
  const head = storeHead({ origin: "https://catalogo.example/", profile });

  it("has a title, a description with a fallback, and a canonical address", () => {
    expect(head.meta[0]).toEqual({ title: "Loja da Ana" });
    expect(metaValue(head, "description")).toBe("Catálogo de Loja da Ana.");
    expect(head.links).toEqual([
      { href: "https://catalogo.example/loja-da-ana", rel: "canonical" },
    ]);
  });

  it("carries the social preview of the same page", () => {
    expect(metaValue(head, "og:title")).toBe("Loja da Ana");
    expect(metaValue(head, "og:url")).toBe(
      "https://catalogo.example/loja-da-ana"
    );
    expect(metaValue(head, "og:type")).toBe("website");
    expect(metaValue(head, "twitter:card")).toBe("summary");
  });

  it("uses the description the organization typed", () => {
    const typed = storeHead({
      origin: "https://catalogo.example",
      profile: { ...profile, description: "Roupas   feitas\n à mão" },
    });
    expect(metaValue(typed, "description")).toBe("Roupas feitas à mão");
  });
});

describe("the head of a product page", () => {
  const head = productHead({
    origin: "https://catalogo.example",
    product: { ...product, description: null },
    profile,
  });

  it("names the product and the store and states the lowest price", () => {
    expect(head.meta[0]).toEqual({ title: "Vestido Azul · Loja da Ana" });
    expect(metaValue(head, "description")).toBe(
      "Vestido Azul a partir de R$ 129,90 em Loja da Ana."
    );
    expect(metaValue(head, "og:type")).toBe("product");
    expect(head.links[0]?.href).toBe(
      "https://catalogo.example/loja-da-ana/p/0199a0a0-0000-7000-8000-000000000001"
    );
  });

  it("says no price when no variant has one", () => {
    const bare = productHead({
      origin: "https://catalogo.example",
      product: {
        ...product,
        description: null,
        variants: [{ id: "c", label: null, price: null }],
      },
      profile,
    });
    expect(metaValue(bare, "description")).toBe("Vestido Azul em Loja da Ana.");
  });
});

describe("the preview image", () => {
  it("is the first product picture at 640, as an absolute address", () => {
    const head = productHead({
      origin: "https://catalogo.example",
      product: {
        ...product,
        media: [{ assetId: "asset-1", height: 400, width: 300 }],
      },
      profile,
    });
    const image =
      "https://catalogo.example/loja-da-ana/m/0199a0a0-0000-7000-8000-000000000001/asset-1?s=640";
    expect(metaValue(head, "og:image")).toBe(image);
    expect(metaValue(head, "twitter:image")).toBe(image);
    expect(metaValue(head, "twitter:card")).toBe("summary_large_image");
  });

  it("is the cover of the first product that has one, on the store page", () => {
    const head = storeHead({
      cover: { assetId: "a", productId: "p" },
      origin: "https://catalogo.example",
      profile,
    });
    expect(metaValue(head, "og:image")).toBe(
      "https://catalogo.example/loja-da-ana/m/p/a?s=640"
    );
  });

  it("is absent, and the card stays small, when there is no picture", () => {
    const head = storeHead({ origin: "https://catalogo.example", profile });
    expect(metaValue(head, "og:image")).toBeUndefined();
    expect(metaValue(head, "twitter:card")).toBe("summary");
  });
});

describe("the helpers", () => {
  it("cuts a long description at a word and marks the cut", () => {
    const long = `${"palavra ".repeat(40)}fim`;
    const summary = summarize(long) ?? "";
    expect([...summary].length).toBeLessThanOrEqual(160);
    expect(summary.endsWith("…")).toBe(true);
    expect(summarize("   ")).toBeNull();
    expect(summarize(null)).toBeNull();
  });

  it("keeps the origin and the paths free of stray characters", () => {
    expect(normalizeOrigin(" https://a.example/// ")).toBe("https://a.example");
    expect(productPath("loja", "a b")).toBe("/loja/p/a%20b");
  });

  it("spells a price without turning it into a number", () => {
    expect(formatPrice("129.90")).toBe("R$ 129,90");
    expect(formatPrice("129.9")).toBe("R$ 129,90");
    expect(formatPrice("1234567")).toBe("R$ 1.234.567,00");
    expect(formatPrice("0.05")).toBe("R$ 0,05");
    expect(formatPrice("abc")).toBe("abc");
    expect(whatsappLink("5511912345678")).toBe("https://wa.me/5511912345678");
    expect(instagramLink("loja.ana")).toBe(
      "https://www.instagram.com/loja.ana/"
    );
  });
});
