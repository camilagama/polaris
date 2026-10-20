import { polarisContract } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES,
  LEGAL_ACCEPTANCE_EXEMPT_ROUTES,
} from "../legal-acceptance";

/**
 * Every procedure of the contract has a decision about the legal acceptance control (ADR 0100,
 * section 6): exempt (the constant in `legal-acceptance.ts`), controlled (the list below) or not
 * authenticated at all. A new procedure with no decision breaks this test on purpose: whoever adds
 * it has to choose, and the default of the choice is "controlled".
 */
const CONTROLLED = [
  "billing.startCheckout",
  "category.archive",
  "category.create",
  "category.delete",
  "category.list",
  "category.rename",
  "category.restore",
  "customer.anonymizeForPrivacy",
  "customer.archive",
  "customer.create",
  "customer.findPossibleDuplicates",
  "customer.list",
  "customer.restore",
  "customer.update",
  "device.check",
  "device.register",
  "device.revoke",
  "expense.archiveCategory",
  "expense.archiveRule",
  "expense.create",
  "expense.createCategory",
  "expense.createRule",
  "expense.list",
  "expense.listCategories",
  "expense.listRules",
  "expense.renameCategory",
  "expense.restore",
  "expense.restoreCategory",
  "expense.restoreRule",
  "expense.update",
  "expense.updateRule",
  "expense.void",
  "goal.cancel",
  "goal.create",
  "goal.list",
  "goal.targetChanges",
  "goal.update",
  "inventory.getBalance",
  "inventory.inventoryCount",
  "inventory.listBalances",
  "inventory.receiveStock",
  "inventory.writeOffStock",
  "offline.issueLease",
  "organization.closedStatus",
  "organization.createInitial",
  "organization.listClosed",
  "organization.listClosing",
  "organization.listMine",
  "organization.recoverClosure",
  "organization.requestClosure",
  "paymentProfile.archive",
  "paymentProfile.create",
  "paymentProfile.list",
  "paymentProfile.restore",
  "paymentProfile.update",
  "plan.operationalSelection",
  "plan.selectOperationalVariants",
  "product.archive",
  "product.configureVariants",
  "product.create",
  "product.delete",
  "product.getVariants",
  "product.list",
  "product.restore",
  "product.setVariantListPrice",
  "product.setVariantSku",
  "product.update",
  "publicCatalog.publishProducts",
  "publicCatalog.saveProfile",
  "publicCatalog.setPublished",
  "publicCatalog.setup",
  "publicCatalog.unpublishProducts",
  "report.periodSummary",
  "sale.assignCustomer",
  "sale.cancel",
  "sale.confirm",
  "sale.get",
  "sale.getCustomerLink",
  "sale.list",
  "sale.reassignCustomer",
  "sale.return",
  "sale.unassignCustomer",
  "sync.bootstrapPage",
  "sync.getCursor",
  "sync.pull",
  "sync.push",
] as const;

/** Never asks for a session, so there is nothing to control (the handler does not open the request context). */
const UNAUTHENTICATED = ["system.ping"] as const;

const READ_SEGMENT = /^(list|get)/;
const OPEN_CATEGORIES = new Set(["acceptance", "privacy_request"]);

/** The leaves of the contract (the oRPC procedures), as dotted names. */
function contractProcedures(
  node: unknown = polarisContract,
  path: string[] = []
): string[] {
  if (typeof node !== "object" || node === null) {
    return [];
  }
  if ("~orpc" in node) {
    return [path.join(".")];
  }
  return Object.entries(node).flatMap(([key, child]) =>
    contractProcedures(child, [...path, key])
  );
}

const procedures = contractProcedures().sort();
const exempt = Object.entries(LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES);
const lastSegment = (name: string) => name.split(".").at(-1) ?? "";

describe("the contract walk", () => {
  it("finds the procedures of the contract (and not the groups)", () => {
    expect(procedures.length).toBeGreaterThan(50);
    expect(procedures).toContain("sale.list");
    expect(procedures).toContain("account.acceptLegal");
    expect(procedures).not.toContain("sale");
    expect(procedures).not.toContain("account");
  });
});

describe("the exempt procedures of the legal acceptance control", () => {
  it.each(exempt)("%s (%s) exists in the contract", (name) => {
    expect(procedures).toContain(name);
  });

  it.each(exempt)("%s (%s) is neither sync nor offline", (name) => {
    expect(name.startsWith("sync.")).toBe(false);
    expect(name.startsWith("offline.")).toBe(false);
  });

  it.each(exempt.filter(([, category]) => !OPEN_CATEGORIES.has(category)))(
    "%s (%s) is a read",
    (name) => {
      expect(lastSegment(name)).toMatch(READ_SEGMENT);
    }
  );

  it("outside the acceptance itself, only the requests of the data subject are exempt without being a read", () => {
    const writes = exempt
      .filter(([name]) => !READ_SEGMENT.test(lastSegment(name)))
      .map(([name]) => name)
      .sort();
    expect(writes).toEqual([
      "account.acceptLegal",
      "account.legalStatus",
      "dataExport.request",
      "dataExport.requestClosed",
    ]);
  });

  it("is exactly the decided list", () => {
    expect(Object.keys(LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES).sort()).toEqual([
      "account.acceptLegal",
      "account.legalStatus",
      "dataExport.list",
      "dataExport.listClosed",
      "dataExport.request",
      "dataExport.requestClosed",
      "device.list",
    ]);
  });
});

describe("the controlled procedures", () => {
  it("lists only procedures that exist in the contract", () => {
    for (const name of [...CONTROLLED, ...UNAUTHENTICATED]) {
      expect(procedures, name).toContain(name);
    }
  });

  it("has no procedure that is both exempt and controlled", () => {
    for (const name of CONTROLLED) {
      expect(
        Object.hasOwn(LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES, name),
        name
      ).toBe(false);
    }
  });

  it("covers every procedure of the contract: a new one needs a decision", () => {
    const decided = new Set<string>([
      ...Object.keys(LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES),
      ...CONTROLLED,
      ...UNAUTHENTICATED,
    ]);
    expect(procedures.filter((name) => !decided.has(name))).toEqual([]);
  });

  it("keeps the CONTROLLED list sorted and without duplicates", () => {
    expect([...CONTROLLED]).toEqual([...new Set(CONTROLLED)].sort());
  });

  it.each([
    "sync.push",
    "sync.pull",
    "sync.bootstrapPage",
    "offline.issueLease",
    "device.register",
    "device.check",
    "device.revoke",
    "organization.requestClosure",
  ])("%s is controlled", (name) => {
    expect(CONTROLLED).toContain(name);
    expect(Object.hasOwn(LEGAL_ACCEPTANCE_EXEMPT_PROCEDURES, name)).toBe(false);
  });
});

describe("the exempt /api routes", () => {
  it("are only the download of the copies of the data", () => {
    expect(Object.keys(LEGAL_ACCEPTANCE_EXEMPT_ROUTES).sort()).toEqual([
      "/api/closed-exports/:exportId/files/:ordinal",
      "/api/data-exports/:exportId/files/:ordinal",
    ]);
  });
});
