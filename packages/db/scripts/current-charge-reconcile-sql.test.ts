import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURRENT_CHARGE_RECONCILE_SQL } from "./current-charge-reconcile-sql";

const migration = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "drizzle",
    "0118_valor_da_cobranca_em_vigor.sql"
  ),
  "utf8"
);

const ROLE_RESET = /\bRESET ROLE;/g;
const ROLE_SWITCH = /\bSET ROLE\b/g;
const TIMEOUT_RESET = /\bRESET lock_timeout;/g;
const last = (pattern: RegExp): number =>
  Math.max(-1, ...[...migration.matchAll(pattern)].map((match) => match.index));
const ORDER_BY_TEXT = /ORDER BY[^\n]*->>/;

describe("the backfill of the charge in force", () => {
  it("is the very statement the reconcile script runs", () => {
    expect(migration).toContain(`${CURRENT_CHARGE_RECONCILE_SQL};`);
  });

  it("runs once, after the migration's last RESET ROLE and before its RESET lock_timeout", () => {
    const at = migration.indexOf(CURRENT_CHARGE_RECONCILE_SQL);
    expect(migration.indexOf(CURRENT_CHARGE_RECONCILE_SQL, at + 1)).toBe(-1);
    expect(last(ROLE_RESET)).toBeGreaterThan(-1);
    expect(last(ROLE_RESET)).toBeLessThan(at);
    expect(last(ROLE_SWITCH)).toBeLessThan(at);
    expect(last(TIMEOUT_RESET)).toBeGreaterThan(at);
  });

  it("filters by the record's own link and orders by the instant, not the text", () => {
    expect(CURRENT_CHARGE_RECONCILE_SQL).toContain(
      "charge.provider = billing.provider"
    );
    expect(CURRENT_CHARGE_RECONCILE_SQL).toContain(
      "charge.provider_ref = billing.provider_ref"
    );
    expect(CURRENT_CHARGE_RECONCILE_SQL).toContain(
      "charges.period_ends_at DESC"
    );
    expect(CURRENT_CHARGE_RECONCILE_SQL).not.toMatch(ORDER_BY_TEXT);
  });
});
