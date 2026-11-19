import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class {
    on() {
      return this;
    }
    query = mocks.query;
    end() {
      return Promise.resolve();
    }
  },
}));

const { createBillingStore } = await import("./billing-store");

const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const userId = "user-1";

const noRecord = {
  access_ends_at: null,
  cancel_at_period_end: null,
  current_charge_amount: null,
  cycle_months: null,
  first_charge_amount: null,
  first_charge_at: null,
  first_charge_on: null,
  has_record: false,
  pending_cycle_months: null,
  price_amount: null,
  provider: null,
  refund_requested_at: null,
  revoked_reason: null,
  revoked_through: null,
  state: null,
  trial_started_at: null,
};

const trialing = {
  ...noRecord,
  cancel_at_period_end: false,
  has_record: true,
  state: "trialing",
};

function answer(row: Record<string, unknown>) {
  mocks.query.mockResolvedValue({ rows: [row] });
}

describe("readOwnerPlan: the record and the person's trial in one statement", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("asks once, keyed by the organization and the user it was given", async () => {
    answer({ ...trialing, claim_consumed_at: null });
    const store = createBillingStore("postgres://gate:secret@127.0.0.1:1/none");

    await store.readOwnerPlan(organizationId, userId);

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([organizationId, userId]);
    await store.close();
  });

  it("reads Free with no trial left for a store with no record whose person already consumed the claim", async () => {
    answer({
      ...noRecord,
      claim_consumed_at: new Date("2026-10-01T00:00:00Z"),
    });
    const store = createBillingStore("postgres://gate:secret@127.0.0.1:1/none");

    const plan = await store.readOwnerPlan(organizationId, userId);

    expect(plan.state).toBe("free");
    expect(plan.trialAvailable).toBe(false);
    await store.close();
  });

  it("reads Free with the trial still available for a store with no record and no consumed claim", async () => {
    answer({ ...noRecord, claim_consumed_at: null });
    const store = createBillingStore("postgres://gate:secret@127.0.0.1:1/none");

    const plan = await store.readOwnerPlan(organizationId, userId);

    expect(plan.state).toBe("free");
    expect(plan.trialAvailable).toBe(true);
    await store.close();
  });

  it("reads a record's own state, and the consumed claim still takes the trial away", async () => {
    answer({
      ...trialing,
      claim_consumed_at: new Date("2026-10-01T00:00:00Z"),
    });
    const store = createBillingStore("postgres://gate:secret@127.0.0.1:1/none");

    const plan = await store.readOwnerPlan(organizationId, userId);

    expect(plan.state).toBe("trialing");
    expect(plan.trialAvailable).toBe(false);
    await store.close();
  });
});
