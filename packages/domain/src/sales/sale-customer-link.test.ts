import { describe, expect, it } from "vitest";
import {
  InvalidSaleCustomerLinkError,
  normalizeSaleCustomerLinkCommand,
  planSaleCustomerLinkTransition,
  SaleCustomerLinkStateError,
  SaleCustomerLinkVersionConflictError,
  saleCustomerLinkAuditEvent,
} from "./sale-customer-link";

const saleId = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a11";
const customerA = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a21";
const customerB = "0190a9d2-7c4c-7b2f-9c0e-5f4f4f0d6a22";

const none = { customerId: null, version: 0 };
const assignedA = { customerId: customerA, version: 1 };
const unassigned = { customerId: null, version: 2 };

function command(
  action: "assign" | "reassign" | "unassign",
  customerId: string | null,
  expectedVersion: number
) {
  return normalizeSaleCustomerLinkCommand({
    action,
    customerId,
    expectedVersion,
    saleId,
  });
}

describe("normalizeSaleCustomerLinkCommand", () => {
  it("lowercases ids and requires the customer for assign and reassign", () => {
    expect(
      normalizeSaleCustomerLinkCommand({
        action: "assign",
        customerId: customerA.toUpperCase(),
        expectedVersion: 0,
        saleId: saleId.toUpperCase(),
      })
    ).toEqual({
      action: "assign",
      customerId: customerA,
      expectedVersion: 0,
      saleId,
    });
    for (const action of ["assign", "reassign"] as const) {
      expect(() =>
        normalizeSaleCustomerLinkCommand({
          action,
          customerId: null,
          expectedVersion: 0,
          saleId,
        })
      ).toThrow(InvalidSaleCustomerLinkError);
      expect(() =>
        normalizeSaleCustomerLinkCommand({
          action,
          expectedVersion: 0,
          saleId,
        })
      ).toThrow(InvalidSaleCustomerLinkError);
    }
  });

  it("forbids a customer on unassign", () => {
    expect(command("unassign", null, 1).customerId).toBeNull();
    expect(() => command("unassign", customerA, 1)).toThrow(
      InvalidSaleCustomerLinkError
    );
  });

  it("rejects malformed ids, actions and versions", () => {
    const base = {
      action: "assign" as const,
      customerId: customerA,
      expectedVersion: 0,
      saleId,
    };
    expect(() =>
      normalizeSaleCustomerLinkCommand({ ...base, saleId: "nope" })
    ).toThrow(InvalidSaleCustomerLinkError);
    expect(() =>
      normalizeSaleCustomerLinkCommand({ ...base, customerId: "nope" })
    ).toThrow(InvalidSaleCustomerLinkError);
    expect(() =>
      normalizeSaleCustomerLinkCommand({
        ...base,
        action: "merge" as unknown as "assign",
      })
    ).toThrow(InvalidSaleCustomerLinkError);
    for (const expectedVersion of [-1, 1.5, 2_147_483_648, Number.NaN]) {
      expect(() =>
        normalizeSaleCustomerLinkCommand({ ...base, expectedVersion })
      ).toThrow(InvalidSaleCustomerLinkError);
    }
  });
});

describe("planSaleCustomerLinkTransition", () => {
  it("assigns a sale that never had a customer as version 1", () => {
    expect(
      planSaleCustomerLinkTransition(none, command("assign", customerA, 0))
    ).toEqual({
      changed: true,
      next: { customerId: customerA, version: 1 },
    });
  });

  it("assigns again after an unassign, continuing the version history", () => {
    expect(
      planSaleCustomerLinkTransition(
        unassigned,
        command("assign", customerB, 2)
      )
    ).toEqual({ changed: true, next: { customerId: customerB, version: 3 } });
  });

  it("reassigns to a different customer and unassigns", () => {
    expect(
      planSaleCustomerLinkTransition(
        assignedA,
        command("reassign", customerB, 1)
      )
    ).toEqual({ changed: true, next: { customerId: customerB, version: 2 } });
    expect(
      planSaleCustomerLinkTransition(assignedA, command("unassign", null, 1))
    ).toEqual({ changed: true, next: { customerId: null, version: 2 } });
  });

  it("treats repeating an action that already holds as a no-op", () => {
    expect(
      planSaleCustomerLinkTransition(assignedA, command("assign", customerA, 1))
    ).toEqual({ changed: false, state: assignedA });
    expect(
      planSaleCustomerLinkTransition(
        assignedA,
        command("reassign", customerA, 1)
      )
    ).toEqual({ changed: false, state: assignedA });
    expect(
      planSaleCustomerLinkTransition(unassigned, command("unassign", null, 2))
    ).toEqual({ changed: false, state: unassigned });
    expect(
      planSaleCustomerLinkTransition(none, command("unassign", null, 0))
    ).toEqual({ changed: false, state: none });
  });

  it("does not let assign replace a different customer or reassign start one", () => {
    expect(() =>
      planSaleCustomerLinkTransition(assignedA, command("assign", customerB, 1))
    ).toThrow(SaleCustomerLinkStateError);
    expect(() =>
      planSaleCustomerLinkTransition(none, command("reassign", customerA, 0))
    ).toThrow(SaleCustomerLinkStateError);
    expect(() =>
      planSaleCustomerLinkTransition(
        unassigned,
        command("reassign", customerA, 2)
      )
    ).toThrow(SaleCustomerLinkStateError);
  });

  it("conflicts on a stale expected version before anything else", () => {
    expect(() =>
      planSaleCustomerLinkTransition(
        assignedA,
        command("reassign", customerB, 0)
      )
    ).toThrow(SaleCustomerLinkVersionConflictError);
    expect(() =>
      planSaleCustomerLinkTransition(assignedA, command("assign", customerA, 0))
    ).toThrow(SaleCustomerLinkVersionConflictError);
    expect(() =>
      planSaleCustomerLinkTransition(none, command("assign", customerA, 3))
    ).toThrow(SaleCustomerLinkVersionConflictError);
  });
});

describe("saleCustomerLinkAuditEvent", () => {
  it("names one past-tense event per action", () => {
    expect(saleCustomerLinkAuditEvent("assign")).toBe(
      "sale_customer_link.assigned"
    );
    expect(saleCustomerLinkAuditEvent("reassign")).toBe(
      "sale_customer_link.reassigned"
    );
    expect(saleCustomerLinkAuditEvent("unassign")).toBe(
      "sale_customer_link.unassigned"
    );
  });
});
