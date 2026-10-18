/**
 * The deletion ledger (plan PR106, ADR 0080): a minimal tombstone for what privacy took out of the
 * system, kept so that a restore of a backup can take it out again. A tombstone says that something
 * was removed, never what it was: opaque IDs, the kind of record, the kind of operation and the time.
 * No name, e-mail, phone, note or business value can be written, and an entry with any other field is
 * refused.
 */

/** The only pairs of record and operation a tombstone can describe. */
export const DELETION_LEDGER_KINDS = Object.freeze([
  { entityType: "customer", operation: "anonymize" },
  { entityType: "organization", operation: "purge" },
] as const);

export type DeletionLedgerKind = (typeof DELETION_LEDGER_KINDS)[number];
export type DeletionLedgerEntityType = DeletionLedgerKind["entityType"];
export type DeletionLedgerOperation = DeletionLedgerKind["operation"];

export interface DeletionLedgerEntry {
  entityId: string;
  entityType: DeletionLedgerEntityType;
  operation: DeletionLedgerOperation;
  organizationId: string;
  /** The privacy case that asked for it, when there is one (an opaque UUID). */
  privacyCaseId: string | null;
}

export type DeletionLedgerEntryInput = Omit<
  DeletionLedgerEntry,
  "privacyCaseId"
> & { privacyCaseId?: string | null };

export class InvalidDeletionLedgerEntryError extends Error {
  readonly code = "invalid_deletion_ledger_entry";

  constructor() {
    super("invalid_deletion_ledger_entry");
    this.name = "InvalidDeletionLedgerEntryError";
  }
}

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENTRY_FIELDS = new Set([
  "entityId",
  "entityType",
  "operation",
  "organizationId",
  "privacyCaseId",
]);

/**
 * Checks an entry before it is written and returns it with every field present. The database holds the
 * same rules (the CHECKs of `deletion_ledger`); this is the executable statement of them.
 */
export function deletionLedgerEntry(
  input: DeletionLedgerEntryInput
): DeletionLedgerEntry {
  const fields = Object.keys(input as object);
  if (fields.some((field) => !ENTRY_FIELDS.has(field))) {
    throw new InvalidDeletionLedgerEntryError();
  }
  const { entityId, entityType, operation, organizationId } = input;
  const privacyCaseId = input.privacyCaseId ?? null;
  const knownKind = DELETION_LEDGER_KINDS.some(
    (kind) => kind.entityType === entityType && kind.operation === operation
  );
  if (
    !(
      knownKind &&
      OPAQUE_ID.test(String(entityId)) &&
      OPAQUE_ID.test(String(organizationId))
    ) ||
    (entityType === "customer" && !UUID.test(entityId)) ||
    (entityType === "organization" && entityId !== organizationId) ||
    (privacyCaseId !== null && !UUID.test(privacyCaseId))
  ) {
    throw new InvalidDeletionLedgerEntryError();
  }
  return { entityId, entityType, operation, organizationId, privacyCaseId };
}
