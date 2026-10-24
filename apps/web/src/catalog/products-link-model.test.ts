import type { ProductReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  findLinkedProduct,
  PRODUCT_LINK_NOT_FOUND,
  readProductsLink,
} from "./products-link-model";

const ID = "0199c2d0-0000-7000-8000-000000000021";

const product = (
  overrides: Partial<ProductReadModel> = {}
): ProductReadModel => ({
  archivedAt: null,
  categoryId: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  description: null,
  id: ID,
  name: "Camiseta",
  organizationId: "org",
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
  ...overrides,
});

describe("readProductsLink", () => {
  it("reads a product id, in lowercase", () => {
    expect(readProductsLink(`?produto=${ID}`)).toEqual({
      kind: "product",
      productId: ID,
    });
    expect(readProductsLink(`?produto=${ID.toUpperCase()}`)).toEqual({
      kind: "product",
      productId: ID,
    });
  });

  it("reads the new-product address only as novo=1", () => {
    expect(readProductsLink("?novo=1")).toEqual({ kind: "new" });
    for (const search of [
      "?novo=",
      "?novo=0",
      "?novo=true",
      "?novo=11",
      "?novo",
    ]) {
      expect(readProductsLink(search)).toEqual({ kind: "none" });
    }
  });

  it("opens the plain list for an invalid id, and does not fall back to the form", () => {
    for (const search of [
      "",
      "?produto=",
      "?produto=abc",
      "?produto=<script>alert(1)</script>",
      `?produto=${ID}x`,
      "?produto=00000000-0000-0000-0000-000000000000",
      "?produto=abc&novo=1",
    ]) {
      expect(readProductsLink(search)).toEqual({ kind: "none" });
    }
  });

  it("lets the product win over the new form", () => {
    expect(readProductsLink(`?novo=1&produto=${ID}`)).toEqual({
      kind: "product",
      productId: ID,
    });
  });
});

describe("findLinkedProduct", () => {
  it("finds an active and an archived product", () => {
    expect(findLinkedProduct([product()], ID)?.id).toBe(ID);
    expect(
      findLinkedProduct([product({ status: "archived" })], ID)?.status
    ).toBe("archived");
  });

  it("does not find a removed product, an id the store does not have or the id of another store", () => {
    // another store's row never comes in the list (the database hides it), so it is simply absent
    const others = [product({ id: "0199c2d0-0000-7000-8000-000000000022" })];
    expect(findLinkedProduct([product({ status: "deleted" })], ID)).toBeNull();
    expect(findLinkedProduct(others, ID)).toBeNull();
    expect(findLinkedProduct([], ID)).toBeNull();
  });

  it("says the same words for every case that is not found", () => {
    expect(PRODUCT_LINK_NOT_FOUND).toBe(
      "Produto não encontrado. Escolha um produto na lista."
    );
  });
});
