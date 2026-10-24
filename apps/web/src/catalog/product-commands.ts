import type { ProductReadModel } from "@polaris/contracts";
import { orpcClient } from "../lib/orpc";
import { uuidv7 } from "../lib/uuidv7";
import { createOfflineProduct } from "../offline/product-create";
import type { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { toLocalProductRow } from "./local-products";
import { openingUnitsText } from "./product-opening-model";

export type Workspace = ReturnType<typeof useLocalWorkspace>;

/**
 * After the server changed a product, the same row goes into the local
 * collection (when the runtime is on), so the list read from the device shows
 * it at once instead of waiting for the next pull.
 */
export async function keepLocalRow(
  workspace: Workspace,
  product: ProductReadModel
): Promise<void> {
  if (workspace) {
    await workspace.stores.writer.upsert("products", [
      toLocalProductRow(product),
    ]);
  }
}

/**
 * The names of a new product, born once per opening of the form and kept for every retry of that form: a retry
 * after a network failure (the first try may have committed) names the same product, variant and stock command,
 * and the server answers it as a repeat instead of creating a second product.
 */
export interface NewProductIds {
  commandId: string;
  productId: string;
  variantId: string;
}

export function newProductIds(): NewProductIds {
  return {
    commandId: uuidv7(),
    productId: uuidv7(),
    variantId: uuidv7(),
  };
}

export interface NewProductInput {
  categoryId: string | null;
  description: string | null;
  /** The quantity the store has now, with the cost of each unit (`null` when it is not known). */
  initialStock: { quantity: number; unitCost: string | null } | null;
  /** BRL list price of the default variant as decimal text, if any. */
  listPrice: string | null;
  name: string;
}

/**
 * Creates a product with its price and opening stock and says what happened. With the offline runtime ready it is
 * queued on this device and shown at once (sent now when there is a connection); without it, it is created on the
 * server in one call (the server dates the stock today in the store's time zone). `today` is that date on the device.
 */
export async function createProduct(
  workspace: Workspace,
  organizationId: string,
  input: NewProductInput,
  names: { ids: NewProductIds; today: string }
): Promise<string> {
  if (!workspace) {
    const product = await orpcClient.product.create({
      categoryId: input.categoryId,
      description: input.description,
      initialStock: input.initialStock
        ? { ...input.initialStock, commandId: names.ids.commandId }
        : null,
      listPrice: input.listPrice,
      name: input.name,
      organizationId,
      productId: names.ids.productId,
      variantId: names.ids.variantId,
    });
    return `Produto “${product.name}” cadastrado${openingUnitsText(input)}.`;
  }
  const stores = workspace.runtime.context();
  if (!stores || stores.organizationId !== organizationId) {
    // not ready, or the organization changed under the screen: nothing is queued
    throw new Error("offline_runtime_unavailable");
  }
  await createOfflineProduct({
    deviceId: stores.deviceId,
    input: {
      categoryId: input.categoryId,
      description: input.description,
      initialStock: input.initialStock
        ? { ...input.initialStock, occurredOn: names.today }
        : null,
      listPrice: input.listPrice,
      name: input.name,
    },
    lease: stores.lease,
    organizationId,
    outbox: stores.outbox,
    writer: stores.writer,
  });
  const name = input.name.trim();
  if (workspace.online) {
    workspace.runtime.syncNow().catch(() => undefined);
    // the server has not answered yet: the row says "Aguardando envio" until it does
    return `Produto “${name}” guardado${openingUnitsText(input)}. Enviando…`;
  }
  return `Produto “${name}” salvo neste aparelho${openingUnitsText(input)}. Ele será enviado quando a conexão voltar.`;
}
