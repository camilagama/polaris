import type { CategoryReadModel, ProductReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import {
  type PendingProduct,
  pendingProducts,
} from "../offline/product-create";
import { listLocalCategories, listLocalProducts } from "./local-products";
import type { Workspace } from "./product-commands";
import { productErrorMessage } from "./product-errors";
import type { ProductListStatus } from "./product-list";

/**
 * The products and the categories of the screen, for one status. With the offline runtime ready they come from
 * this device and are read again whenever the runtime says the local rows may have changed; without it, from the
 * server. `refresh` shows a change that was just made.
 */
export function useProductsData(
  workspace: Workspace,
  organizationId: string,
  status: ProductListStatus
) {
  const [syncStates, setSyncStates] = useState<
    ReadonlyMap<string, PendingProduct>
  >(new Map());
  const [products, setProducts] = useState<ProductReadModel[]>([]);
  const [categories, setCategories] = useState<CategoryReadModel[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  // the first read is the loading state: an empty list before it would invite a first product that exists
  const [isLoading, setIsLoading] = useState(true);

  const usesLocalRows = workspace !== null;
  useEffect(() => {
    if (usesLocalRows) {
      return;
    }
    let current = true;
    setIsLoading(true);
    // a new try shows the loading again instead of the old message
    setLoadError(null);
    Promise.all([
      readWithRetry(() => orpcClient.product.list({ organizationId, status }), {
        isCurrent: () => current,
      }),
      readWithRetry(
        () => orpcClient.category.list({ organizationId, status: "all" }),
        { isCurrent: () => current }
      ),
    ])
      .then(([productResult, categoryResult]) => {
        if (current) {
          setProducts(productResult.products);
          setCategories(categoryResult.categories);
          setLoadError(null);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setLoadError(productErrorMessage(cause));
        }
      })
      .finally(() => {
        if (current) {
          setIsLoading(false);
        }
      });

    return () => {
      current = false;
    };
  }, [organizationId, refreshVersion, status, usesLocalRows]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    let current = true;
    const { outbox, writer } = workspace.stores;
    Promise.all([
      writer.rows("products"),
      writer.rows("categories"),
      pendingProducts(outbox),
    ])
      .then(([productRows, categoryRows, pending]) => {
        if (!current) {
          return;
        }
        setProducts(listLocalProducts(productRows, organizationId, status));
        setCategories(listLocalCategories(categoryRows, organizationId));
        setSyncStates(new Map(pending.map((item) => [item.productId, item])));
        setLoadError(null);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (current) {
          setLoadError(productErrorMessage(cause));
          setIsLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [workspace, organizationId, status]);

  /** Shows the change: the local rows are read again, or the server's list is. */
  const refresh = useCallback(() => {
    if (workspace) {
      workspace.runtime.refreshCounts().catch(() => undefined);
      workspace.runtime.localDataChanged();
      return;
    }
    setRefreshVersion((version) => version + 1);
  }, [workspace]);

  return { categories, isLoading, loadError, products, refresh, syncStates };
}
