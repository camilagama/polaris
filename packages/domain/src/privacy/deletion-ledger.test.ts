import { describe, expect, it } from "vitest";
import {
  DELETION_LEDGER_KINDS,
  deletionLedgerEntry,
  InvalidDeletionLedgerEntryError,
} from "./deletion-ledger";

const CUSTOMER = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const CASE = "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c";
const ORGANIZATION = "org_AbC123-xyz";

const customerEntry = {
  entityId: CUSTOMER,
  entityType: "customer",
  operation: "anonymize",
  organizationId: ORGANIZATION,
} as const;

describe("deletionLedgerEntry", () => {
  it("accepts a customer anonymization and fills in no case", () => {
    expect(deletionLedgerEntry(customerEntry)).toEqual({
      ...customerEntry,
      privacyCaseId: null,
    });
  });

  it("accepts the case that asked for it", () => {
    expect(
      deletionLedgerEntry({ ...customerEntry, privacyCaseId: CASE })
        .privacyCaseId
    ).toBe(CASE);
  });

  it("accepts an organization purge that names the organization itself", () => {
    expect(
      deletionLedgerEntry({
        entityId: ORGANIZATION,
        entityType: "organization",
        operation: "purge",
        organizationId: ORGANIZATION,
      }).entityType
    ).toBe("organization");
  });

  it("refuses a pair of record and operation that has no meaning", () => {
    for (const [entityType, operation] of [
      ["customer", "purge"],
      ["organization", "anonymize"],
      ["sale", "purge"],
      ["customer", "delete"],
    ]) {
      expect(() =>
        deletionLedgerEntry({
          ...customerEntry,
          entityType,
          operation,
        } as never)
      ).toThrow(InvalidDeletionLedgerEntryError);
    }
  });

  it("refuses an ID that is not opaque: spaces, e-mail, punctuation, empty or long", () => {
    for (const entityId of [
      "",
      "Maria Souza",
      "maria@example.com",
      "+5511988887777",
      "a".repeat(65),
    ]) {
      expect(() => deletionLedgerEntry({ ...customerEntry, entityId })).toThrow(
        InvalidDeletionLedgerEntryError
      );
      expect(() =>
        deletionLedgerEntry({ ...customerEntry, organizationId: entityId })
      ).toThrow(InvalidDeletionLedgerEntryError);
    }
  });

  it("requires a customer to be a UUID and an organization purge to point at the organization", () => {
    expect(() =>
      deletionLedgerEntry({ ...customerEntry, entityId: "cliente-1" })
    ).toThrow(InvalidDeletionLedgerEntryError);
    expect(() =>
      deletionLedgerEntry({
        entityId: "other_org",
        entityType: "organization",
        operation: "purge",
        organizationId: ORGANIZATION,
      })
    ).toThrow(InvalidDeletionLedgerEntryError);
  });

  it("refuses an uppercase UUID, which would never match the record it names", () => {
    expect(() =>
      deletionLedgerEntry({
        ...customerEntry,
        entityId: CUSTOMER.toUpperCase(),
      })
    ).toThrow(InvalidDeletionLedgerEntryError);
  });

  it("refuses an ID that is not text instead of turning it into text", () => {
    for (const value of [123, 12_345, true, {}, ["abc"], 10n]) {
      expect(() =>
        deletionLedgerEntry({
          ...customerEntry,
          organizationId: value,
        } as never)
      ).toThrow(InvalidDeletionLedgerEntryError);
      expect(() =>
        deletionLedgerEntry({
          entityId: value,
          entityType: "organization",
          operation: "purge",
          organizationId: value,
        } as never)
      ).toThrow(InvalidDeletionLedgerEntryError);
      expect(() =>
        deletionLedgerEntry({ ...customerEntry, privacyCaseId: value } as never)
      ).toThrow(InvalidDeletionLedgerEntryError);
    }
  });

  it("refuses a case that is not a UUID", () => {
    expect(() =>
      deletionLedgerEntry({ ...customerEntry, privacyCaseId: "caso 1" })
    ).toThrow(InvalidDeletionLedgerEntryError);
  });

  it("refuses any field beyond the contract, so no business payload or personal data fits", () => {
    for (const extra of [
      { name: "Maria Aparecida Souza" },
      { email: "maria@example.com" },
      { phone: "+55 11 98888-7777" },
      { notes: "alergia a perfume" },
      { payload: { total: "10.00" } },
    ]) {
      expect(() =>
        deletionLedgerEntry({ ...customerEntry, ...extra } as never)
      ).toThrow(InvalidDeletionLedgerEntryError);
    }
  });

  it("names exactly the two kinds the plan needs", () => {
    expect(DELETION_LEDGER_KINDS.map((kind) => kind.operation)).toEqual([
      "anonymize",
      "purge",
    ]);
  });
});
