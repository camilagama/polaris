import { InvalidDeletionLedgerEntryError } from "@polaris/domain/privacy/deletion-ledger";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { recordDeletionLedgerEntry } from "./deletion-ledger";
import type { TenantRequestTransaction } from "./tenant-transaction";

const CUSTOMER = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const entry = {
  entityId: CUSTOMER,
  entityType: "customer",
  operation: "anonymize",
  organizationId: "organization-1",
} as const;

function fakeTransaction() {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  return {
    execute,
    transaction: { execute } as unknown as TenantRequestTransaction,
  };
}

describe("recordDeletionLedgerEntry", () => {
  it("inserts only the four columns the tenant role may write, and does nothing on a repeat", async () => {
    const { execute, transaction } = fakeTransaction();

    await recordDeletionLedgerEntry(transaction, entry);

    expect(execute).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql.replace(/\s+/g, " ").trim()).toBe(
      "INSERT INTO public.deletion_ledger (organization_id, entity_type, entity_id, operation) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING"
    );
    expect(query.params).toEqual([
      "organization-1",
      "customer",
      CUSTOMER,
      "anonymize",
    ]);
  });

  it.each([
    ["an ID that is not opaque", { ...entry, entityId: "Maria Souza" }],
    ["a kind that has no meaning", { ...entry, operation: "purge" }],
    ["a field beyond the contract", { ...entry, name: "Maria Souza" }],
    [
      "a case, which only privileged writers name",
      { ...entry, privacyCaseId: CUSTOMER },
    ],
  ])("refuses %s before touching the database", async (_label, bad) => {
    const { execute, transaction } = fakeTransaction();

    await expect(
      recordDeletionLedgerEntry(transaction, bad as never)
    ).rejects.toBeInstanceOf(InvalidDeletionLedgerEntryError);
    expect(execute).not.toHaveBeenCalled();
  });
});
