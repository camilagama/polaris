import {
  type BillingFact,
  type BillingRecord,
  reconcileFact,
  serializeBillingFact,
} from "@polaris/domain/billing/facts";
import { describe, expect, it, vi } from "vitest";
import { parseProviderJson } from "../json";
import {
  type ProviderBillingEvent,
  ProviderNotFoundError,
  ProviderUnavailableError,
  type UnresolvedProviderEvent,
} from "../provider-port";
import type { AsaasClient } from "./client";
import {
  confirmationTime,
  pickAsaasPayment,
  pickAsaasSubscription,
  reconcileAsaasSubscription,
} from "./mapper";
import { createAsaasPort } from "./port";
import {
  CHECKOUT_ID,
  EVENT_ID,
  FAKE_CARD_TOKEN,
  FAKE_INVOICE_URL,
  FAKE_PAYER,
  PAYMENT_ID,
  paymentJson,
  SUBSCRIPTION_ID,
  subscriptionJson,
  webhookBody,
} from "./test-fixtures";
import {
  asaasTokenMatches,
  readAsaasWebhook,
  resolveAsaasWebhook,
} from "./webhook";

/** What the API holds: resources by ID, written as JSON text the way the client reads them. */
function fakeApi(
  options: {
    payments?: Record<string, unknown>[];
    subscriptions?: Record<string, unknown>[];
    down?: boolean;
  } = {}
) {
  const payments = options.payments ?? [paymentJson()];
  const subscriptions = options.subscriptions ?? [subscriptionJson()];
  const read = (value: unknown) => parseProviderJson(JSON.stringify(value));
  const calls: string[] = [];
  /** Answers like the client: a rejected promise for a provider that is down or a missing resource. */
  const answer = (call: string, find: () => unknown): Promise<unknown> => {
    calls.push(call);
    if (options.down) {
      return Promise.reject(new ProviderUnavailableError());
    }
    const found = find();
    return found === undefined
      ? Promise.reject(new ProviderNotFoundError())
      : Promise.resolve(found);
  };
  const client: AsaasClient = {
    cancelCheckout: vi.fn(),
    createCheckout: vi.fn(),
    deleteSubscription: vi.fn(),
    getPayment: vi.fn((id: string) =>
      answer(`payment:${id}`, () => {
        const found = payments.find((entry) => entry.id === id);
        return found && read(found);
      })
    ),
    getSubscription: vi.fn((id: string) =>
      answer(`subscription:${id}`, () => {
        const found = subscriptions.find((entry) => entry.id === id);
        return found && read(found);
      })
    ),
    listSubscriptionPayments: vi.fn(
      (id: string) =>
        answer(`payments-of:${id}`, () =>
          payments
            .filter((entry) => entry.subscription === id)
            .map((entry) => read(entry))
        ) as Promise<unknown[]>
    ),
    listSubscriptionsByCheckout: vi.fn(
      (checkoutId: string) =>
        answer(`subscriptions-by:${checkoutId}`, () =>
          subscriptions
            .filter((entry) => entry.checkoutSession === checkoutId)
            .map((entry) => read(entry))
        ) as Promise<unknown[]>
    ),
    refundPayment: vi.fn(),
  };
  return { calls, client };
}

async function deliver(
  body: Record<string, unknown>,
  api = fakeApi(),
  text = JSON.stringify(body)
): Promise<ProviderBillingEvent[] | UnresolvedProviderEvent> {
  const envelope = readAsaasWebhook(text, clock);
  if (!envelope) {
    throw new Error("expected a readable webhook");
  }
  return await resolveAsaasWebhook(api.client, envelope, clock);
}

async function factsOf(
  body: Record<string, unknown>,
  api = fakeApi()
): Promise<ProviderBillingEvent[]> {
  const result = await deliver(body, api);
  if (!Array.isArray(result)) {
    throw new Error("expected facts");
  }
  return result;
}

const occurredAt = new Date("2026-10-26T12:15:00.000Z");
/** The clock of the tests: after the fixtures' event time. */
const clock = new Date("2026-10-26T13:00:00.000Z");
/** `26/10` + 1 month, through the end of `26/11` in São Paulo. */
const monthlyEnd = new Date("2026-11-27T03:00:00.000Z");
/** The exact text of the charge value in the resource read back (never the body's). */
const chargeAmount = { currency: "BRL", value: "24.90" } as const;

describe("AC-1a: the Asaas token, compared in constant time", () => {
  it("accepts the current token and, during a rotation, the next one", async () => {
    expect(
      await asaasTokenMatches("current-token-0001", ["current-token-0001", ""])
    ).toBe(true);
    expect(
      await asaasTokenMatches("next-token-0002", [
        "current-token-0001",
        "next-token-0002",
      ])
    ).toBe(true);
  });

  it("refuses a missing, empty or wrong token, wherever it differs", async () => {
    const accepted = ["abcdefghijklmnopqrstuvwxyz012345", ""];
    expect(await asaasTokenMatches(null, accepted)).toBe(false);
    expect(await asaasTokenMatches("", accepted)).toBe(false);
    expect(
      await asaasTokenMatches("Xbcdefghijklmnopqrstuvwxyz012345", accepted)
    ).toBe(false);
    expect(
      await asaasTokenMatches("abcdefghijklmnopqrstuvwxyz01234X", accepted)
    ).toBe(false);
    expect(await asaasTokenMatches("abc", accepted)).toBe(false);
  });

  it("never matches an empty configured token", async () => {
    expect(await asaasTokenMatches("anything", ["", ""])).toBe(false);
  });

  it("compares digests of the same length, so where the token differs takes no shortcut", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    await asaasTokenMatches("a", ["abcdefghijklmnopqrstuvwxyz012345"]);
    await asaasTokenMatches("abcdefghijklmnopqrstuvwxyz01234X", [
      "abcdefghijklmnopqrstuvwxyz012345",
    ]);
    // both sides are hashed every time: the loop always reads 32 bytes
    expect(digest).toHaveBeenCalledTimes(4);
    digest.mockRestore();
  });
});

