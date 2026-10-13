import { sql } from "drizzle-orm";
import type { TenantRequestTransaction } from "./tenant-transaction";

/**
 * Serializes the compensatory operations of one sale (cancellation and
 * returns) for the rest of the transaction. Without it, a return and a
 * cancellation, or two returns of the same units, could each pass their checks
 * against the committed state and both commit. The lock is transaction-scoped
 * and keyed by the sale ID, so unrelated sales never wait for each other.
 */
export async function lockSaleForCompensation(
  transaction: TenantRequestTransaction,
  saleId: string
): Promise<void> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`polaris.sale.compensation:${saleId}`}, 0))`
  );
}
