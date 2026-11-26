import type { ProductReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { keepLocalRow, type Workspace } from "./product-commands";
import {
  type ProductDeleteRefusal,
  productDeleteRefusal,
} from "./product-errors";

const MENU_OF = (productId: string) =>
  `[data-product-id="${productId}"] [aria-label^="Mais ações para"]`;
const STATUS_TAB =
  '[aria-label="Estado dos produtos"] [role="tab"][aria-selected="true"]';

/** The quantity the product holds in stock, read after the server refused for the balance; `null` when it cannot be read. */
async function readBalance(
  organizationId: string,
  productId: string
): Promise<number | null> {
  try {
    const { variants } = await orpcClient.product.getVariants({
      id: productId,
      organizationId,
    });
    if (variants.length === 0) {
      return null;
    }
    const { entries } = await orpcClient.inventory.listBalances({
      limit: 100,
      organizationId,
      productStatus: "all",
      variantIds: variants.map((variant) => variant.id),
    });
    const total = entries.reduce((sum, entry) => sum + entry.quantity, 0);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

interface ProductDeleteOptions {
  /** The list of the status on screen, read again after a refusal: the asked product follows it. */
  isLoading: boolean;
  products: ProductReadModel[];
  /** The product is gone: the page says it, reads its plan use again and shows the list. */
  onDeleted: (product: ProductReadModel) => void;
  /** What the last action said goes away when this one starts. */
  onStart: () => void;
  organizationId: string;
  /** Reads the list again (a refusal says the list may be old). */
  refresh: () => void;
  workspace: Workspace;
}

/**
 * "Excluir produto": the asked product, the call and the refusal the dialog shows. The call is always the server's, with
 * the version the list showed; the local row changes only once the server confirmed (`keepLocalRow` with the product it
 * answered). Never a command kept on the device.
 */
export function useProductDelete({
  isLoading,
  onDeleted,
  onStart,
  organizationId,
  products,
  refresh,
  workspace,
}: ProductDeleteOptions) {
  const [target, setTarget] = useState<ProductReadModel | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<ProductDeleteRefusal | null>(null);
  // a second tap lands before React draws the disabled button
  const sending = useRef<boolean>(false);
  const neighbour = useRef<string | null>(null);
  // where the focus goes when the dialog closes: the product's own menu after a cancel, a neighbour after a deletion
  const focusAfter = useRef<() => HTMLElement | null>(() => null);

  const ask = useCallback(
    (product: ProductReadModel, shown: ProductReadModel[]) => {
      const index = shown.findIndex((item) => item.id === product.id);
      const neighbourId = (shown[index + 1] ?? shown[index - 1])?.id ?? null;
      onStart();
      setRefusal(null);
      focusAfter.current = () =>
        document.querySelector<HTMLElement>(MENU_OF(product.id));
      neighbour.current = neighbourId;
      setTarget(product);
    },
    [onStart]
  );

  /** The list read again has the product with a newer version: the dialog asks about that one, and sends its version. */
  const retarget = useCallback((product: ProductReadModel) => {
    if (!sending.current) {
      setTarget(product);
    }
  }, []);

  const cancel = useCallback(() => {
    if (!sending.current) {
      setTarget(null);
      setRefusal(null);
    }
  }, []);

  const confirm = useCallback(async () => {
    if (!target || sending.current) {
      return;
    }
    sending.current = true;
    setPending(true);
    setRefusal(null);
    try {
      const result = await orpcClient.product.delete({
        expectedVersion: target.version,
        id: target.id,
        organizationId,
      });
      // the server already deleted it: a failed write on this device must not read as a refusal
      await keepLocalRow(workspace, result.product).catch(() => undefined);
      const neighbourId = neighbour.current;
      focusAfter.current = () =>
        (neighbourId
          ? document.querySelector<HTMLElement>(MENU_OF(neighbourId))
          : null) ?? document.querySelector<HTMLElement>(STATUS_TAB);
      setTarget(null);
      onDeleted(result.product);
      refresh();
    } catch (cause: unknown) {
      const stock =
        (cause as { data?: { reason?: unknown } } | null)?.data?.reason ===
        "product_stock_not_empty"
          ? await readBalance(organizationId, target.id)
          : null;
      const next = productDeleteRefusal(cause, target.name, stock, new Date());
      setRefusal(next);
      if (next.reread) {
        workspace?.runtime.syncNow().catch(() => undefined);
        refresh();
      }
    } finally {
      sending.current = false;
      setPending(false);
    }
  }, [onDeleted, organizationId, refresh, target, workspace]);

  const listed = target
    ? products.find((item) => item.id === target.id)
    : undefined;
  useEffect(() => {
    if (target === null || isLoading) {
      return;
    }
    if (listed === undefined) {
      cancel();
    } else if (
      listed.version !== target.version ||
      listed.name !== target.name
    ) {
      retarget(listed);
    }
  }, [cancel, isLoading, listed, retarget, target]);

  const finalFocus = useCallback(() => focusAfter.current() ?? true, []);

  return {
    ask,
    cancel,
    confirm,
    finalFocus,
    pending,
    refusal,
    retarget,
    target,
  };
}
