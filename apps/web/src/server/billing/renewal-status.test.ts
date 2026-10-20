import { describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../environment";
import { createRenewalStatusReader } from "./renewal-status";

const bindings = {
  BILLING_HYPERDRIVE: { connectionString: "postgresql://billing.invalid/db" },
} as unknown as WorkerBindings;

const records: Record<
  string,
  { link: { provider: string } | null; record: unknown }
> = {
  alive: {
    link: { provider: "asaas" },
    record: { cancelAtPeriodEnd: false, state: "active" },
  },
  cancelled: {
    link: { provider: "asaas" },
    record: { cancelAtPeriodEnd: true, state: "active" },
  },
  free: { link: null, record: { cancelAtPeriodEnd: false, state: "free" } },
  woovi: {
    link: { provider: "woovi" },
    record: { cancelAtPeriodEnd: false, state: "active" },
  },
};

function fakeStore() {
  return {
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
      "free",
      "woovi",
      "missing",
    ]);

    expect(createStore).toHaveBeenCalledWith("postgresql://billing.invalid/db");
    expect(Object.fromEntries(statuses)).toEqual({
      alive: "pending",
      cancelled: "cancelled",
      free: "not_handled",
      missing: "not_handled",
      woovi: "not_handled",
    });
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it("says not_handled without the billing role, and opens nothing", async () => {
    const createStore = vi.fn();
    const read = createRenewalStatusReader(createStore as never);

    const statuses = await read({} as WorkerBindings, ["alive"]);

    expect(statuses.get("alive")).toBe("not_handled");
    expect(createStore).not.toHaveBeenCalled();
  });

  it("opens nothing for no organization, and closes the connection when a read fails", async () => {
    const store = fakeStore();
    store.readRecord.mockRejectedValue(new Error("billing_down"));
    const createStore = vi.fn(() => store);
    const read = createRenewalStatusReader(createStore as never);

    await expect(read(bindings, [])).resolves.toEqual(new Map());
    expect(createStore).not.toHaveBeenCalled();
    await expect(read(bindings, ["alive"])).rejects.toThrow("billing_down");
    expect(store.close).toHaveBeenCalledTimes(1);
  });
});
