import {
  BillingCommandInProgressError,
  type BillingStore,
} from "@polaris/db/billing-store";
import { logger } from "@polaris/observability/logger";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  cancelRenewal,
  cancelRenewalEventId,
  operatorCancelRenewal,
  refundCancelEventId,
  refundCurrentPeriod,
} from "./operator-commands";
import {
  type BillingProviderPort,
  type RefundOptions,
  ProviderNotConfiguredError,
  ProviderUnavailableError,
} from "./provider-port";

const CANCEL_RENEWAL_EVENT_ID = /^command:cancel_renewal:req-42:[0-9a-f]{32}$/;
const REFUND_CANCEL_EVENT_ID = /^command:refund_cancel:req-42:[0-9a-f]{32}$/;

const now = new Date("2026-10-14T12:00:00.000Z");
const organizationId = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const commandId = "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2d";
const link = {
  provider: "asaas",
  providerRef: "link-ref-0001",
  providerSubscriptionId: "sub_link0001",
};
const decision = {
  actor: "admin:principal-1",
  reason: "Cliente pediu por e-mail",
};

type Mocked<T> = T & { [K in keyof T]: T[K] & Mock };

/** A provider whose refund finds a paid charge of 24.90, runs the hook on it, then refunds it. */
function refundingCharge(
  answer: "refund_requested" = "refund_requested",
  amount = "24.90"
) {
  return vi.fn(
    async (
      _providerRef: string,
      _now: Date,
      _subscriptionId: string | null,
      _charge: unknown,
      options?: RefundOptions
    ) => {
      await options?.beforeRefund?.({ amount });
      return answer;
    }
  );
}

function fakePort(overrides: Partial<BillingProviderPort> = {}) {
  const port = {
    cancelRenewal: vi.fn(() => Promise.resolve("cancelled" as const)),
    discardCheckout: vi.fn(() => Promise.resolve("discarded" as const)),
    hasSubscription: vi.fn(() => Promise.resolve(false)),
    provider: "asaas" as const,
    readState: vi.fn(() => Promise.resolve([])),
    refundCurrentPeriod: refundingCharge(),
    refundsEnabled: true,
    ...overrides,
  };
  return port as unknown as Mocked<BillingProviderPort>;
}

function fakeStore(overrides: Record<string, unknown> = {}) {
  return {
    processEvent: vi.fn(() =>
      Promise.resolve({
        eventId: "e",
        organizationId,
        outcomeCode: null,
        status: "applied",
      })
    ),
    readProviderLink: vi.fn(() => Promise.resolve(link)),
    readRecord: vi.fn(() => Promise.resolve(null)),
    recordEvent: vi.fn(() => Promise.resolve({ duplicate: false, id: "ev-1" })),
    recordOperatorDecision: vi.fn(() => Promise.resolve()),
    withOrganizationLock: vi.fn(
      (_organizationId: string, operation: () => Promise<unknown>) =>
        operation()
    ),
    ...overrides,
  } as unknown as Mocked<BillingStore>;
}

