import type {
  InventoryBalanceReadModel,
  PaymentProfileReadModel,
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { type Loadable, loadErrorMessage } from "./sale-form-model";

type LoadableMap<T> = Record<string, Loadable<T>>;

interface SaleCatalog {
  ensureStock: (variantId: string) => void;
  ensureVariants: (productId: string) => void;
  products: Loadable<ProductReadModel[]>;
  profiles: Loadable<PaymentProfileReadModel[]>;
  /** Reloads products, profiles, variants and stock. */
  refreshAll: () => void;
  /** Forgets the cached balances, e.g. after a confirmed sale moved stock. */
  resetStock: () => void;
  stock: LoadableMap<InventoryBalanceReadModel>;
  variants: LoadableMap<ProductVariantConfigurationReadModel>;
}

function keepReady<T>(current: Loadable<T>): Loadable<T> {
  return current.status === "ready" ? current : { status: "loading" };
}

/**
 * Read-only data the sale form needs. Reads are cached per product and variant
 * and are refreshed on demand; nothing here writes to the server.
 */
export function useSaleCatalog(
  organizationId: string | null,
  onProfilesLoaded: (profiles: PaymentProfileReadModel[]) => void
): SaleCatalog {
  const [products, setProducts] = useState<Loadable<ProductReadModel[]>>({
    status: "loading",
  });
  const [profiles, setProfiles] = useState<Loadable<PaymentProfileReadModel[]>>(
    { status: "loading" }
  );
  const [variants, setVariants] = useState<
    LoadableMap<ProductVariantConfigurationReadModel>
  >({});
  const [stock, setStock] = useState<LoadableMap<InventoryBalanceReadModel>>(
    {}
  );
  const requestedVariants = useRef(new Set<string>());
  const requestedStock = useRef(new Set<string>());
  const generation = useRef(0);

  const loadProducts = useCallback(async () => {
    if (!organizationId) {
      return;
    }
    setProducts(keepReady);
    try {
      const result = await orpcClient.product.list({
        organizationId,
        status: "active",
      });
      setProducts({ status: "ready", value: result.products });
    } catch (error) {
      setProducts({
        message: loadErrorMessage(error, "os produtos"),
        status: "error",
      });
    }
  }, [organizationId]);

  const loadProfiles = useCallback(async () => {
    if (!organizationId) {
      return;
    }
    setProfiles(keepReady);
    try {
      const result = await orpcClient.paymentProfile.list({
        organizationId,
        status: "active",
      });
      setProfiles({ status: "ready", value: result.profiles });
      onProfilesLoaded(result.profiles);
    } catch (error) {
      setProfiles({
        message: loadErrorMessage(error, "os perfis de pagamento"),
        status: "error",
      });
    }
  }, [onProfilesLoaded, organizationId]);

  useEffect(() => {
    loadProducts().catch(() => undefined);
    loadProfiles().catch(() => undefined);
  }, [loadProducts, loadProfiles]);

  const ensureVariants = useCallback(
    (productId: string) => {
      if (!organizationId || requestedVariants.current.has(productId)) {
        return;
      }
      requestedVariants.current.add(productId);
      const { current } = generation;
      setVariants((map) => ({ ...map, [productId]: { status: "loading" } }));
      orpcClient.product
        .getVariants({ id: productId, organizationId })
        .then((value) => {
          if (generation.current === current) {
            setVariants((map) => ({
              ...map,
              [productId]: { status: "ready", value },
            }));
          }
        })
        .catch((error: unknown) => {
          if (generation.current === current) {
            setVariants((map) => ({
              ...map,
              [productId]: {
                message: loadErrorMessage(error, "as variantes"),
                status: "error",
              },
            }));
          }
        });
    },
    [organizationId]
  );

  const ensureStock = useCallback(
    (variantId: string) => {
      if (!organizationId || requestedStock.current.has(variantId)) {
        return;
      }
      requestedStock.current.add(variantId);
      const { current } = generation;
      setStock((map) => ({ ...map, [variantId]: { status: "loading" } }));
      orpcClient.inventory
        .getBalance({ organizationId, variantId })
        .then((value) => {
          if (generation.current === current) {
            setStock((map) => ({
              ...map,
              [variantId]: { status: "ready", value },
            }));
          }
        })
        .catch((error: unknown) => {
          if (generation.current === current) {
            setStock((map) => ({
              ...map,
              [variantId]: {
                message: loadErrorMessage(error, "o estoque"),
                status: "error",
              },
            }));
          }
        });
    },
    [organizationId]
  );

  const resetStock = useCallback(() => {
    generation.current += 1;
    requestedStock.current.clear();
    setStock({});
  }, []);

  const refreshAll = useCallback(() => {
    generation.current += 1;
    requestedVariants.current.clear();
    requestedStock.current.clear();
    setVariants({});
    setStock({});
    loadProducts().catch(() => undefined);
    loadProfiles().catch(() => undefined);
  }, [loadProducts, loadProfiles]);

  return {
    ensureStock,
    ensureVariants,
    products,
    profiles,
    refreshAll,
    resetStock,
    stock,
    variants,
  };
}