describe("the webhook envelope: only IDs, the event name and its time", () => {
  it("reads the event ID, the name, the time (Brasília) and the resource ID", () => {
    expect(
      readAsaasWebhook(JSON.stringify(webhookBody("PAYMENT_CONFIRMED")), clock)
    ).toEqual({
      checkoutId: null,
      dateClamped: false,
      eventId: EVENT_ID,
      eventType: "PAYMENT_CONFIRMED",
      occurredAt,
      paymentId: PAYMENT_ID,
      subscriptionId: null,
    });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    [
      "no event ID",
      JSON.stringify({ ...webhookBody("PAYMENT_CONFIRMED"), id: undefined }),
    ],
    [
      "an event ID of another shape",
      JSON.stringify({ ...webhookBody("PAYMENT_CONFIRMED"), id: "x" }),
    ],
    [
      "a time in another format",
      JSON.stringify({
        ...webhookBody("PAYMENT_CONFIRMED"),
        dateCreated: "2026-10-26T09:15:00Z",
      }),
    ],
    [
      "a payment event without a payment",
      JSON.stringify({
        ...webhookBody("PAYMENT_CONFIRMED"),
        payment: undefined,
      }),
    ],
    [
      "a payment ID that would leave the path",
      JSON.stringify(
        webhookBody("PAYMENT_CONFIRMED", {
          payment: { id: "pay_../../customers" },
        })
      ),
    ],
    [
      "a payment ID with a query",
      JSON.stringify(
        webhookBody("PAYMENT_CONFIRMED", { payment: { id: "pay_abc?x=1" } })
      ),
    ],
    [
      "a subscription event naming a payment ID",
      JSON.stringify(
        webhookBody("SUBSCRIPTION_DELETED", { subscription: { id: "pay_abc" } })
      ),
    ],
    [
      "a checkout without a checkout ID",
      JSON.stringify(
        webhookBody("CHECKOUT_PAID", {
          checkout: { externalReference: "outra-coisa", id: "not-a-uuid" },
        })
      ),
    ],
  ])("is not readable with %s", (_case, text) => {
    expect(readAsaasWebhook(text)).toBeNull();
  });

  it("reads an event Polaris ignores without needing a resource", () => {
    expect(
      readAsaasWebhook(
        JSON.stringify({
          dateCreated: "2026-10-26 09:15:00",
          event: "PAYMENT_CREATED",
          id: EVENT_ID,
        })
      )
    ).not.toBeNull();
  });
});

describe("the time of the body is never trusted and never a reason to refuse (ADR 0101)", () => {
  const read = (dateCreated: string) =>
    readAsaasWebhook(
      JSON.stringify(webhookBody("PAYMENT_CONFIRMED", { dateCreated })),
      clock
    );

  it("a time more than 5 minutes ahead of the clock is cut down to now and flagged", () => {
    const envelope = read("2099-01-01 00:00:00");
    expect(envelope).toMatchObject({ dateClamped: true, occurredAt: clock });
  });

  it("a time up to 5 minutes ahead is clock skew: kept as it is", () => {
    // 13:00Z is 10:00 in Brasília
    const envelope = read("2026-10-26 10:05:00");
    expect(envelope).toMatchObject({
      dateClamped: false,
      occurredAt: new Date("2026-10-26T13:05:00.000Z"),
    });
    expect(read("2026-10-26 10:05:01")).toMatchObject({ dateClamped: true });
  });

  it("a body dated in the future still gives the fact of the resource, dated at most now", async () => {
    const facts = await factsOf(
      webhookBody("PAYMENT_CONFIRMED", { dateCreated: "2099-01-01 00:00:00" })
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.fact).toMatchObject({
      occurredAt: clock,
      periodEndsAt: monthlyEnd,
      type: "charge_succeeded",
    });
  });

  it("an unresolved event with a body dated in the future is marked, so it is never held for a retry", async () => {
    const api = fakeApi({ payments: [] });
    const result = await deliver(
      webhookBody("PAYMENT_CONFIRMED", { dateCreated: "2099-01-01 00:00:00" }),
      api
    );
    expect(result).toMatchObject({
      kind: "unresolved",
      occurredAtClamped: true,
    });
  });

  it("a confirmation takes its day from the charge read back, not from the body", async () => {
    // the body claims `26/10`, the charge was confirmed on `25/10`
    const api = fakeApi({
      payments: [paymentJson({ confirmedDate: "2026-10-25" })],
    });
    const facts = await factsOf(webhookBody("PAYMENT_CONFIRMED"), api);
    expect(facts[0]?.fact).toMatchObject({
      occurredAt: new Date("2026-10-26T02:59:59.999Z"),
    });
  });

  it("holds a webhook of just after midnight inside the day the charge was confirmed, not at its start", () => {
    // confirmed 23:59:50 on `25/10`, webhook at 00:00:05 on `26/10` (Brasília)
    const claimed = new Date("2026-10-26T03:00:05.000Z");
    expect(confirmationTime(claimed, "2026-10-25", clock).toISOString()).toBe(
      "2026-10-26T02:59:59.999Z"
    );
    // a body claiming an earlier day than the charge shows is moved up to its start
    expect(
      confirmationTime(
        new Date("2026-10-20T12:00:00.000Z"),
        "2026-10-25",
        clock
      ).toISOString()
    ).toBe("2026-10-25T03:00:00.000Z");
  });

  it("never dates a confirmation after now, even when the body is within the skew", () => {
    const ahead = new Date(clock.getTime() + 4 * 60_000);
    expect(confirmationTime(ahead, "2026-10-26", clock)).toEqual(clock);
    expect(confirmationTime(ahead, null, clock)).toEqual(clock);
  });

  it("keeps the time of day of the body when it falls on the day the charge shows", () => {
    expect(confirmationTime(occurredAt, "2026-10-26", clock).getTime()).toBe(
      occurredAt.getTime()
    );
    expect(confirmationTime(occurredAt, null, clock)).toEqual(occurredAt);
  });

  it("never dates a confirmation after now, even for a day in the future", () => {
    expect(confirmationTime(occurredAt, "2099-01-01", clock)).toEqual(clock);
  });

  it.each([
    ["absent", null],
    ["unreadable", "ontem"],
    ["not text", 20_261_026],
  ])(
    "a charge whose confirmation date is %s keeps the body's time",
    async (_case, confirmedDate) => {
      const api = fakeApi({ payments: [paymentJson({ confirmedDate })] });
      const facts = await factsOf(webhookBody("PAYMENT_CONFIRMED"), api);
      expect(facts[0]?.fact).toMatchObject({ occurredAt });
    }
  );
});

