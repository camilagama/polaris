import type { ProductReadModel } from "@polaris/contracts";

/**
 * What `/products` opens by its address (the Início and the Venda link to it):
 * `?produto=<uuid>` the variants panel of that product, `?novo=1` the form of a
 * new one. Anything else is the plain list, and no value of the address is ever
 * written on the screen.
 */
export type ProductsLink =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "product"; productId: string };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readProductsLink(search: string): ProductsLink {
  const params = new URLSearchParams(search);
  const product = params.get("produto");
  if (product !== null) {
    const productId = product.trim();
    return uuidPattern.test(productId)
      ? { kind: "product", productId: productId.toLowerCase() }
      : { kind: "none" };
  }
  return params.get("novo") === "1" ? { kind: "new" } : { kind: "none" };
}

/**
 * The same text for an ID that does not exist, for one that was removed and for
 * one of another store (the database hides that row): the screen never tells
 * them apart.
 */
export const PRODUCT_LINK_NOT_FOUND =
  "Produto não encontrado. Escolha um produto na lista.";

/** The product the address names among the ones the person can see; a removed one is not found. */
export function findLinkedProduct(
  products: readonly ProductReadModel[],
  productId: string
): ProductReadModel | null {
  return (
    products.find(
      (product) => product.id === productId && product.status !== "deleted"
    ) ?? null
  );
}
