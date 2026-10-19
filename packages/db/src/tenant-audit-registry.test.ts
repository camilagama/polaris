import { readFileSync } from "node:fs";
import {
  tenantAuditEventCheckSql,
  tenantAuditEventClassSql,
} from "@polaris/domain/privacy/tenant-audit-events";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../drizzle/0080_auditoria_sobrevive_ao_purge.sql", import.meta.url),
  "utf8"
);

describe("the migration of the tenant audit registry", () => {
  it("holds the CHECK and the class column the domain registry builds", () => {
    expect(migration).toContain(
      `ADD CONSTRAINT "tenant_audit_event_type_registered" CHECK (${tenantAuditEventCheckSql('"tenant_audit_event"."event_type"')})`
    );
    expect(migration).toContain(
      `GENERATED ALWAYS AS (${tenantAuditEventClassSql()}) STORED NOT NULL`
    );
  });
});