describe("AC-4: Asaas event → Polaris fact, read back from the API", () => {
  it("PAYMENT_CONFIRMED → charge_succeeded, period from originalDueDate + subscription cycle", async () => {
    expect(await factsOf(webhookBody("PAYMENT_CONFIRMED"))).toEqual([
      {
        fact: {
          amount: chargeAmount,
          cycleMonths: 1,
          occurredAt,
          periodEndsAt: monthlyEnd,
          type: "charge_succeeded",
        },
        providerEventId: EVENT_ID,
        providerRef: CHECKOUT_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
  });

  it("a charge of no value keeps its fact without an amount (never a refusal that would make Asaas resend it)", async () => {
    const api = fakeApi({ payments: [paymentJson({ value: 0 })] });
    const [confirmed] = await factsOf(webhookBody("PAYMENT_CONFIRMED"), api);
    expect(confirmed?.fact).toEqual({
      cycleMonths: 1,
      occurredAt,
      periodEndsAt: monthlyEnd,
      type: "charge_succeeded",
    });
    expect(() =>
      serializeBillingFact(confirmed?.fact as BillingFact)
    ).not.toThrow();
  });

  it("PAYMENT_RECEIVED → charge_succeeded (the same period: a duplicate by value)", async () => {
    const api = fakeApi({ payments: [paymentJson({ status: "RECEIVED" })] });
    const [received] = await factsOf(webhookBody("PAYMENT_RECEIVED"), api);
    expect(received?.fact).toEqual({
      amount: chargeAmount,
      cycleMonths: 1,
      occurredAt,
      periodEndsAt: monthlyEnd,
      type: "charge_succeeded",
    });
  });

  it("YEARLY gives 12 months, SEMIANNUALLY 6", async () => {
    const yearly = fakeApi({
      subscriptions: [subscriptionJson({ cycle: "YEARLY" })],
    });
    const [year] = await factsOf(webhookBody("PAYMENT_CONFIRMED"), yearly);
    expect(year?.fact).toMatchObject({
      cycleMonths: 12,
      periodEndsAt: new Date("2027-10-27T03:00:00.000Z"),
    });
    const half = fakeApi({
      subscriptions: [subscriptionJson({ cycle: "SEMIANNUALLY" })],
    });
    const [six] = await factsOf(webhookBody("PAYMENT_CONFIRMED"), half);
    expect(six?.fact).toMatchObject({
      cycleMonths: 6,
      periodEndsAt: new Date("2027-04-27T03:00:00.000Z"),
    });
  });

  it.each([
    "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
    "PAYMENT_REPROVED_BY_RISK_ANALYSIS",
    "PAYMENT_OVERDUE",
  ])("%s → charge_failed", async (eventType) => {
    const api = fakeApi({
      payments: [paymentJson({ confirmedDate: null, status: "OVERDUE" })],
    });
    expect(await factsOf(webhookBody(eventType), api)).toEqual([
      {
        fact: { occurredAt, type: "charge_failed" },
        providerEventId: EVENT_ID,
        providerRef: CHECKOUT_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
  });

  it("PAYMENT_REFUNDED → charge_refunded with the period of the refunded charge", async () => {
    const api = fakeApi({ payments: [paymentJson({ status: "REFUNDED" })] });
    expect(await factsOf(webhookBody("PAYMENT_REFUNDED"), api)).toEqual([
      {
        fact: {
          amount: chargeAmount,
          occurredAt,
          periodEndsAt: monthlyEnd,
          type: "charge_refunded",
        },
        providerEventId: EVENT_ID,
        providerRef: CHECKOUT_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
  });

  it("PAYMENT_CHARGEBACK_REQUESTED → charge_disputed; PAYMENT_AWAITING_CHARGEBACK_REVERSAL → dispute_reversed", async () => {
    const disputed = fakeApi({
      payments: [paymentJson({ status: "CHARGEBACK_REQUESTED" })],
    });
    expect(
      (await factsOf(webhookBody("PAYMENT_CHARGEBACK_REQUESTED"), disputed))[0]
        ?.fact
    ).toEqual({
      amount: chargeAmount,
      occurredAt,
      periodEndsAt: monthlyEnd,
      type: "charge_disputed",
    });
    const reversed = fakeApi({
      payments: [paymentJson({ status: "AWAITING_CHARGEBACK_REVERSAL" })],
    });
    expect(
      (
        await factsOf(
          webhookBody("PAYMENT_AWAITING_CHARGEBACK_REVERSAL"),
          reversed
        )
      )[0]?.fact
    ).toEqual({
      amount: chargeAmount,
      occurredAt,
      periodEndsAt: monthlyEnd,
      type: "dispute_reversed",
    });
  });

  it.each(["SUBSCRIPTION_DELETED", "SUBSCRIPTION_INACTIVATED"])(
    "%s → subscription_cancelled when the subscription read back is deleted or inactive",
    async (eventType) => {
      const api = fakeApi({
        subscriptions: [
          subscriptionJson({ deleted: true, status: "INACTIVE" }),
        ],
      });
      const body = {
        dateCreated: "2026-10-26 09:15:00",
        event: eventType,
        id: EVENT_ID,
        subscription: { id: SUBSCRIPTION_ID },
      };
      expect(await factsOf(body, api)).toEqual([
        {
          fact: { occurredAt, type: "subscription_cancelled" },
          providerEventId: EVENT_ID,
          providerRef: CHECKOUT_ID,
          providerSubscriptionId: SUBSCRIPTION_ID,
        },
      ]);
      // a cancellation the subscription does not show is no fact
      const live = {
        dateCreated: "2026-10-26 09:15:00",
        event: eventType,
        id: EVENT_ID,
        subscription: { id: SUBSCRIPTION_ID },
      };
      expect(await factsOf(live)).toEqual([]);
    }
  );

  it("CHECKOUT_PAID with the first charge due later (trial) → trial_method_ready", async () => {
    const api = fakeApi({
      payments: [
        paymentJson({
          confirmedDate: null,
          dateCreated: "2026-10-19",
          originalDueDate: "2026-10-26",
          status: "PENDING",
        }),
      ],
      subscriptions: [subscriptionJson({ cycle: "YEARLY" })],
    });
    const body = {
      checkout: { id: CHECKOUT_ID },
      dateCreated: "2026-10-19 10:00:00",
      event: "CHECKOUT_PAID",
      id: EVENT_ID,
    };
    expect(await factsOf(body, api)).toEqual([
      {
        fact: {
          cycleMonths: 12,
          occurredAt: new Date("2026-10-19T13:00:00.000Z"),
          type: "trial_method_ready",
        },
        providerEventId: EVENT_ID,
        providerRef: CHECKOUT_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
  });

  it("CHECKOUT_PAID without a trial (first charge due the same day) gives no fact: the charge is the fact", async () => {
    const api = fakeApi({
      payments: [
        paymentJson({
          dateCreated: "2026-10-26",
          originalDueDate: "2026-10-26",
        }),
      ],
    });
    const body = {
      checkout: { id: CHECKOUT_ID },
      dateCreated: "2026-10-26 10:00:00",
      event: "CHECKOUT_PAID",
      id: EVENT_ID,
    };
    expect(await factsOf(body, api)).toEqual([]);
  });

  it.each([
    "PAYMENT_CREATED",
    "PAYMENT_UPDATED",
    "PAYMENT_DELETED",
    "PAYMENT_RESTORED",
    "PAYMENT_AUTHORIZED",
    "PAYMENT_AWAITING_RISK_ANALYSIS",
    "PAYMENT_APPROVED_BY_RISK_ANALYSIS",
    "PAYMENT_PARTIALLY_REFUNDED",
    "PAYMENT_REFUND_IN_PROGRESS",
    "PAYMENT_CHARGEBACK_DISPUTE",
    "CHECKOUT_VIEWED",
    "CHECKOUT_CANCELED",
    "CHECKOUT_EXPIRED",
    "SUBSCRIPTION_CREATED",
    "SUBSCRIPTION_UPDATED",
  ])("%s gives no fact and reads nothing", async (eventType) => {
    const api = fakeApi();
    expect(await factsOf(webhookBody(eventType), api)).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it("a partial refund is no fact (ADR 0066): the charge is not REFUNDED", async () => {
    const api = fakeApi({ payments: [paymentJson({ status: "CONFIRMED" })] });
    expect(await factsOf(webhookBody("PAYMENT_REFUNDED"), api)).toEqual([]);
  });

  it("a charge outside a subscription, a deleted one, or a subscription Polaris did not create give no fact", async () => {
    expect(
      await factsOf(
        webhookBody("PAYMENT_CONFIRMED"),
        fakeApi({ payments: [paymentJson({ subscription: null })] })
      )
    ).toEqual([]);
    // cancelled during the trial: the pending charge is deleted, not a pending one
    expect(
      await factsOf(
        webhookBody("PAYMENT_OVERDUE"),
        fakeApi({
          payments: [paymentJson({ deleted: true, status: "PENDING" })],
        })
      )
    ).toEqual([]);
    // a charge that names another checkout than its subscription's is not trusted
    expect(
      await factsOf(
        webhookBody("PAYMENT_CONFIRMED"),
        fakeApi({
          payments: [
            paymentJson({
              checkoutSession: "aaaaaaaa-0000-4000-8000-000000000009",
            }),
          ],
        })
      )
    ).toEqual([]);
  });
});

describe("S1.3: the fact is tied to the organization by the checkout ID, not by externalReference", () => {
  const body = {
    checkout: { id: CHECKOUT_ID },
    dateCreated: "2026-10-26 10:00:00",
    event: "CHECKOUT_PAID",
    id: EVENT_ID,
  };
  const trial = () =>
    fakeApi({
      payments: [
        paymentJson({
          confirmedDate: null,
          dateCreated: "2026-10-19",
          originalDueDate: "2026-10-26",
          status: "PENDING",
        }),
      ],
    });

  it("a subscription read back with externalReference null and a known checkoutSession gives the fact of that checkout", async () => {
    const api = fakeApi({
      subscriptions: [
        subscriptionJson({
          checkoutSession: CHECKOUT_ID,
          externalReference: null,
        }),
      ],
    });
    expect(await factsOf(webhookBody("PAYMENT_CONFIRMED"), api)).toEqual([
      {
        fact: {
          amount: chargeAmount,
          cycleMonths: 1,
          occurredAt,
          periodEndsAt: monthlyEnd,
          type: "charge_succeeded",
        },
        providerEventId: EVENT_ID,
        providerRef: CHECKOUT_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
  });

  it("a payment and a subscription event with the fixture's null externalReference carry the checkout ID", async () => {
    const [charge] = await factsOf(webhookBody("PAYMENT_CONFIRMED"));
    const [cancel] = await factsOf(
      webhookBody("SUBSCRIPTION_DELETED", {
        subscription: { id: SUBSCRIPTION_ID },
      }),
      fakeApi({
        subscriptions: [
          subscriptionJson({ deleted: true, status: "INACTIVE" }),
        ],
      })
    );
    expect(charge?.providerRef).toBe(CHECKOUT_ID);
    expect(cancel?.providerRef).toBe(CHECKOUT_ID);
    expect(cancel?.providerSubscriptionId).toBe(SUBSCRIPTION_ID);
  });

  it("a fake externalReference on the resource changes nothing: the checkout ID is the link", async () => {
    const [fact] = await factsOf(
      webhookBody("PAYMENT_CONFIRMED"),
      fakeApi({
        subscriptions: [subscriptionJson({ externalReference: "pol_forjada" })],
      })
    );
    expect(fact?.providerRef).toBe(CHECKOUT_ID);
  });

  it("a subscription that shows no checkoutSession is unresolved (AC-48), for a charge and for a cancellation", async () => {
    const orphan = fakeApi({
      subscriptions: [subscriptionJson({ checkoutSession: null })],
    });
    expect(
      await deliver(webhookBody("PAYMENT_CONFIRMED"), orphan)
    ).toMatchObject({ kind: "unresolved", resourceId: SUBSCRIPTION_ID });
    expect(
      await deliver(
        webhookBody("SUBSCRIPTION_DELETED", {
          subscription: { id: SUBSCRIPTION_ID },
        }),
        orphan
      )
    ).toMatchObject({ kind: "unresolved", resourceId: SUBSCRIPTION_ID });
  });

  it("CHECKOUT_PAID finds the subscription by its checkoutSession and gives the trial fact of that checkout", async () => {
    const [fact] = await factsOf(body, trial());
    expect(fact).toMatchObject({
      fact: { cycleMonths: 1, type: "trial_method_ready" },
      providerRef: CHECKOUT_ID,
      providerSubscriptionId: SUBSCRIPTION_ID,
    });
  });

  it("CHECKOUT_PAID ignores a subscription of another checkout that the list returned", async () => {
    const other = "bbbbbbbb-0000-4000-8000-000000000002";
    const api = trial();
    api.client.listSubscriptionsByCheckout = vi.fn(async () => [
      parseProviderJson(
        JSON.stringify(subscriptionJson({ checkoutSession: other }))
      ),
    ]);
    expect(await deliver(body, api)).toMatchObject({
      kind: "unresolved",
      resourceId: `checkout:${CHECKOUT_ID.slice(0, 8)}`,
    });
  });
});

describe("AC-1c: the fact comes from the resource read back, never from the body", () => {
  it("a forged body claiming another status, value and due date gives the resource's fact", async () => {
    const forged = webhookBody("PAYMENT_CONFIRMED", {
      payment: {
        ...paymentJson({
          originalDueDate: "2027-01-31",
          status: "CONFIRMED",
          value: 9999.99,
        }),
        id: PAYMENT_ID,
      },
    });
    // the charge is really confirmed, due `26/10`: its period is the one that counts
    const [fact] = await factsOf(forged);
    expect(fact?.fact).toEqual({
      amount: chargeAmount,
      cycleMonths: 1,
      occurredAt,
      periodEndsAt: monthlyEnd,
      type: "charge_succeeded",
    });
    // the charge is really pending: the body's confirmation gives nothing
    const pending = fakeApi({
      payments: [paymentJson({ confirmedDate: null, status: "PENDING" })],
    });
    expect(await factsOf(forged, pending)).toEqual([]);
  });

  it("a body naming a resource that does not exist is an unresolved event with IDs only (AC-48)", async () => {
    const result = await deliver(
      webhookBody("PAYMENT_CONFIRMED", {
        payment: { id: "pay_doesnotexist01" },
      })
    );
    expect(result).toEqual({
      eventType: "PAYMENT_CONFIRMED",
      kind: "unresolved",
      occurredAt,
      providerEventId: EVENT_ID,
      resourceId: "pay_doesnotexist01",
    });
  });

  it("a subscription that cannot be found behind a charge, and a checkout reference with no subscription, are unresolved too", async () => {
    const orphan = fakeApi({ subscriptions: [] });
    expect(
      await deliver(webhookBody("PAYMENT_CONFIRMED"), orphan)
    ).toMatchObject({
      kind: "unresolved",
      resourceId: SUBSCRIPTION_ID,
    });
    const body = {
      checkout: { id: CHECKOUT_ID },
      dateCreated: "2026-10-19 10:00:00",
      event: "CHECKOUT_PAID",
      id: EVENT_ID,
    };
    expect(await deliver(body, orphan)).toMatchObject({
      kind: "unresolved",
      resourceId: `checkout:${CHECKOUT_ID.slice(0, 8)}`,
    });
  });

  it("a body with the right token cannot take access away from a healthy charge", async () => {
    // the charge is confirmed and nothing else: a chargeback, its reversal or a failure the charge does not show give nothing
    for (const eventType of [
      "PAYMENT_CHARGEBACK_REQUESTED",
      "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
      "PAYMENT_OVERDUE",
      "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
      "PAYMENT_REFUNDED",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: One event at a time keeps the failure message precise.
      expect(await factsOf(webhookBody(eventType)), eventType).toEqual([]);
    }
    // a reversal needs the charge to be awaiting it, not just charged back
    const disputed = fakeApi({
      payments: [paymentJson({ status: "CHARGEBACK_REQUESTED" })],
    });
    expect(
      await factsOf(
        webhookBody("PAYMENT_AWAITING_CHARGEBACK_REVERSAL"),
        disputed
      )
    ).toEqual([]);
  });

  it("a finished checkout whose subscription has no charge yet is unresolved, to be read again", async () => {
    const api = fakeApi({ payments: [] });
    const body = {
      checkout: { id: CHECKOUT_ID },
      dateCreated: "2026-10-19 10:00:00",
      event: "CHECKOUT_PAID",
      id: EVENT_ID,
    };
    expect(await deliver(body, api)).toMatchObject({
      kind: "unresolved",
      resourceId: SUBSCRIPTION_ID,
    });
  });

  it("the same body with its keys reordered gives the same fact", async () => {
    const body = webhookBody("PAYMENT_CONFIRMED");
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(body));
    expect(
      await deliver(reordered, fakeApi(), JSON.stringify(reordered))
    ).toEqual(await deliver(body));
  });

  it("a late event keeps its own fact with the resource's period, whatever the resource's status now", async () => {
    // confirmed, then refunded before the confirmation was delivered
    const refunded = fakeApi({
      payments: [paymentJson({ status: "REFUNDED" })],
    });
    expect(await factsOf(webhookBody("PAYMENT_CONFIRMED"), refunded)).toEqual([
      {
        fact: {
          amount: chargeAmount,
          cycleMonths: 1,
          occurredAt,
          periodEndsAt: monthlyEnd,
          type: "charge_succeeded",
        },
        providerEventId: EVENT_ID,
        providerRef: CHECKOUT_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
  });

  it("a provider that is down makes the delivery fail, to be sent again", async () => {
    await expect(
      deliver(webhookBody("PAYMENT_CONFIRMED"), fakeApi({ down: true }))
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("the resource IDs that reach the client are the checked ones", async () => {
    const api = fakeApi();
    await deliver(webhookBody("PAYMENT_CONFIRMED"));
    await deliver(webhookBody("PAYMENT_CONFIRMED"), api);
    expect(api.calls).toEqual([
      `payment:${PAYMENT_ID}`,
      `subscription:${SUBSCRIPTION_ID}`,
    ]);
  });
});

describe("AC-5: the period is the due date of the charge plus the cycle, never now", () => {
  it("uses originalDueDate: an overdue charge whose dueDate Asaas rewrote keeps its period", async () => {
    const rewritten = fakeApi({
      payments: [
        paymentJson({
          dueDate: "2026-10-23",
          originalDueDate: "2026-10-26",
          status: "CONFIRMED",
        }),
      ],
    });
    expect(
      (await factsOf(webhookBody("PAYMENT_CONFIRMED"), rewritten))[0]?.fact
    ).toMatchObject({ periodEndsAt: monthlyEnd });
  });

  it("gives the same end whatever the clock says, and on a second read", async () => {
    vi.useFakeTimers();
    try {
      const read = async (now: Date) => {
        const text = JSON.stringify(webhookBody("PAYMENT_CONFIRMED"));
        const envelope = readAsaasWebhook(text, now);
        return await resolveAsaasWebhook(
          fakeApi().client,
          envelope as never,
          now
        );
      };
      const first = await read(new Date("2026-10-26T13:00:00Z"));
      const second = await read(new Date("2027-03-01T12:00:00Z"));
      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refund of charge 1 after charge 2 was paid carries charge 1's period", async () => {
    const api = fakeApi({
      payments: [
        paymentJson({ status: "REFUNDED" }),
        paymentJson({
          dueDate: "2026-11-26",
          id: "pay_fake0000000002",
          originalDueDate: "2026-11-26",
        }),
      ],
    });
    expect(
      (await factsOf(webhookBody("PAYMENT_REFUNDED"), api))[0]?.fact
    ).toEqual({
      amount: chargeAmount,
      occurredAt,
      periodEndsAt: monthlyEnd,
      type: "charge_refunded",
    });
  });

  it("charge 2 due on 28/02 after charge 1 due on 31/01 is a new period, not a duplicate of the first", () => {
    const subscription = pickAsaasSubscription(
      parseProviderJson(JSON.stringify(subscriptionJson()))
    );
    const january = pickAsaasPayment(
      parseProviderJson(
        JSON.stringify(
          paymentJson({
            dateCreated: "2027-01-31",
            originalDueDate: "2027-01-31",
          })
        )
      )
    );
    const february = pickAsaasPayment(
      parseProviderJson(
        JSON.stringify(
          paymentJson({
            id: "pay_fake0000000002",
            originalDueDate: "2027-02-28",
          })
        )
      )
    );
    const now = new Date("2027-02-28T15:00:00.000Z");
    const [first, second] = reconcileAsaasSubscription({
      now: new Date("2027-01-31T15:00:00.000Z"),
      payments: [january],
      subscription,
    });
    expect(second).toBeUndefined();
    const [, renewal] = reconcileAsaasSubscription({
      now,
      payments: [january, february],
      subscription,
    });
    expect(first?.fact).toMatchObject({
      periodEndsAt: new Date("2027-03-01T03:00:00.000Z"),
    });
    expect(renewal?.fact).toMatchObject({
      periodEndsAt: new Date("2027-03-29T03:00:00.000Z"),
    });
    const record: BillingRecord = {
      accessEndsAt: null,
      cancelAtPeriodEnd: false,
      cycleMonths: null,
      lastFactAt: null,
      pendingCycleMonths: null,
      revoked: null,
      state: "free",
      trialConsumed: true,
    };
    const afterFirst = reconcileFact(record, first?.fact ?? ({} as never), {
      now: new Date("2027-01-31T15:00:00.000Z"),
      overFreeLimits: false,
    });
    if (afterFirst.outcome !== "applied") {
      throw new Error("the first charge must apply");
    }
    expect(
      reconcileFact(afterFirst.record, renewal?.fact ?? ({} as never), {
        now,
        overFreeLimits: false,
      }).outcome
    ).toBe("applied");
  });
});

describe("AC-3: no personal or card data leaves the mapper", () => {
  it("the fact has only type, time, period and cycle; nothing of the payer, the card or the receipts", async () => {
    const results = [
      ...(await factsOf(webhookBody("PAYMENT_CONFIRMED"))),
      ...(await factsOf(
        webhookBody("PAYMENT_REFUNDED"),
        fakeApi({ payments: [paymentJson({ status: "REFUNDED" })] })
      )),
    ];
    for (const { fact } of results) {
      expect(Object.keys(fact).sort()).toEqual(
        fact.type === "charge_succeeded"
          ? ["amount", "cycleMonths", "occurredAt", "periodEndsAt", "type"]
          : ["amount", "occurredAt", "periodEndsAt", "type"]
      );
      // the amount is the exact text of the resource, with the currency only
      expect("amount" in fact ? fact.amount : undefined).toStrictEqual({
        currency: "BRL",
        value: "24.90",
      });
    }
    const serialized = JSON.stringify(results);
    for (const leaked of [
      FAKE_PAYER.cpf,
      FAKE_PAYER.email,
      FAKE_PAYER.name,
      FAKE_CARD_TOKEN,
      FAKE_INVOICE_URL,
      "creditCard",
      "customer",
      "receipts",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("the picked resources keep only the allowlisted keys", () => {
    const payment = pickAsaasPayment(
      parseProviderJson(
        JSON.stringify(
          paymentJson({ refunds: [{ transactionReceiptUrl: "x" }] })
        )
      )
    );
    expect(Object.keys(payment).sort()).toEqual([
      "amount",
      "checkoutSession",
      "confirmedOn",
      "createdOn",
      "deleted",
      "id",
      "originalDueDate",
      "status",
      "subscriptionId",
    ]);
    expect(payment.amount).toBe("24.90");
    const subscription = pickAsaasSubscription(
      parseProviderJson(JSON.stringify(subscriptionJson()))
    );
    expect(Object.keys(subscription).sort()).toEqual([
      "checkoutSession",
      "cycleMonths",
      "deleted",
      "id",
      "status",
    ]);
  });
});

describe("AC-2 (Asaas side): stable event IDs and the reference attachProvider stored", () => {
  it("the providerRef of a fact is, character for character, the one the checkout was prepared with", async () => {
    const checkout = {
      id: CHECKOUT_ID,
      link: `https://sandbox.asaas.com/checkoutSession/show/${CHECKOUT_ID}`,
    };
    const port = createAsaasPort({
      apiKey: "$aact_hmlg_FAKE_TEST_KEY",
      appBaseUrl: "https://app.example.test",
      baseUrl: "https://api-sandbox.asaas.com/v3",
      fetch: async () => ({
        status: 200,
        text: async () => JSON.stringify(checkout),
      }),
      randomUuid: () => "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b",
      timeoutMs: 1000,
    });
    const prepared = await port.prepareSubscription({
      amount: "24.90",
      cycleMonths: 1,
      firstChargeOn: "2026-10-26",
      payer: { email: FAKE_PAYER.email, name: FAKE_PAYER.name },
    });
    const [event] = await factsOf(
      webhookBody("PAYMENT_CONFIRMED"),
      fakeApi({
        subscriptions: [
          subscriptionJson({ checkoutSession: prepared.providerRef }),
        ],
      })
    );
    expect(event?.providerRef).toBe(prepared.providerRef);
    expect(event?.providerEventId).toBe(EVENT_ID);
  });

  it("the reconciliation's IDs are reconcile:<payId>:<status>, the same on every read and not the webhook's", () => {
    const subscription = pickAsaasSubscription(
      parseProviderJson(JSON.stringify(subscriptionJson()))
    );
    const payment = pickAsaasPayment(
      parseProviderJson(
        JSON.stringify(
          paymentJson({ dateCreated: "2026-10-26", status: "REFUNDED" })
        )
      )
    );
    const now = new Date("2026-10-30T12:00:00.000Z");
    const read = () =>
      reconcileAsaasSubscription({
        now,
        payments: [payment],
        subscription,
      }).map((entry) => entry.providerEventId);
    expect(read()).toEqual([
      `reconcile:${PAYMENT_ID}:CONFIRMED`,
      `reconcile:${PAYMENT_ID}:REFUNDED`,
    ]);
    expect(read()).toEqual(read());
    expect(read()).not.toContain(EVENT_ID);
  });

  describe("a money fact from the webhook and the same from the reconciliation have one effect, in either order", () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    const context = { now, overFreeLimits: false };
    const subscription = pickAsaasSubscription(
      parseProviderJson(JSON.stringify(subscriptionJson()))
    );
    const active: BillingRecord = {
      accessEndsAt: monthlyEnd,
      cancelAtPeriodEnd: false,
      cycleMonths: 1,
      lastFactAt: occurredAt,
      pendingCycleMonths: null,
      revoked: null,
      state: "active",
      trialConsumed: true,
    };
    const trialSetup: BillingRecord = {
      ...active,
      accessEndsAt: null,
      cycleMonths: null,
      lastFactAt: null,
      state: "trial_setup",
      trialConsumed: false,
    };

    const cases: [
      string,
      string,
      string,
      BillingRecord,
      BillingRecord | null,
    ][] = [
      ["charge_succeeded", "PAYMENT_CONFIRMED", "CONFIRMED", trialSetup, null],
      ["charge_refunded", "PAYMENT_REFUNDED", "REFUNDED", active, null],
      [
        "charge_disputed",
        "PAYMENT_CHARGEBACK_REQUESTED",
        "CHARGEBACK_REQUESTED",
        active,
        null,
      ],
      [
        "dispute_reversed",
        "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
        "AWAITING_CHARGEBACK_REVERSAL",
        active,
        null,
      ],
    ];

    it.each(cases)("%s", async (factType, eventType, status, start) => {
      const api = fakeApi({ payments: [paymentJson({ status })] });
      const fromWebhook = (await factsOf(webhookBody(eventType), api)).find(
        (entry) => entry.fact.type === factType
      );
      const payment = pickAsaasPayment(
        parseProviderJson(JSON.stringify(paymentJson({ status })))
      );
      const fromReconcile = reconcileAsaasSubscription({
        now,
        payments: [payment],
        subscription,
      }).find((entry) => entry.fact.type === factType);
      if (!(fromWebhook && fromReconcile)) {
        throw new Error("both sides must give the fact");
      }
      expect(fromWebhook.providerEventId).not.toBe(
        fromReconcile.providerEventId
      );
      // dispute_reversed acts on a disputed record
      const disputed =
        factType === "dispute_reversed"
          ? reconcileFact(
              start,
              { occurredAt, periodEndsAt: monthlyEnd, type: "charge_disputed" },
              context
            )
          : null;
      const base =
        disputed && disputed.outcome === "applied" ? disputed.record : start;
      for (const [first, second] of [
        [fromWebhook, fromReconcile],
        [fromReconcile, fromWebhook],
      ] as const) {
        const once = reconcileFact(base, first.fact, context);
        expect(once.outcome, `${first.providerEventId} first`).toBe("applied");
        if (once.outcome !== "applied") {
          return;
        }
        const twice = reconcileFact(once.record, second.fact, context);
        if (twice.outcome === "applied") {
          // a second reversal is only remembered as a win: access does not move again
          expect(factType).toBe("dispute_reversed");
          expect(twice.transition).toBeNull();
          expect(twice.record.state).toBe(once.record.state);
          expect(twice.record.accessEndsAt).toEqual(once.record.accessEndsAt);
        } else {
          expect(twice.reason).toBe("not_applicable");
        }
      }
    });
  });
});

describe("the reconciliation reads the same facts the webhooks give", () => {
  const subscriptionOf = (overrides: Record<string, unknown> = {}) =>
    pickAsaasSubscription(
      parseProviderJson(JSON.stringify(subscriptionJson(overrides)))
    );
  const paymentOf = (overrides: Record<string, unknown> = {}) =>
    pickAsaasPayment(parseProviderJson(JSON.stringify(paymentJson(overrides))));

  it("a trial cancelled before its first charge is only a cancellation: a gone subscription starts no trial", () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    const events = reconcileAsaasSubscription({
      now,
      payments: [paymentOf({ deleted: true, status: "PENDING" })],
      subscription: subscriptionOf({ deleted: true, status: "INACTIVE" }),
    });
    expect(
      events.map((entry) => [entry.providerEventId, entry.fact.type])
    ).toEqual([
      [`reconcile:${SUBSCRIPTION_ID}:DELETED`, "subscription_cancelled"],
    ]);
  });

  it("a live trial: the method is ready", () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    const events = reconcileAsaasSubscription({
      now,
      payments: [paymentOf({ confirmedDate: null, status: "PENDING" })],
      subscription: subscriptionOf(),
    });
    expect(events.map((entry) => entry.providerEventId)).toEqual([
      `reconcile:${SUBSCRIPTION_ID}:CHECKOUT_PAID`,
    ]);
  });

  it("an overdue charge is a failure; a charge whose period is over is not read", () => {
    const now = new Date("2026-12-10T12:00:00.000Z");
    const events = reconcileAsaasSubscription({
      now,
      payments: [
        paymentOf({ dateCreated: "2026-10-26" }),
        paymentOf({
          dateCreated: "2026-11-19",
          id: "pay_fake0000000002",
          originalDueDate: "2026-11-26",
          status: "OVERDUE",
        }),
      ],
      subscription: subscriptionOf(),
    });
    expect(events.map((entry) => entry.providerEventId)).toEqual([
      "reconcile:pay_fake0000000002:OVERDUE",
    ]);
  });
});