describe("refundCurrentPeriod", () => {
  const request = { organizationId, requestId: "req-refund-1" };
  const active = { cancelAtPeriodEnd: false, state: "active" };

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("is not_linked without a link", async () => {
    const port = fakePort();
    const store = fakeStore({
      readProviderLink: vi.fn(() => Promise.resolve(null)),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("not_linked");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(port.refundCurrentPeriod).not.toHaveBeenCalled();
  });

  it.each(["refund_requested", "nothing_to_refund"] as const)(
    "asks the provider about the linked subscription and returns %s",
    async (answer) => {
      const port = fakePort({
        refundCurrentPeriod:
          answer === "refund_requested"
            ? refundingCharge()
            : vi.fn(() => Promise.resolve(answer)),
      });

      await expect(
        refundCurrentPeriod(
          { now: () => now, portFor: () => port, store: fakeStore() },
          request
        )
      ).resolves.toBe(answer);
      // the operator's refund: the paid charge in force, whichever it is
      expect(port.refundCurrentPeriod).toHaveBeenCalledWith(
        link.providerRef,
        now,
        link.providerSubscriptionId,
        "any_paid",
        { beforeRefund: expect.any(Function) }
      );
    }
  );

  it("cancels the renewal and writes it before it refunds", async () => {
    const calls: string[] = [];
    const port = fakePort({
      cancelRenewal: vi.fn(() => {
        calls.push("cancel");
        return Promise.resolve("cancelled" as const);
      }),
      refundCurrentPeriod: vi.fn(
        async (
          _providerRef: string,
          _now: Date,
          _subscriptionId: string | null,
          _charge: unknown,
          options?: RefundOptions
        ) => {
          calls.push("read charge");
          await options?.beforeRefund?.({ amount: "24.90" });
          calls.push("refund");
          return "refund_requested" as const;
        }
      ),
    });
    const store = fakeStore({
      processEvent: vi.fn(() => {
        calls.push("process");
        return Promise.resolve({ status: "applied" });
      }),
      readRecord: vi.fn(() => Promise.resolve(active)),
      recordEvent: vi.fn(() => {
        calls.push("record");
        return Promise.resolve({ duplicate: false, id: "ev-cancel" });
      }),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("refund_requested");

    expect(calls).toEqual([
      "read charge",
      "cancel",
      "record",
      "process",
      "refund",
    ]);
    expect(port.cancelRenewal).toHaveBeenCalledWith(
      link.providerRef,
      link.providerSubscriptionId
    );
    expect(store.recordEvent).toHaveBeenCalledWith({
      fact: { occurredAt: now, type: "subscription_cancelled" },
      organizationId,
      provider: "asaas",
      providerEventId: await refundCancelEventId(
        request.requestId,
        link.providerRef
      ),
      providerRef: link.providerRef,
    });
    expect(store.processEvent).toHaveBeenCalledWith("ev-cancel", now);
  });

  it("refunds nothing when the cancellation fails", async () => {
    const refunded: string[] = [];
    const port = fakePort({
      cancelRenewal: vi.fn(() =>
        Promise.reject(new ProviderUnavailableError())
      ),
      refundCurrentPeriod: vi.fn(
        async (
          _providerRef: string,
          _now: Date,
          _subscriptionId: string | null,
          _charge: unknown,
          options?: RefundOptions
        ) => {
          await options?.beforeRefund?.({ amount: "24.90" });
          refunded.push("refund");
          return "refund_requested" as const;
        }
      ),
    });
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(refunded).toEqual([]);
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("does not cancel again a renewal the record already shows cancelled", async () => {
    const port = fakePort();
    const store = fakeStore({
      readRecord: vi.fn(() =>
        Promise.resolve({ cancelAtPeriodEnd: true, state: "active" })
      ),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("refund_requested");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
    expect(port.refundCurrentPeriod).toHaveBeenCalledTimes(1);
  });

  it("cancel ok, refund fails, a repeat with another request ID: one cancellation and one refund", async () => {
    // the record as the inbox leaves it: the cancellation fact applied sets cancelAtPeriodEnd
    const record = { ...active };
    const cancellations: string[] = [];
    const store = fakeStore({
      processEvent: vi.fn(() => {
        record.cancelAtPeriodEnd = true;
        return Promise.resolve({ status: "applied" });
      }),
      readRecord: vi.fn(() => Promise.resolve({ ...record })),
      recordEvent: vi.fn((event: { providerEventId: string }) => {
        cancellations.push(event.providerEventId);
        return Promise.resolve({ duplicate: false, id: "ev-cancel" });
      }),
    });
    const refund = refundingCharge();
    const port = fakePort({
      refundCurrentPeriod: vi.fn(async (...args: Parameters<typeof refund>) => {
        await refund(...args);
        if (refund.mock.calls.length === 1) {
          throw new ProviderUnavailableError();
        }
        return "refund_requested" as const;
      }),
    });
    const dependencies = { now: () => now, portFor: () => port, store };

    await expect(
      refundCurrentPeriod(dependencies, request)
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(
      refundCurrentPeriod(dependencies, {
        organizationId,
        requestId: "req-refund-2",
      })
    ).resolves.toBe("refund_requested");

    expect(port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(cancellations).toEqual([
      await refundCancelEventId(request.requestId, link.providerRef),
    ]);
    expect(port.refundCurrentPeriod).toHaveBeenCalledTimes(2);
  });

  it("still cancels at the provider when the record no longer gives Pro, without writing a fact it would ignore", async () => {
    const port = fakePort({
      cancelRenewal: vi.fn(() => Promise.resolve("already_cancelled" as const)),
    });
    const store = fakeStore({
      readRecord: vi.fn(() =>
        Promise.resolve({ cancelAtPeriodEnd: false, state: "free" })
      ),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("refund_requested");
    expect(port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it.each(["trialing", "grace"])(
    "writes the cancellation of a record in %s (it gives Pro)",
    async (state) => {
      const store = fakeStore({
        readRecord: vi.fn(() =>
          Promise.resolve({ cancelAtPeriodEnd: false, state })
        ),
      });

      await refundCurrentPeriod(
        { now: () => now, portFor: () => fakePort(), store },
        request
      );
      expect(store.recordEvent).toHaveBeenCalledTimes(1);
    }
  );

  it("still cancels at the provider without a record, and writes nothing", async () => {
    const port = fakePort();
    const store = fakeStore();

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("refund_requested");
    expect(port.cancelRenewal).toHaveBeenCalledTimes(1);
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("writes the cancellation when the provider had it cancelled but the record did not", async () => {
    const port = fakePort({
      cancelRenewal: vi.fn(() => Promise.resolve("already_cancelled" as const)),
    });
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
    });

    await refundCurrentPeriod(
      { now: () => now, portFor: () => port, store },
      request
    );
    expect(store.recordEvent).toHaveBeenCalledTimes(1);
  });

  it("touches nothing at a provider that cannot refund here (Woovi before S3.2)", async () => {
    const port = fakePort({ refundsEnabled: false });
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).resolves.toBe("refund_not_supported");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(port.refundCurrentPeriod).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("runs under the organization's lock, and a lock held elsewhere does nothing", async () => {
    const port = fakePort();
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
      withOrganizationLock: vi.fn(() =>
        Promise.reject(new BillingCommandInProgressError())
      ),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        request
      )
    ).rejects.toBeInstanceOf(BillingCommandInProgressError);
    expect(store.withOrganizationLock).toHaveBeenCalledWith(
      organizationId,
      expect.any(Function)
    );
    expect(store.readProviderLink).not.toHaveBeenCalled();
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(port.refundCurrentPeriod).not.toHaveBeenCalled();
  });

  it("names the cancellation apart from the owner's, one per request and subscription", async () => {
    const id = await refundCancelEventId("req-42", link.providerRef);
    expect(id).toMatch(REFUND_CANCEL_EVENT_ID);
    expect(id).not.toBe(await cancelRenewalEventId("req-42", link.providerRef));
    expect(await refundCancelEventId("req-42", "another-ref")).not.toBe(id);
  });

  describe("when the port returns the refund's own fact (Woovi)", () => {
    const refundEvent = {
      fact: { occurredAt: now, type: "subscription_cancelled" as const },
      providerEventId: "woovi:refund:ref-0001",
      providerRef: "woovi-sub-ref-0001",
      providerSubscriptionId: "woovi-sub-0001",
    };
    const wooviLink = {
      provider: "woovi",
      providerRef: "woovi-sub-ref-0001",
      providerSubscriptionId: "woovi-sub-0001",
    };

    it("writes the fact through the inbox with the organization, processes it, and returns refund_requested", async () => {
      const calls: string[] = [];
      const port = fakePort({
        provider: "woovi" as never,
        refundCurrentPeriod: vi.fn(() =>
          Promise.resolve({
            event: refundEvent,
            kind: "refund_requested" as const,
          })
        ),
      });
      const store = fakeStore({
        processEvent: vi.fn(() => {
          calls.push("process");
          return Promise.resolve({ status: "applied" });
        }),
        readProviderLink: vi.fn(() => Promise.resolve(wooviLink)),
        recordEvent: vi.fn(() => {
          calls.push("record");
          return Promise.resolve({ duplicate: false, id: "ev-refund" });
        }),
      });

      await expect(
        refundCurrentPeriod(
          { now: () => now, portFor: () => port, store },
          request
        )
      ).resolves.toBe("refund_requested");

      expect(store.recordEvent).toHaveBeenCalledWith({
        fact: refundEvent.fact,
        organizationId,
        provider: "woovi",
        providerEventId: "woovi:refund:ref-0001",
        providerRef: "woovi-sub-ref-0001",
        providerSubscriptionId: "woovi-sub-0001",
      });
      expect(store.processEvent).toHaveBeenCalledWith("ev-refund", now);
      expect(calls).toEqual(["record", "process"]);
    });

    it("writes nothing when the port answers with a string (the older behavior)", async () => {
      const store = fakeStore();

      await refundCurrentPeriod(
        { now: () => now, portFor: () => fakePort(), store },
        request
      );

      expect(store.recordEvent).not.toHaveBeenCalled();
      expect(store.processEvent).not.toHaveBeenCalled();
    });
  });
});

describe("cancelRenewal", () => {
  const request = { organizationId, requestId: "req-42" };

  it("is not_linked without a link", async () => {
    const port = fakePort();
    const store = fakeStore({
      readProviderLink: vi.fn(() => Promise.resolve(null)),
    });

    await expect(
      cancelRenewal({ now: () => now, portFor: () => port, store }, request)
    ).resolves.toBe("not_linked");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "already_cancelled"] as const)(
    "records the cancellation through the inbox at once and processes it (%s)",
    async (answer) => {
      const port = fakePort({
        cancelRenewal: vi.fn(() => Promise.resolve(answer)),
      });
      const store = fakeStore({
        recordEvent: vi.fn(() =>
          Promise.resolve({ duplicate: false, id: "ev-9" })
        ),
      });

      await expect(
        cancelRenewal({ now: () => now, portFor: () => port, store }, request)
      ).resolves.toBe(answer);

      expect(port.cancelRenewal).toHaveBeenCalledWith(
        link.providerRef,
        link.providerSubscriptionId
      );
      expect(store.recordEvent).toHaveBeenCalledWith({
        fact: { occurredAt: now, type: "subscription_cancelled" },
        organizationId,
        provider: "asaas",
        providerEventId: await cancelRenewalEventId("req-42", link.providerRef),
        providerRef: link.providerRef,
      });
      expect(store.processEvent).toHaveBeenCalledWith("ev-9", now);
    }
  );

  it("names the fact by the request and the subscription, within the length of an event ID", async () => {
    const first = await cancelRenewalEventId("req-42", "pol_a");
    expect(first).toMatch(CANCEL_RENEWAL_EVENT_ID);
    // the same request for the same subscription is the same fact; for another subscription, another
    expect(await cancelRenewalEventId("req-42", "pol_a")).toBe(first);
    expect(await cancelRenewalEventId("req-42", "pol_b")).not.toBe(first);
    const longest = await cancelRenewalEventId(
      "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2d",
      "r".repeat(128)
    );
    expect(longest.length).toBeLessThanOrEqual(160);
    expect(longest).not.toContain("rrrr");
  });

  it("writes nothing when there was nothing to cancel", async () => {
    const port = fakePort({
      cancelRenewal: vi.fn(() => Promise.resolve("nothing_to_cancel" as const)),
    });
    const store = fakeStore();

    await expect(
      cancelRenewal({ now: () => now, portFor: () => port, store }, request)
    ).resolves.toBe("nothing_to_cancel");

    expect(store.recordEvent).not.toHaveBeenCalled();
    expect(store.processEvent).not.toHaveBeenCalled();
  });
});

describe("refundCurrentPeriod, the operator's order (read, check the amount, cancel, refund that charge)", () => {
  const active = { cancelAtPeriodEnd: false, state: "active" };

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("answers amount_changed when the charge holds another amount, and cancels, refunds and writes nothing", async () => {
    const port = fakePort({ refundCurrentPeriod: refundingCharge() });
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        {
          decision,
          expectedAmount: "19.90",
          organizationId,
          requestId: commandId,
        }
      )
    ).resolves.toBe("amount_changed");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(store.recordOperatorDecision).not.toHaveBeenCalled();
    expect(store.recordEvent).not.toHaveBeenCalled();
  });

  it("compares amounts as money, not as text", async () => {
    const port = fakePort({ refundCurrentPeriod: refundingCharge() });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store: fakeStore() },
        { expectedAmount: "24.9", organizationId, requestId: commandId }
      )
    ).resolves.toBe("refund_requested");
  });

  it.each(["0.00", "-1.00", "abc", "24.901"])(
    "refuses the expected amount %j before the lock is taken",
    async (expectedAmount) => {
      const store = fakeStore();

      await expect(
        refundCurrentPeriod(
          { now: () => now, portFor: () => fakePort(), store },
          { expectedAmount, organizationId, requestId: commandId }
        )
      ).rejects.toThrow();
      expect(store.withOrganizationLock).not.toHaveBeenCalled();
    }
  );

  it("writes the decision after the amount matched and before the renewal is cancelled", async () => {
    const calls: string[] = [];
    const port = fakePort({
      cancelRenewal: vi.fn(() => {
        calls.push("cancel");
        return Promise.resolve("cancelled" as const);
      }),
    });
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
      recordOperatorDecision: vi.fn(() => {
        calls.push("decision");
        return Promise.resolve();
      }),
    });

    await refundCurrentPeriod(
      { now: () => now, portFor: () => port, store },
      {
        decision,
        expectedAmount: "24.90",
        organizationId,
        requestId: commandId,
      }
    );

    expect(calls).toEqual(["decision", "cancel"]);
    expect(store.recordOperatorDecision).toHaveBeenCalledWith(
      { ...decision, commandId, kind: "refund", organizationId },
      now
    );
  });

  it("cancels nothing and writes no decision when there is nothing to refund (already refunded or being refunded)", async () => {
    const port = fakePort({
      refundCurrentPeriod: vi.fn(() =>
        Promise.resolve("nothing_to_refund" as const)
      ),
    });
    const store = fakeStore({
      readRecord: vi.fn(() => Promise.resolve(active)),
    });

    await expect(
      refundCurrentPeriod(
        { now: () => now, portFor: () => port, store },
        {
          decision,
          expectedAmount: "24.90",
          organizationId,
          requestId: commandId,
        }
      )
    ).resolves.toBe("nothing_to_refund");
    expect(port.cancelRenewal).not.toHaveBeenCalled();
    expect(store.recordOperatorDecision).not.toHaveBeenCalled();
  });

  it("logs the operator's command for the alert, with codes and an opaque ID only", async () => {
    const warn = vi.spyOn(logger, "warn");

    await refundCurrentPeriod(
      { now: () => now, portFor: () => fakePort(), store: fakeStore() },
      {
        decision,
        expectedAmount: "24.90",
        organizationId,
        requestId: commandId,
      }
    );

    const call = warn.mock.calls.find(
      ([event]) => event === "billing_operator_command"
    );
    expect(call?.[1]).toMatchObject({
      operation: "billing.refund",
      provider: "asaas",
      reason: "refund_requested",
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(link.providerRef);
    expect(logged).not.toContain(decision.reason);
    expect(logged).not.toContain("24.90");
  });
});

describe("operatorCancelRenewal", () => {
  const input = { commandId, decision, organizationId };

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("takes the lock, writes the decision, then cancels at the provider under the command ID", async () => {
    const calls: string[] = [];
    const port = fakePort({
      cancelRenewal: vi.fn(() => {
        calls.push("cancel");
        return Promise.resolve("cancelled" as const);
      }),
    });
    const store = fakeStore({
      recordOperatorDecision: vi.fn(() => {
        calls.push("decision");
        return Promise.resolve();
      }),
    });

    await expect(
      operatorCancelRenewal(
        { now: () => now, portFor: () => port, store },
        input
      )
    ).resolves.toBe("cancelled");
    expect(store.withOrganizationLock).toHaveBeenCalledWith(
      organizationId,
      expect.any(Function)
    );
    expect(calls).toEqual(["decision", "cancel"]);
    expect(store.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: await cancelRenewalEventId(
          commandId,
          link.providerRef
        ),
      })
    );
  });

  it("is command_in_progress, touching nothing, while another command holds the lock", async () => {
    const port = fakePort();
    const store = fakeStore({
      withOrganizationLock: vi.fn(() =>
        Promise.reject(new BillingCommandInProgressError())
      ),
    });

    await expect(
      operatorCancelRenewal(
        { now: () => now, portFor: () => port, store },
        input
      )
    ).rejects.toBeInstanceOf(BillingCommandInProgressError);
    expect(store.recordOperatorDecision).not.toHaveBeenCalled();
    expect(port.cancelRenewal).not.toHaveBeenCalled();
  });

  it("writes nothing when the store has no link, or the provider cannot be reached from here", async () => {
    const unlinked = fakeStore({
      readProviderLink: vi.fn(() => Promise.resolve(null)),
    });
    await expect(
      operatorCancelRenewal(
        { now: () => now, portFor: () => fakePort(), store: unlinked },
        input
      )
    ).resolves.toBe("not_linked");
    expect(unlinked.recordOperatorDecision).not.toHaveBeenCalled();

    const store = fakeStore();
    await expect(
      operatorCancelRenewal(
        {
          now: () => now,
          portFor: () => {
            throw new ProviderNotConfiguredError();
          },
          store,
        },
        input
      )
    ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(store.recordOperatorDecision).not.toHaveBeenCalled();
  });

  it("a repeat with the same command ID is the same cancellation fact", async () => {
    const ids: string[] = [];
    const store = fakeStore({
      recordEvent: vi.fn((event: { providerEventId: string }) => {
        ids.push(event.providerEventId);
        return Promise.resolve({ duplicate: ids.length > 1, id: "ev" });
      }),
    });
    const port = fakePort({
      cancelRenewal: vi
        .fn()
        .mockResolvedValueOnce("cancelled")
        .mockResolvedValueOnce("already_cancelled"),
    });
    const dependencies = { now: () => now, portFor: () => port, store };

    await operatorCancelRenewal(dependencies, input);
    await expect(operatorCancelRenewal(dependencies, input)).resolves.toBe(
      "already_cancelled"
    );
    expect(new Set(ids).size).toBe(1);
  });
});
