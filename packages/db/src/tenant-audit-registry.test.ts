import { readFileSync } from "node:fs";
import {
  tenantAuditEventCheckSql,
  tenantAuditEventClassSql,
} from "@polaris/domain/privacy/tenant-audit-events";
import { describe, expect, it } from "vitest";

// the last migration that rebuilt the registry's CHECK and class (ADR 0104 added the owner's billing requests)
const migration = readFileSync(
  new URL("../drizzle/0100_autosservico_de_cobranca.sql", import.meta.url),
  "utf8"
);

const DROP_COLUMN = /drop column/i;

describe("the migration of the tenant audit registry", () => {
  it("holds the CHECK and the class column the domain registry builds", () => {
    expect(migration).toContain(
      `ADD CONSTRAINT "tenant_audit_event_type_registered" CHECK (${tenantAuditEventCheckSql('"tenant_audit_event"."event_type"')})`
    );
    // the generated column takes the new expression in place, never dropped and added again (ADR 0096)
    expect(migration).toContain(
      `ALTER COLUMN "event_class" SET EXPRESSION AS (${tenantAuditEventClassSql()})`
    );
    expect(migration).not.toMatch(DROP_COLUMN);
  });
});
