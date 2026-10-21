import type { ProductReadModel } from "@polaris/contracts";
import { orpcClient } from "../lib/orpc";
import { createOfflineProduct } from "../offline/product-create";
import type { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import { toLocalProductRow } from "./local-products";

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
 * Creates a product and says what happened. With the offline runtime ready it is
 * queued on this device and shown at once (sent now when there is a connection);
 * without it, it is created on the server as before.
 */
export async function createProduct(
  workspace: Workspace,
  organizationId: string,
  input: { categoryId: string | null; description: string | null; name: string }
): Promise<string> {
  if (!workspace) {
    const product = await orpcClient.product.create({
      ...input,
      organizationId,
    });
    return `Produto “${product.name}” cadastrado.`;
  }
  const stores = workspace.runtime.context();
  if (!stores || stores.organizationId !== organizationId) {
    // not ready, or the organization changed under the screen: nothing is queued
    throw new Error("offline_runtime_unavailable");
  }
  await createOfflineProduct({
    deviceId: stores.deviceId,
    input,
    lease: stores.lease,
    organizationId,
    outbox: stores.outbox,
    writer: stores.writer,
  });
  const name = input.name.trim();
  if (workspace.online) {
    workspace.runtime.syncNow().catch(() => undefined);
    // the server has not answered yet: the row says "Aguardando envio" until it does
    return `Produto “${name}” guardado. Enviando…`;
  }
  return `Produto “${name}” salvo neste aparelho. Ele será enviado quando a conexão voltar.`;
}
