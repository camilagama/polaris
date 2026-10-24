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

  it("marks as security what the decision of 19/10/2026, its review corrections and ADR 0104 list, and nothing else", () => {
    const security = tenantAuditEventTypesOf("security");
    const families = ["data_export.", "offline_grant."];
    const named = [
      // the owner's billing requests (ADR 0104, decision 3, R-3): the capped refusals too
      "billing.checkout_started",
      "billing.command_in_progress",
      "billing.command_rate_limited",
      "billing.command_refused",
      "billing.owner_renewal_cancel_requested",
      "billing.refund_requested",
      "customer.anonymized",
      "organization.created",
      "organization.closure_requested",
      "organization.closure_recovered",
      "product.published_to_catalog",
      "product.unpublished_from_catalog",
      "public_catalog.profile_created",
      "public_catalog.profile_updated",
      "public_catalog.published",
      "public_catalog.unpublished",
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
    // opening the provider's page of the overdue charge changes nothing (ADR 0104)
    expect(tenantAuditEventClassOf("billing.overdue_payment_opened")).toBe(
      "operational"
    );
    // the closure's outbox event is not an audit type: the owner's request has its own name
    expect(isTenantAuditEventType("billing.renewal_cancel_requested")).toBe(
      false
    );
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
