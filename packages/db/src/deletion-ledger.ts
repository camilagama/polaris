import {
  type DeletionLedgerEntryInput,
  deletionLedgerEntry,
  InvalidDeletionLedgerEntryError,
} from "@polaris/domain/privacy/deletion-ledger";
import { sql } from "drizzle-orm";
import type { TenantRequestTransaction } from "./tenant-transaction";

/**
 * Appends a tombstone to the deletion ledger (plan PR106, ADR 0080) in the transaction that did the
 * removal, so the two stand or fall together. The entry is checked first and carries no payload; the
 * database repeats the rules and, for the tenant runtime, accepts only the tombstone of a customer
 * that is already anonymized in the transaction's own organization (and no case: that column is the
 * privileged writers'). Doing it twice is a no-op.
 */
export async function recordDeletionLedgerEntry(
  transaction: TenantRequestTransaction,
  input: Omit<DeletionLedgerEntryInput, "privacyCaseId">
): Promise<void> {
  const entry = deletionLedgerEntry(input);
  if (entry.privacyCaseId !== null) {
    // not silently dropped: the tenant role cannot name a case, so asking for one is a mistake
    throw new InvalidDeletionLedgerEntryError();
  }
  // only the four columns the tenant role may insert are named (even a DEFAULT in the column list needs
  // the privilege): the ID, the case and the time are the table's own
  await transaction.execute(sql`
    INSERT INTO public.deletion_ledger (organization_id, entity_type, entity_id, operation)
    VALUES (${entry.organizationId}, ${entry.entityType}, ${entry.entityId}, ${entry.operation})
    ON CONFLICT DO NOTHING
  `);
}
