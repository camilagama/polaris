import { archiveProduct, deleteProduct } from "../src/product-repository";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
} from "../src/tenant-transaction";

/**
 * The server only deletes an archived product, so a gate that needs a tombstone archives first, in the same
 * transaction, and deletes at the version the archive produced.
 */
export async function archiveThenDeleteProduct(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: { expectedVersion: number; id: string; requestId?: string | null }
) {
  const archived = await archiveProduct(transaction, identity, input);
  return await deleteProduct(transaction, identity, {
    ...input,
    expectedVersion: archived.product.version,
  });
}
