import { and, asc, eq } from "drizzle-orm";
import { productMedia } from "./schema/media";
import { products } from "./schema/product";
import type { TenantRequestTransaction } from "./tenant-transaction";

/**
 * The cover of each product read: its image of lowest position, or none. Joined LATERAL with `LIMIT 1`, it reads at
 * most one row of the unique index `(organization_id, product_id, position)` per product, inside the same query, so
 * a list never asks for covers one product at a time. Row security on `product_media` still applies, so a cover is
 * always of the organization of the transaction.
 */
export function productCoverSubquery(transaction: TenantRequestTransaction) {
  return transaction
    .select({ coverAssetId: productMedia.mediaAssetId })
    .from(productMedia)
    .where(
      and(
        eq(productMedia.organizationId, products.organizationId),
        eq(productMedia.productId, products.id)
      )
    )
    .orderBy(asc(productMedia.position))
    .limit(1)
    .as("product_cover");
}
