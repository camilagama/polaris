import { describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../environment";
import { createRenewalStatusReader } from "./renewal-status";

const bindings = {
  BILLING_HYPERDRIVE: { connectionString: "postgresql://billing.invalid/db" },
} as unknown as WorkerBindings;

const subscribed = {
  provider: "asaas",
  providerRef: "pol_1",
  providerSubscriptionId: "sub_1",
};
const checkout = {
  provider: "asaas",
  providerRef: "pol_2",
  providerSubscriptionId: null,
};

const records: Record<
  string,
  {
    link: {
      provider: string;
      providerRef: string;
      providerSubscriptionId: string | null;
    } | null;
    record: unknown;
  }
> = {
  alive: {
    link: subscribed,
    record: { cancelAtPeriodEnd: false, state: "active" },
  },
  cancelled: {
    link: subscribed,
    record: { cancelAtPeriodEnd: true, state: "active" },
  },
  // the closure gave this checkout up (the ledger has it)
  discarded: {
    link: { ...checkout, providerRef: "pol_3" },
    record: { cancelAtPeriodEnd: false, state: "free" },
  },
  free: { link: null, record: { cancelAtPeriodEnd: false, state: "free" } },
  // a checkout linked before the closure and not paid, not given up yet
  openCheckout: {
    link: checkout,
    record: { cancelAtPeriodEnd: false, state: "free" },
  },
  woovi: {
    link: { ...subscribed, provider: "woovi" },
    record: { cancelAtPeriodEnd: false, state: "active" },
  },
};

function fakeStore() {
  return {
    checkoutDiscarded: vi.fn((_id: string, link: { providerRef: string }) =>
      Promise.resolve(link.providerRef === "pol_3")
    ),
    close: vi.fn(() => Promise.resolve()),
    readProviderLink: vi.fn((id: string) =>
      Promise.resolve(records[id]?.link ?? null)
    ),
    readRecord: vi.fn((id: string) =>
      Promise.resolve(records[id]?.record ?? null)
    ),
  };
}

describe("the renewal status of closed organizations", () => {
  it("derives each one from its billing record, on the billing role, and closes the connection", async () => {
    const store = fakeStore();
    const createStore = vi.fn(() => store);
    const read = createRenewalStatusReader(createStore as never);

    const statuses = await read(bindings, [
      "alive",
      "cancelled",
      "discarded",
      "free",
      "openCheckout",
      "woovi",
      "missing",
    ]);

    expect(createStore).toHaveBeenCalledWith("postgresql://billing.invalid/db");
    expect(Object.fromEntries(statuses)).toEqual({
      alive: "pending",
      cancelled: "cancelled",
      discarded: "cancelled",
      free: "not_handled",
      missing: "not_handled",
      openCheckout: "pending",
      woovi: "not_handled",
    });
    // the ledger is read only for a checkout that could still be open
    expect(store.checkoutDiscarded).toHaveBeenCalledTimes(2);
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it("says not_handled without the billing role, and opens nothing", async () => {
    const createStore = vi.fn();
    const read = createRenewalStatusReader(createStore as never);

    const statuses = await read({} as WorkerBindings, ["alive"]);

    expect(statuses.get("alive")).toBe("not_handled");
    expect(createStore).not.toHaveBeenCalled();
  });

  it("opens nothing for no organization", async () => {
    const createStore = vi.fn();
    const read = createRenewalStatusReader(createStore as never);

    await expect(read(bindings, [])).resolves.toEqual(new Map());
    expect(createStore).not.toHaveBeenCalled();
  });

  it("says unknown (null), never a guess, when the record cannot be read, and closes the connection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = fakeStore();
    store.readRecord.mockRejectedValue(new Error("billing_down"));
    const read = createRenewalStatusReader((() => store) as never);

    const statuses = await read(bindings, ["alive", "cancelled"]);

    expect(Object.fromEntries(statuses)).toEqual({
      alive: null,
      cancelled: null,
    });
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "billing_renewal_status_unavailable" })
    );
    warn.mockRestore();
  });

  it("says unknown when the billing connection cannot even open", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const read = createRenewalStatusReader((() => {
      throw new Error("bad_url");
    }) as never);

    await expect(read(bindings, ["alive"])).resolves.toEqual(
      new Map([["alive", null]])
    );
    vi.restoreAllMocks();
  });
});
