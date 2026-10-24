import { ProviderNotConfiguredError } from "@polaris/billing/provider-port";
import type { RefundedRenewal } from "@polaris/db/billing-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  cancelRenewal: vi.fn(),
  configured: new Set<string>(),
}));

vi.mock("./provider-ports", () => ({
  billingProviderPortOf: (_bindings: unknown, provider: string) => {
    if (!ports.configured.has(provider)) {
      throw new ProviderNotConfiguredError();
    }
    return { cancelRenewal: ports.cancelRenewal, provider };
  },
}));

const { runRefundSafetyNet } = await import("./maintenance");

const now = new Date("2026-10-14T12:00:00.000Z");
const quiet = { exhausted: 0, failed: 0, rearmed: 0, scanned: 0 };

function netStore(rearm = quiet, pending = 0) {
  const calls: string[] = [];
  return {
    calls,
    store: {
      rearmRefundedRenewals: vi.fn(
        (_input: {
          cancel: (renewal: RefundedRenewal) => Promise<string>;
          limit?: number;
          now?: Date;
          providers: readonly string[];
        }) => {
          calls.push("rearm");
          return Promise.resolve(rearm);
        }
      ),
      recordPendingRefundIncidents: vi.fn(() => {
        calls.push("pending");
        return Promise.resolve(pending);
      }),
    },
  };
}

const renewal: RefundedRenewal = {
  attempt: 1,
  organizationId: "0b8f7a8e-5f4c-4c33-9d0e-1d2a3b4c5d6e",
  provider: "asaas",
  providerRef: "chk-1",
  providerSubscriptionId: "sub_1",
  reason: "chargeback",
};

describe("the hourly refund safety net (ADR 0104, decision 6)", () => {
  beforeEach(() => {
    ports.configured.clear();
    ports.cancelRenewal.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tries only the providers configured here, 20 stores a pass, then flags the pending refunds", async () => {
    ports.configured.add("asaas");
    const fixture = netStore(quiet, 2);

    const report = await runRefundSafetyNet({}, fixture.store, now);

    expect(fixture.calls).toEqual(["rearm", "pending"]);
    expect(fixture.store.rearmRefundedRenewals).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, now, providers: ["asaas"] })
    );
    expect(fixture.store.recordPendingRefundIncidents).toHaveBeenCalledWith(
      now
    );
    expect(report).toEqual({
      pendingRefundIncidents: 2,
      providersNotConfigured: ["woovi"],
      rearm: quiet,
    });
  });

  it("cancels at the port of the store's own provider, by the stored subscription", async () => {
    ports.configured.add("asaas");
    ports.configured.add("woovi");
    ports.cancelRenewal.mockResolvedValue("cancelled");
    const fixture = netStore();

    await runRefundSafetyNet({}, fixture.store, now);
    const [input] = fixture.store.rearmRefundedRenewals.mock.calls[0] ?? [];
    await expect(input?.cancel(renewal)).resolves.toBe("cancelled");

    expect(input?.providers).toEqual(["asaas", "woovi"]);
    expect(ports.cancelRenewal).toHaveBeenCalledWith("chk-1", "sub_1");
  });

  it("spends no try where no provider is configured, and still flags the pending refunds", async () => {
    const fixture = netStore(quiet, 1);

    const report = await runRefundSafetyNet({}, fixture.store, now);

    expect(fixture.store.rearmRefundedRenewals).not.toHaveBeenCalled();
    expect(report.pendingRefundIncidents).toBe(1);
    expect(report.providersNotConfigured).toEqual(["asaas", "woovi"]);
  });

  it("makes the run incomplete when a try failed, after flagging the pending refunds", async () => {
    ports.configured.add("asaas");
    const fixture = netStore(
      { exhausted: 1, failed: 2, rearmed: 3, scanned: 5 },
      0
    );

    await expect(runRefundSafetyNet({}, fixture.store, now)).rejects.toThrow(
      "billing_refund_safety_net_incomplete"
    );
    expect(fixture.calls).toEqual(["rearm", "pending"]);
  });
});
