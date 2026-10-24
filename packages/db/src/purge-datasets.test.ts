import { readdirSync, readFileSync } from "node:fs";
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
  PURGE_SURVIVING_TABLES,
} from "./purge-datasets";

const migration = readFileSync(
  new URL("../drizzle/0075_organization_purge.sql", import.meta.url),
  "utf8"
);
// the audit leaves the purge in this one (ADR 0081, amended 19/10/2026): it redefines the function
const auditMigration = readFileSync(
  new URL("../drizzle/0080_auditoria_sobrevive_ao_purge.sql", import.meta.url),
  "utf8"
);
const TRIAL_MIGRATION = /^\d{4}_trial_por_pessoa\.sql$/;
// the money facts carry their amount since this one (ADR 0101): it redefines the function with the two keys
// (found by its name: a renumbering at the merge does not break the test)
const drizzleDirectory = new URL("../drizzle/", import.meta.url);
const trialMigration = readFileSync(
  new URL(
    readdirSync(drizzleDirectory).find((name) => TRIAL_MIGRATION.test(name)) ??
      "missing-trial-migration.sql",
    drizzleDirectory
  ),
  "utf8"
);
const NOTICES_MIGRATION = /^\d{4}_avisos_de_cobranca\.sql$/;
// the notices of the billing cycle and the welcome join the purge in this one (ADR 0104): the latest that defines it
const noticesMigration = readFileSync(
  new URL(
    readdirSync(drizzleDirectory).find((name) =>
      NOTICES_MIGRATION.test(name)
    ) ?? "missing-notices-migration.sql",
    drizzleDirectory
  ),
  "utf8"
);
/** The list before the notices joined it: what 0080 and the trial migration hold. */
const DELETE_ORDER_BEFORE_NOTICES = PURGE_DELETE_ORDER.filter(
  (table) => table !== "billing_notices"
);
const billingStore = readFileSync(
  new URL("./billing-store.ts", import.meta.url),
  "utf8"
);

const quoted = /'([^']+)'/g;
const GRANT_AUDIT_TO_PURGE_OWNER =
  /GRANT[^;]*tenant_audit_event[^;]*TO polaris_purge_owner/;

/** The quoted names of a SQL `ARRAY[...]` that starts with the given declaration. */
function sqlArrays(declaration: string, source = migration): string[][] {
  const arrays: string[][] = [];
  let from = source.indexOf(declaration);
  while (from !== -1) {
    const start = from + declaration.length;
    const end = source.indexOf("]", start);
    const body = source.slice(start, end);
    arrays.push([...body.matchAll(quoted)].map((match) => match[1] ?? ""));
    from = source.indexOf(declaration, end);
  }
  return arrays;
}

/** Every fact of every type, with each field the lifecycle can write. */
function everyFact(): BillingFact[] {
  const occurredAt = new Date("2026-10-18T12:00:00.000Z");
  const periodEndsAt = new Date("2026-11-18T12:00:00.000Z");
  return BILLING_FACT_TYPES.map(
    (type) =>
      ({
        amount: { currency: "BRL", value: "24.90" },
        cycleMonths: 1,
        occurredAt,
        periodEndsAt,
        type,
      }) as BillingFact
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

  it("is the same list in the migrations that define the function since the amount, the latest included", () => {
    expect(
      sqlArrays("kept_fact_keys text[] := ARRAY[", trialMigration)
    ).toEqual([[...PURGE_BILLING_FACT_KEYS]]);
    expect(
      sqlArrays("kept_fact_keys text[] := ARRAY[", noticesMigration)
    ).toEqual([[...PURGE_BILLING_FACT_KEYS]]);
  });

  it("keeps the amount and the currency of a money fact (the fiscal record)", () => {
    expect(PURGE_BILLING_FACT_KEYS).toEqual(
      expect.arrayContaining(["amount", "currency"])
    );
  });

  it("keeps no payer data in the fact (pseudonymization)", () => {
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
  it("deletes the tables of the list, in its order, in the function of the audit migration and of the later ones", () => {
    expect(
      sqlArrays("deleted_tables text[] := ARRAY[", auditMigration)
    ).toEqual([DELETE_ORDER_BEFORE_NOTICES]);
    // and in the one that recreated it with the amount: the same tables, and still no audit
    expect(
      sqlArrays("deleted_tables text[] := ARRAY[", trialMigration)
    ).toEqual([DELETE_ORDER_BEFORE_NOTICES]);
    // the latest: the notices of the billing cycle and the welcome, before the outbox events that name them
    expect(
      sqlArrays("deleted_tables text[] := ARRAY[", noticesMigration)
    ).toEqual([[...PURGE_DELETE_ORDER]]);
    expect(noticesMigration).not.toMatch(GRANT_AUDIT_TO_PURGE_OWNER);
    expect(noticesMigration.split(`'${PURGE_REMOVED_TEXT}'`).length - 1).toBe(
      6
    );
    expect(trialMigration).not.toMatch(GRANT_AUDIT_TO_PURGE_OWNER);
    expect(trialMigration.split(`'${PURGE_REMOVED_TEXT}'`).length - 1).toBe(6);
  });

  it("does not delete the audit of the tenant: the list has no `tenant_audit_event` and the migration takes the table away from the purge role", () => {
    expect(PURGE_DELETE_ORDER).not.toContain("tenant_audit_event");
    expect(Object.keys(PURGE_SURVIVING_TABLES)).toContain("tenant_audit_event");
    expect(auditMigration).toContain(
      "REVOKE SELECT, DELETE ON TABLE public.tenant_audit_event FROM polaris_purge_owner;"
    );
    // the grants of 0075 still held the table (that is what the revoke undoes); the audit migration never grants it back
    expect(
      sqlArrays("deleted_tables text[] := ARRAY[").every((list) =>
        list.includes("tenant_audit_event")
      )
    ).toBe(true);
    expect(auditMigration).not.toMatch(GRANT_AUDIT_TO_PURGE_OWNER);
  });

  it("writes the same fixed text it declares in place of the free text", () => {
    expect(migration).toContain(`'${PURGE_REMOVED_TEXT}'`);
    expect(migration.split(`'${PURGE_REMOVED_TEXT}'`).length - 1).toBe(11);
    expect(auditMigration.split(`'${PURGE_REMOVED_TEXT}'`).length - 1).toBe(6);
  });
});
