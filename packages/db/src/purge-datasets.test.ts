import { readFileSync } from "node:fs";
import {
  BILLING_FACT_TYPES,
  type BillingFact,
  serializeBillingFact,
} from "@polaris/domain/billing/facts";
import { describe, expect, it } from "vitest";
import {
  PURGE_BILLING_FACT_KEYS,
  PURGE_DELETE_ORDER,
  PURGE_REMOVED_TEXT,
} from "./purge-datasets";

const migration = readFileSync(
  new URL("../drizzle/0075_organization_purge.sql", import.meta.url),
  "utf8"
);
const billingStore = readFileSync(
  new URL("./billing-store.ts", import.meta.url),
  "utf8"
);

const quoted = /'([^']+)'/g;

/** The quoted names of a SQL `ARRAY[...]` that starts with the given declaration. */
function sqlArrays(declaration: string): string[][] {
  const arrays: string[][] = [];
  let from = migration.indexOf(declaration);
  while (from !== -1) {
    const start = from + declaration.length;
    const end = migration.indexOf("]", start);
    const body = migration.slice(start, end);
    arrays.push([...body.matchAll(quoted)].map((match) => match[1] ?? ""));
    from = migration.indexOf(declaration, end);
  }
  return arrays;
}

/** Every fact of every type, with each field the lifecycle can write. */
function everyFact(): BillingFact[] {
  const occurredAt = new Date("2026-10-18T12:00:00.000Z");
  const periodEndsAt = new Date("2026-11-18T12:00:00.000Z");
  return BILLING_FACT_TYPES.map(
    (type) =>
      ({ cycleMonths: 1, occurredAt, periodEndsAt, type }) as BillingFact
  );
}

/** The keys of the facts the billing store writes as commands and time events (`fact: { ... }`). */
function ledgerFactKeys(): Set<string> {
  const keys = new Set<string>();
  for (const match of billingStore.matchAll(/fact: \{([^}]*)\}/g)) {
    for (const key of (match[1] ?? "").matchAll(/(\w+)\s*:/g)) {
      keys.add(key[1] ?? "");
    }
  }
  return keys;
}

describe("the purge of the billing facts", () => {
  it("keeps every key the lifecycle writes for a provider fact", () => {
    for (const fact of everyFact()) {
      for (const key of Object.keys(serializeBillingFact(fact))) {
        expect(PURGE_BILLING_FACT_KEYS).toContain(key);
      }
    }
  });

  it("keeps every key of the ledger's commands and time events", () => {
    const keys = ledgerFactKeys();
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(PURGE_BILLING_FACT_KEYS).toContain(key);
    }
  });

  it("is the same list in the migration", () => {
    expect(sqlArrays("kept_fact_keys text[] := ARRAY[")).toEqual([
      [...PURGE_BILLING_FACT_KEYS],
    ]);
  });

  it("keeps nothing that names the payer", () => {
    for (const key of [
      "name",
      "document",
      "cpfCnpj",
      "email",
      "phone",
      "address",
      "customer",
      "customerId",
      "payer",
    ]) {
      expect(PURGE_BILLING_FACT_KEYS).not.toContain(key);
    }
  });
});

describe("the purge in the migration", () => {
  it("deletes the tables of the list, in its order, in the grants and in the function", () => {
    expect(sqlArrays("deleted_tables text[] := ARRAY[")).toEqual([
      [...PURGE_DELETE_ORDER],
      [...PURGE_DELETE_ORDER],
    ]);
  });

  it("writes the same fixed text it declares in place of the free text", () => {
    expect(migration).toContain(`'${PURGE_REMOVED_TEXT}'`);
    expect(migration.split(`'${PURGE_REMOVED_TEXT}'`).length - 1).toBe(7);
  });
});
