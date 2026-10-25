import type { ProductReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import type { Workspace } from "./product-commands";
import {
  findLinkedProduct,
  PRODUCT_LINK_NOT_FOUND,
  type ProductLinkFailure,
  productLinkFailure,
  readProductsLink,
} from "./products-link-model";
import { listLocalProducts } from "./local-products";

interface ProductsLinkHandlers {
  /** `?novo=1`: open the form of a new product. */
  onNew: () => void;
  /** The text to say when the address names a product the person cannot see. */
  onNotice: (message: string) => void;
  /** The read of the product failed (the screen says it, or leaves it to the list's own alert). */
  onReadFailed: (failure: ProductLinkFailure) => void;
  /** `?produto=<uuid>`: open the panel of the product found. */
  onProduct: (product: ProductReadModel) => void;
}

/** Every product of the store, active or archived: from this device when the runtime is ready, else from the server. */
async function readProducts(
  workspace: Workspace,
  organizationId: string
): Promise<ProductReadModel[]> {
  if (workspace) {
    const rows = await workspace.stores.writer.rows("products");
    return [
      ...listLocalProducts(rows, organizationId, "active"),
      ...listLocalProducts(rows, organizationId, "archived"),
    ];
  }
  const { products } = await readWithRetry(() =>
    orpcClient.product.list({ organizationId, status: "all" })
  );
  return products;
}

/**
 * Opens what the address of `/products` asks for, once. The address is read when the screen opens and never
 * again. A read that failed is tried again when the connection or the copy on the device changes, and by the
 * `retry` it returns (the "Tentar novamente" of the screen); a product that is not there (also one of another
 * store) is said once, with the same words.
 */
export function useProductsLink(
  workspace: Workspace,
  organizationId: string,
  handlers: ProductsLinkHandlers
): { retry: () => void } {
  const [link] = useState(() => readProductsLink(window.location.search));
  const handled = useRef<boolean>(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (handled.current || link.kind === "none") {
      return;
    }
    if (link.kind === "new") {
      handled.current = true;
      latest.current.onNew();
      return;
    }
    let current = true;
    readProducts(workspace, organizationId)
      .then((products) => {
        if (!current) {
          return;
        }
        handled.current = true;
        const product = findLinkedProduct(products, link.productId);
        if (product) {
          latest.current.onProduct(product);
        } else {
          latest.current.onNotice(PRODUCT_LINK_NOT_FOUND);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          latest.current.onReadFailed(productLinkFailure(cause));
        }
      });
    return () => {
      current = false;
    };
  }, [attempt, link, organizationId, workspace]);

  return { retry };
}
