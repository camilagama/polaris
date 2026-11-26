import { INITIAL_PLAN_CATALOG } from "@polaris/domain/billing/entitlements";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantRequestTransaction } from "./tenant-transaction";

const mocks = vi.hoisted(() => ({
  countActiveGoals: vi.fn(),
  countActiveImages: vi.fn(),
  countFreeableArchivedProducts: vi.fn(),
  countOrganizationVariants: vi.fn(),
  listBillingPrices: vi.fn(),
  readDatabaseNow: vi.fn(),
  readPlanCatalog: vi.fn(),
  resolveEffectiveEntitlements: vi.fn(),
}));

vi.mock("./billing-repository", () => ({
  listBillingPrices: mocks.listBillingPrices,
  readDatabaseNow: mocks.readDatabaseNow,
  readPlanCatalog: mocks.readPlanCatalog,
  resolveEffectiveEntitlements: mocks.resolveEffectiveEntitlements,
}));
vi.mock("./goal-repository", () => ({
  countActiveGoals: mocks.countActiveGoals,
}));
vi.mock("./media-repository", () => ({
  countActiveImages: mocks.countActiveImages,
}));
vi.mock("./product-repository", () => ({
  countFreeableArchivedProducts: mocks.countFreeableArchivedProducts,
  countOrganizationVariants: mocks.countOrganizationVariants,
}));

const { readOwnerPlanTenantFacts } = await import("./plan-read-repository");

/** Every query builder call answers the same single row, whatever the table. */
function fakeTransaction(): TenantRequestTransaction {
  const row = { firstOn: null, timezone: "America/Sao_Paulo", total: 0 };
  const query: Promise<unknown[]> = Promise.resolve([row]);
  const builder = Object.assign(query, {
    from: () => builder,
    select: () => builder,
    where: () => builder,
  });
  return builder as unknown as TenantRequestTransaction;
}

const scope = { organizationId: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0" };
const now = new Date("2026-11-15T12:00:00.000Z");
const databaseClock = new Date("2026-11-15T15:30:00.000Z");

describe("readOwnerPlanTenantFacts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listBillingPrices.mockResolvedValue([]);
    mocks.readPlanCatalog.mockResolvedValue(INITIAL_PLAN_CATALOG);
    mocks.readDatabaseNow.mockResolvedValue(databaseClock);
    mocks.resolveEffectiveEntitlements.mockResolvedValue({ values: {} });
    mocks.countActiveGoals.mockResolvedValue(1);
    mocks.countActiveImages.mockResolvedValue(2);
    mocks.countOrganizationVariants.mockResolvedValue(3);
    mocks.countFreeableArchivedProducts.mockResolvedValue({
      products: 4,
      variants: 5,
    });
  });

  it("reads the plan catalog once and hands that very catalog to the effective entitlements and the Pro limits", async () => {
    const facts = await readOwnerPlanTenantFacts(fakeTransaction(), scope, now);

    expect(mocks.readPlanCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.resolveEffectiveEntitlements).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      INITIAL_PLAN_CATALOG,
      databaseClock
    );
    expect(facts.proEntitlements).toBe(INITIAL_PLAN_CATALOG.pro);
  });

  it("reads the database clock once and hands that reading, not the caller's now, to the effective entitlements", async () => {
    await readOwnerPlanTenantFacts(fakeTransaction(), scope, now);

    expect(mocks.readDatabaseNow).toHaveBeenCalledTimes(1);
    expect(mocks.resolveEffectiveEntitlements.mock.calls[0]?.[3]).toBe(
      databaseClock
    );
  });

  it("reads the database clock once also when the caller gives no now: the same reading dates the entitlements and the history", async () => {
    await readOwnerPlanTenantFacts(fakeTransaction(), scope);

    expect(mocks.readDatabaseNow).toHaveBeenCalledTimes(1);
    expect(mocks.resolveEffectiveEntitlements.mock.calls[0]?.[3]).toBe(
      databaseClock
    );
  });

  it("puts what deleting would free into the usage, counted for the server's organization", async () => {
    const facts = await readOwnerPlanTenantFacts(fakeTransaction(), scope, now);

    expect(mocks.countFreeableArchivedProducts).toHaveBeenCalledWith(
      expect.anything(),
      scope.organizationId
    );
    expect(facts.usage).toEqual({
      freeable: { products: 4, variants: 5 },
      goals: 1,
      images: 2,
      variants: 3,
    });
  });
});
