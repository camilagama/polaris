import { describe, expect, it } from "vitest";
import {
  isSecurityPrefix,
  isTenantAuditEventType,
  TENANT_AUDIT_EVENT_CLASSES,
  TENANT_AUDIT_EVENT_TYPES,
  tenantAuditEventCheckSql,
  tenantAuditEventClassOf,
  tenantAuditEventClassSql,
  tenantAuditEventTypesOf,
} from "./tenant-audit-events";

const FORMAT = /^[a-z][a-z0-9_.-]{0,127}$/;

describe("the tenant audit event registry", () => {
  it("gives every type one known class and the shape the table accepts", () => {
    for (const [eventType, eventClass] of Object.entries(
      TENANT_AUDIT_EVENT_TYPES
    )) {
      expect(TENANT_AUDIT_EVENT_CLASSES).toContain(eventClass);
      expect(eventType).toMatch(FORMAT);
    }
  });

  it("marks as security what the decision of 19/10/2026 lists, and nothing else", () => {
    const security = tenantAuditEventTypesOf("security");
    const families = ["data_export.", "offline_grant."];
    const named = [
      "customer.anonymized",
      "organization.created",
      "organization.closure_requested",
      "organization.closure_recovered",
      "product.published_to_catalog",
      "product.unpublished_from_catalog",
    ];
    for (const eventType of security) {
      expect(
        named.includes(eventType) ||
          families.some((family) => eventType.startsWith(family)),
        eventType
      ).toBe(true);
    }
    for (const eventType of named) {
      expect(tenantAuditEventClassOf(eventType), eventType).toBe("security");
    }
    for (const family of families) {
      const members = Object.keys(TENANT_AUDIT_EVENT_TYPES).filter((type) =>
        type.startsWith(family)
      );
      expect(members.length).toBeGreaterThan(0);
      for (const member of members) {
        expect(tenantAuditEventClassOf(member), member).toBe("security");
      }
    }
    expect(tenantAuditEventClassOf("sale.confirmed")).toBe("operational");
  });

  it("will make a membership event security when one is registered", () => {
    expect(isSecurityPrefix("membership.invited")).toBe(true);
    expect(isSecurityPrefix("sale.confirmed")).toBe(false);
    for (const [eventType, eventClass] of Object.entries(
      TENANT_AUDIT_EVENT_TYPES
    )) {
      if (isSecurityPrefix(eventType)) {
        expect(eventClass, eventType).toBe("security");
      }
    }
  });

  it("does not know a type that was not registered", () => {
    expect(isTenantAuditEventType("sale.exploded")).toBe(false);
    expect(isTenantAuditEventType("toString")).toBe(false);
    expect(tenantAuditEventClassOf("sale.exploded")).toBeUndefined();
  });

  it("builds the CHECK and the class of the database from the same list", () => {
    const check = tenantAuditEventCheckSql();
    const classSql = tenantAuditEventClassSql();
    const quoted = (sql: string) =>
      [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(quoted(check).sort()).toEqual(
      Object.keys(TENANT_AUDIT_EVENT_TYPES).sort()
    );
    const securityInClass = quoted(classSql).filter(
      (value) => value !== "security" && value !== "operational"
    );
    expect(securityInClass.sort()).toEqual(
      [...tenantAuditEventTypesOf("security")].sort()
    );
  });
});
