import type { ProductReadModel } from "@polaris/contracts";
import { rpcErrorCode } from "../lib/rpc-error";
import { productErrorMessage } from "./product-errors";

/**
 * What `/products` opens by its address (the Início and the Venda link to it):
 * `?produto=<uuid>` the variants panel of that product, `?novo=1` the form of a
 * new one, `?importar=1` the import of a spreadsheet (the checklist of the Início).
 * Anything else is the plain list, and no value of the address is ever written
 * on the screen.
 */
export type ProductsLink =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "import" }
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
  if (params.get("importar") === "1") {
    return { kind: "import" };
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

/** The read of the product of the address failed: said once, with its own "Tentar novamente", unless the list already says the server is out. */
const PRODUCT_LINK_READ_FAILED =
  "Não foi possível abrir o produto. Tente novamente.";

/** What the screen says when the product of the address could not be read, and whether trying again can help. */
export interface ProductLinkFailure {
  message: string;
  retryable: boolean;
}

/**
 * No answer or a server that is out can be tried again, and says so in the words of the link. A refusal (no access,
 * terms not accepted) keeps the explanation of the list: a second try would only repeat it.
 */
export function productLinkFailure(cause: unknown): ProductLinkFailure {
  const code = rpcErrorCode(cause);
  if (code === undefined || code === "SERVICE_UNAVAILABLE") {
    return { message: PRODUCT_LINK_READ_FAILED, retryable: true };
  }
  return { message: productErrorMessage(cause), retryable: false };
}

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
