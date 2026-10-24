import type { ProductReadModel } from "@polaris/contracts";
import { useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import type { Workspace } from "./product-commands";
import { productErrorMessage } from "./product-errors";
import {
  findLinkedProduct,
  PRODUCT_LINK_NOT_FOUND,
  readProductsLink,
} from "./products-link-model";
import { listLocalProducts } from "./local-products";

interface ProductsLinkHandlers {
  /** `?novo=1`: open the form of a new product. */
  onNew: () => void;
  /** The text to say when the address names a product the person cannot see. */
  onNotice: (message: string) => void;
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
  const { products } = await orpcClient.product.list({
    organizationId,
    status: "all",
  });
  return products;
}

/**
 * Opens what the address of `/products` asks for, once. The address is read when the screen opens and never
 * again. A read that failed is tried again when the connection or the copy on the device changes; a product
 * that is not there (also one of another store) is said once, with the same words.
 */
export function useProductsLink(
  workspace: Workspace,
  organizationId: string,
  handlers: ProductsLinkHandlers
): void {
  const [link] = useState(() => readProductsLink(window.location.search));
  const handled = useRef<boolean>(false);
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
          latest.current.onNotice(productErrorMessage(cause));
        }
      });
    return () => {
      current = false;
    };
  }, [link, organizationId, workspace]);
}
