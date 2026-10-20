import {
  type BillingFact,
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
import type { WooviClient } from "./client";
import {
  pickWooviInstallment,
  pickWooviSubscription,
  reconcileWooviSubscription,
  wooviEventId,
} from "./mapper";
import {
  disputeWebhookBody,
  globalId,
  INSTALLMENT_ID,
  INSTALLMENT_LOG_ID,
  installmentJson,
  installmentWebhookBody,
  OTHER_INSTALLMENT_ID,
  OTHER_SUBSCRIPTION_ID,
  PERSONAL_VALUES,
  refundWebhookBody,
  SUBSCRIPTION_ID,
  SUBSCRIPTION_LOG_ID,
  subscriptionBeforeApprovalJson,
  subscriptionJson,
  subscriptionWebhookBody,
} from "./test-fixtures";
import {
  inspectWooviWebhook,
  readWooviWebhook,
  resolveWooviWebhook,
  type WooviStateNotShownReport,
} from "./webhook";

type Resource = Record<string, unknown>;

/** What the API holds, by `globalID`, written as JSON text the way the client reads it. */
function fakeApi(
  options: {
    down?: boolean;
    installments?: Resource[];
    subscriptions?: Resource[];
  } = {}
) {
  const subscriptions = options.subscriptions ?? [subscriptionJson()];
  const installments = options.installments ?? [installmentJson()];
  const read = (value: unknown) => parseProviderJson(JSON.stringify(value));
  const calls: string[] = [];
  const answer = (call: string, found: Resource | undefined) => {
    calls.push(call);
    if (options.down) {
      return Promise.reject(new ProviderUnavailableError());
    }
    return found === undefined
      ? Promise.reject(new ProviderNotFoundError())
      : Promise.resolve(read(found));
  };
  const client: WooviClient = {
    cancelSubscription: vi.fn(),
    createSubscription: vi.fn(),
    createCustomer: vi.fn(),
    getCustomer: vi.fn(),
    getInstallment: vi.fn((id: string) =>
      answer(
        `installment:${id}`,
        installments.find((entry) => entry.globalID === id)
      )
    ),
    getSubscription: vi.fn((id: string) =>
      answer(
        `subscription:${id}`,
        subscriptions.find((entry) => entry.globalID === id)
      )
    ),
    listSubscriptionInstallments: vi.fn(),
    refundPix: vi.fn(),
  };
  return { calls, client };
}

/** The clock of the tests. */
const clock = new Date("2026-10-27T13:00:00.000Z");
/** 27/10 + 1 month, through the end of 27/11 in São Paulo. */
const monthlyEnd = new Date("2026-11-28T03:00:00.000Z");

async function deliver(
  body: Resource,
  api = fakeApi(),
  text = JSON.stringify(body)
): Promise<ProviderBillingEvent[] | UnresolvedProviderEvent> {
  const envelope = readWooviWebhook(text);
  if (!envelope) {
    throw new Error("expected a readable webhook");
  }
  return await resolveWooviWebhook(api.client, envelope, clock);
}

async function factsOf(
  body: Resource,
  api = fakeApi()
): Promise<ProviderBillingEvent[]> {
  const result = await deliver(body, api);
  if (!Array.isArray(result)) {
    throw new Error("expected facts");
  }
  return result;
}

function subscriptionOf(overrides: Resource, pix: Resource = {}) {
  const base = subscriptionJson();
  return {
    ...base,
    pixRecurring: { ...(base.pixRecurring as Resource), ...pix },
    ...overrides,
  };
}

function withoutAuthorization() {
  return subscriptionBeforeApprovalJson();
}

function installmentOf(overrides: Resource, cobr: Resource = {}) {
  const base = installmentJson();
  return {
    ...base,
    cobr: { ...(base.cobr as Resource), ...cobr },
    ...overrides,
  };
}

const approved = () => subscriptionWebhookBody("PIX_AUTOMATIC_APPROVED");
const rejected = () => subscriptionWebhookBody("PIX_AUTOMATIC_REJECTED");
const completed = () => installmentWebhookBody("PIX_AUTOMATIC_COBR_COMPLETED");
const failed = () => installmentWebhookBody("PIX_AUTOMATIC_COBR_REJECTED");

describe("PIX_AUTOMATIC_APPROVED", () => {
  it("an approved authorization of a journey with trial is trial_method_ready", async () => {
    const events = await factsOf(approved());
    expect(events).toEqual([
      {
        fact: { cycleMonths: 1, occurredAt: clock, type: "trial_method_ready" },
        providerEventId: `PIX_AUTOMATIC_APPROVED:${SUBSCRIPTION_ID}`,
        providerRef: SUBSCRIPTION_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
  });

  it.each([
    ["MONTHLY", 1],
    ["SEMIANNUALLY", 6],
    ["ANNUALLY", 12],
  ])("carries the cycle of %s as %i months", async (frequency, months) => {
    const api = fakeApi({ subscriptions: [subscriptionOf({ frequency })] });
    const [event] = await factsOf(approved(), api);
    expect(event?.fact).toMatchObject({
      cycleMonths: months,
      type: "trial_method_ready",
    });
  });

  it.each([
    [
      "generating the QR (status CREATED)",
      subscriptionOf({}, { status: "CREATED" }),
    ],
    ["no authorization status yet", withoutAuthorization()],
    [
      "an authorization the payer refused",
      subscriptionOf({}, { status: "REJECTED" }),
    ],
    [
      "a subscription that is not active",
      subscriptionOf({ status: "INACTIVE" }),
    ],
    [
      "the journey that pays on approval",
      subscriptionOf({}, { journey: "PAYMENT_ON_APPROVAL" }),
    ],
  ])("emits nothing for %s (AC-20)", async (_name, subscription) => {
    expect(
      await factsOf(approved(), fakeApi({ subscriptions: [subscription] }))
    ).toEqual([]);
  });

  it("a body that claims an approval the resource does not show gives nothing", async () => {
    const api = fakeApi({
      subscriptions: [subscriptionOf({}, { status: "CREATED" })],
    });
    const body = subscriptionWebhookBody("PIX_AUTOMATIC_APPROVED", {
      pixRecurring: { journey: "ONLY_RECURRENCY", status: "APPROVED" },
      status: "ACTIVE",
    });
    expect(await factsOf(body, api)).toEqual([]);
  });
});

describe("PIX_AUTOMATIC_REJECTED", () => {
  it.each([
    ["rejected by the payer", subscriptionOf({}, { status: "REJECTED" })],
    ["canceled", subscriptionOf({}, { status: "CANCELED" })],
    ["inactive", subscriptionOf({ status: "INACTIVE" })],
  ])(
    "a subscription %s is subscription_cancelled",
    async (_name, subscription) => {
      const events = await factsOf(
        rejected(),
        fakeApi({ subscriptions: [subscription] })
      );
      expect(events).toEqual([
        {
          fact: { occurredAt: clock, type: "subscription_cancelled" },
          providerEventId: `PIX_AUTOMATIC_REJECTED:${SUBSCRIPTION_ID}`,
          providerRef: SUBSCRIPTION_ID,
          providerSubscriptionId: SUBSCRIPTION_ID,
        },
      ]);
    }
  );

  it("a subscription still approved and active gives nothing, whatever the body says", async () => {
    const body = subscriptionWebhookBody("PIX_AUTOMATIC_REJECTED", {
      pixRecurring: { journey: "ONLY_RECURRENCY", status: "REJECTED" },
      status: "INACTIVE",
    });
    expect(await factsOf(body)).toEqual([]);
  });
});

describe("PIX_AUTOMATIC_COBR_COMPLETED", () => {
  it("a paid installment is charge_succeeded with the period it pays and its amount", async () => {
    const events = await factsOf(completed());
    expect(events).toEqual([
      {
        fact: {
          amount: { currency: "BRL", value: "24.90" },
          cycleMonths: 1,
          occurredAt: clock,
          periodEndsAt: monthlyEnd,
          type: "charge_succeeded",
        },
        providerEventId: `PIX_AUTOMATIC_COBR_COMPLETED:${INSTALLMENT_ID}`,
        providerRef: SUBSCRIPTION_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
  });

  it.each([
    [
      "27/10 12:00Z, monthly",
      "2026-10-27T12:00:00.000Z",
      "MONTHLY",
      "2026-11-28T03:00:00.000Z",
    ],
    [
      "27/10 02:00Z is 26/10 in São Paulo",
      "2026-10-27T02:00:00.000Z",
      "MONTHLY",
      "2026-11-27T03:00:00.000Z",
    ],
    [
      "27/10 02:59Z is still 26/10",
      "2026-10-27T02:59:59.999Z",
      "MONTHLY",
      "2026-11-27T03:00:00.000Z",
    ],
    [
      "27/10 03:00Z is 27/10",
      "2026-10-27T03:00:00.000Z",
      "MONTHLY",
      "2026-11-28T03:00:00.000Z",
    ],
    [
      "31/01 + 1 month is 28/02",
      "2026-01-31T12:00:00.000Z",
      "MONTHLY",
      "2026-03-01T03:00:00.000Z",
    ],
    [
      "27/10 + 6 months",
      "2026-10-27T12:00:00.000Z",
      "SEMIANNUALLY",
      "2027-04-28T03:00:00.000Z",
    ],
    [
      "27/10 + 12 months",
      "2026-10-27T12:00:00.000Z",
      "ANNUALLY",
      "2027-10-28T03:00:00.000Z",
    ],
  ])("period end: %s", async (_name, dateGenerateCharge, frequency, end) => {
    const api = fakeApi({
      installments: [installmentOf({ dateGenerateCharge })],
      subscriptions: [subscriptionOf({ frequency })],
    });
    const [event] = await factsOf(completed(), api);
    expect(event?.fact).toMatchObject({
      periodEndsAt: new Date(end),
      type: "charge_succeeded",
    });
  });

  it("writes the amount from integer cents, never through a float", async () => {
    for (const [value, text] of [
      [2490, "24.90"],
      [5, "0.05"],
      [100_000, "1000.00"],
    ] as const) {
      const api = fakeApi({ installments: [installmentOf({ value })] });
      // biome-ignore lint/performance/noAwaitInLoops: One delivery per amount.
      const [event] = await factsOf(completed(), api);
      expect(event?.fact).toMatchObject({
        amount: { currency: "BRL", value: text },
      });
    }
  });

  it("an installment not paid yet gives nothing, whatever the body says", async () => {
    const api = fakeApi({
      installments: [installmentOf({ status: "ACTIVE" }, { status: "ACTIVE" })],
    });
    const body = installmentWebhookBody("PIX_AUTOMATIC_COBR_COMPLETED", {
      status: "COMPLETED",
    });
    expect(await factsOf(body, api)).toEqual([]);
  });
});

describe("PIX_AUTOMATIC_COBR_REJECTED", () => {
  it.each([
    [
      "a recurring charge rejected",
      installmentOf({ status: "ACTIVE" }, { status: "REJECTED" }),
    ],
    [
      "an expired installment",
      installmentOf({ status: "EXPIRED" }, { status: "ACTIVE" }),
    ],
  ])("%s is charge_failed", async (_name, installment) => {
    const events = await factsOf(
      failed(),
      fakeApi({ installments: [installment] })
    );
    expect(events).toEqual([
      {
        fact: { occurredAt: clock, type: "charge_failed" },
        providerEventId: `PIX_AUTOMATIC_COBR_REJECTED:${INSTALLMENT_ID}`,
        providerRef: SUBSCRIPTION_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
  });

  it("a paid installment gives nothing: a forged body cannot take access away", async () => {
    const body = installmentWebhookBody("PIX_AUTOMATIC_COBR_REJECTED", {
      cobr: { status: "REJECTED" },
      status: "EXPIRED",
    });
    expect(
      await factsOf(
        body,
        fakeApi({
          installments: [
            installmentOf({ status: "COMPLETED" }, { status: "REJECTED" }),
          ],
        })
      )
    ).toEqual([]);
  });

  it("an installment still being tried gives nothing", async () => {
    const api = fakeApi({
      installments: [
        installmentOf({ status: "ACTIVE" }, { status: "FAILED_TRY" }),
      ],
    });
    expect(await factsOf(failed(), api)).toEqual([]);
  });
});

describe("events Polaris does not use", () => {
  it.each([
    [
      "PIX_AUTOMATIC_COBR_CREATED",
      installmentWebhookBody("PIX_AUTOMATIC_COBR_CREATED"),
    ],
    [
      "PIX_AUTOMATIC_COBR_APPROVED",
      installmentWebhookBody("PIX_AUTOMATIC_COBR_APPROVED"),
    ],
    [
      "PIX_AUTOMATIC_COBR_TRY_REQUESTED",
      installmentWebhookBody("PIX_AUTOMATIC_COBR_TRY_REQUESTED"),
    ],
    [
      "PIX_AUTOMATIC_COBR_TRY_REJECTED",
      installmentWebhookBody("PIX_AUTOMATIC_COBR_TRY_REJECTED"),
    ],
    ["OPENPIX:DISPUTE_CREATED", disputeWebhookBody()],
    ["PIX_TRANSACTION_REFUND_SENT_CONFIRMED", refundWebhookBody()],
    ["an unknown event", { event: "SOMETHING_NEW", globalID: SUBSCRIPTION_ID }],
  ])("%s is acknowledged without reading the API", async (_name, body) => {
    const api = fakeApi();
    expect(await factsOf(body, api)).toEqual([]);
    expect(api.calls).toEqual([]);
    expect(api.client.getSubscription).not.toHaveBeenCalled();
    expect(api.client.getInstallment).not.toHaveBeenCalled();
  });
});

describe("a subscription that is not Polaris's", () => {
  it.each([
    ["a weekly frequency", subscriptionOf({ frequency: "WEEKLY" })],
    ["an unknown frequency", subscriptionOf({ frequency: "QUARTERLY" })],
    ["another type", subscriptionOf({ type: "PIX_ONCE" })],
  ])("%s gives nothing", async (_name, subscription) => {
    for (const body of [approved(), rejected(), completed(), failed()]) {
      const api = fakeApi({
        installments: [
          installmentOf({ status: "EXPIRED" }, { status: "REJECTED" }),
        ],
        subscriptions: [
          {
            ...subscription,
            pixRecurring: { journey: "ONLY_RECURRENCY", status: "REJECTED" },
          },
        ],
      });
      // biome-ignore lint/performance/noAwaitInLoops: One delivery per body.
      expect(await factsOf(body, api)).toEqual([]);
    }
  });

  it("an installment whose subscription read back is another one gives nothing", async () => {
    const api = fakeApi();
    api.client.getSubscription = vi.fn(() =>
      Promise.resolve(
        parseProviderJson(
          JSON.stringify(subscriptionJson({ globalID: OTHER_SUBSCRIPTION_ID }))
        )
      )
    );
    expect(await factsOf(completed(), api)).toEqual([]);
  });

  it("a read back that is not the resource named gives nothing", async () => {
    const subscriptionApi = fakeApi();
    subscriptionApi.client.getSubscription = vi.fn(() =>
      Promise.resolve(
        parseProviderJson(
          JSON.stringify(subscriptionJson({ globalID: OTHER_SUBSCRIPTION_ID }))
        )
      )
    );
    expect(await factsOf(approved(), subscriptionApi)).toEqual([]);
    const installmentApi = fakeApi();
    installmentApi.client.getInstallment = vi.fn(() =>
      Promise.resolve(
        parseProviderJson(
          JSON.stringify(installmentJson({ globalID: OTHER_INSTALLMENT_ID }))
        )
      )
    );
    expect(await factsOf(completed(), installmentApi)).toEqual([]);
  });
});

describe("the webhook envelope: only the event and the resource's ID", () => {
  it("reads the name and the ID, and gives the ID decoded for the logs", () => {
    expect(readWooviWebhook(JSON.stringify(approved()))).toEqual({
      eventType: "PIX_AUTOMATIC_APPROVED",
      logId: SUBSCRIPTION_LOG_ID,
      resourceId: SUBSCRIPTION_ID,
    });
    expect(readWooviWebhook(JSON.stringify(completed()))).toEqual({
      eventType: "PIX_AUTOMATIC_COBR_COMPLETED",
      logId: INSTALLMENT_LOG_ID,
      resourceId: INSTALLMENT_ID,
    });
  });

  it("an event Polaris ignores needs no resource", () => {
    expect(readWooviWebhook(JSON.stringify(disputeWebhookBody()))).toEqual({
      eventType: "OPENPIX:DISPUTE_CREATED",
      logId: null,
      resourceId: null,
    });
    expect(readWooviWebhook(JSON.stringify(refundWebhookBody()))).toEqual({
      eventType: "PIX_TRANSACTION_REFUND_SENT_CONFIRMED",
      logId: null,
      resourceId: null,
    });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"x"'],
    ["no event", JSON.stringify({ globalID: SUBSCRIPTION_ID })],
    [
      "an event that is not text",
      JSON.stringify({ event: 1, globalID: SUBSCRIPTION_ID }),
    ],
    [
      "an event in lower case",
      JSON.stringify({
        event: "pix_automatic_approved",
        globalID: SUBSCRIPTION_ID,
      }),
    ],
    ["an event too long", JSON.stringify({ event: "A".repeat(65) })],
    [
      "no globalID on a subscription event",
      JSON.stringify({ event: "PIX_AUTOMATIC_APPROVED" }),
    ],
    [
      "no globalID on an installment event",
      JSON.stringify({ event: "PIX_AUTOMATIC_COBR_COMPLETED" }),
    ],
    [
      "an installment ID on a subscription event",
      JSON.stringify({
        event: "PIX_AUTOMATIC_APPROVED",
        globalID: INSTALLMENT_ID,
      }),
    ],
    [
      "a subscription ID on an installment event",
      JSON.stringify({
        event: "PIX_AUTOMATIC_COBR_COMPLETED",
        globalID: SUBSCRIPTION_ID,
      }),
    ],
    [
      "a globalID of another type",
      JSON.stringify({
        event: "PIX_AUTOMATIC_APPROVED",
        globalID: globalId("Customer"),
      }),
    ],
    [
      "a globalID that is a path",
      JSON.stringify({ event: "PIX_AUTOMATIC_APPROVED", globalID: "../x" }),
    ],
  ])("refuses %s", (_name, text) => {
    expect(readWooviWebhook(text)).toBeNull();
  });
});

describe("AC-1c: the providerRef comes from the resource read back, never from the body", () => {
  it("an installment event takes the subscription of the installment read back", async () => {
    const api = fakeApi();
    const body = installmentWebhookBody("PIX_AUTOMATIC_COBR_COMPLETED", {
      paymentSubscriptionGlobalID: OTHER_SUBSCRIPTION_ID,
    });
    const [event] = await factsOf(body, api);
    expect(event?.providerRef).toBe(SUBSCRIPTION_ID);
    expect(api.calls).toEqual([
      `installment:${INSTALLMENT_ID}`,
      `subscription:${SUBSCRIPTION_ID}`,
    ]);
  });

  it("a subscription event reads back the subscription the body names and nothing else", async () => {
    const api = fakeApi();
    const body = subscriptionWebhookBody("PIX_AUTOMATIC_APPROVED", {
      customer: { correlationID: OTHER_SUBSCRIPTION_ID },
      paymentSubscriptionGlobalID: OTHER_SUBSCRIPTION_ID,
    });
    const [event] = await factsOf(body, api);
    expect(event?.providerRef).toBe(SUBSCRIPTION_ID);
    expect(api.calls).toEqual([`subscription:${SUBSCRIPTION_ID}`]);
  });

  it("a forged status in the body does not change the fact: the resource decides", async () => {
    // body says paid, resource says expired: no charge_succeeded, and the failure is the resource's
    const api = fakeApi({
      installments: [
        installmentOf({ status: "EXPIRED" }, { status: "ACTIVE" }),
      ],
    });
    expect(
      await factsOf(
        installmentWebhookBody("PIX_AUTOMATIC_COBR_COMPLETED", {
          status: "COMPLETED",
        }),
        api
      )
    ).toEqual([]);
    const second = await factsOf(
      installmentWebhookBody("PIX_AUTOMATIC_COBR_REJECTED", {
        status: "COMPLETED",
      }),
      api
    );
    expect(second.map((entry) => entry.fact.type)).toEqual(["charge_failed"]);
  });

  it("the time of the fact is the clock's, not a date of the body", async () => {
    const body = installmentWebhookBody("PIX_AUTOMATIC_COBR_COMPLETED", {
      createdAt: "2001-01-01T00:00:00.000Z",
      dateGenerateCharge: "2001-01-01T00:00:00.000Z",
    });
    const [event] = await factsOf(body);
    expect(event?.fact.occurredAt).toEqual(clock);
    expect(event?.fact).toMatchObject({ periodEndsAt: monthlyEnd });
  });
});

describe("a resource the API does not find (AC-48)", () => {
  it("a subscription is an unresolved event with the decoded ID", async () => {
    const result = await deliver(approved(), fakeApi({ subscriptions: [] }));
    expect(result).toEqual({
      eventType: "PIX_AUTOMATIC_APPROVED",
      kind: "unresolved",
      occurredAt: clock,
      occurredAtClamped: true,
      providerEventId: `PIX_AUTOMATIC_APPROVED:${SUBSCRIPTION_ID}`,
      resourceId: SUBSCRIPTION_LOG_ID,
    });
  });

  it("an installment is an unresolved event with the decoded ID", async () => {
    const result = await deliver(completed(), fakeApi({ installments: [] }));
    expect(result).toEqual({
      eventType: "PIX_AUTOMATIC_COBR_COMPLETED",
      kind: "unresolved",
      occurredAt: clock,
      occurredAtClamped: true,
      providerEventId: `PIX_AUTOMATIC_COBR_COMPLETED:${INSTALLMENT_ID}`,
      resourceId: INSTALLMENT_LOG_ID,
    });
  });

  it("an installment whose subscription is missing names the subscription", async () => {
    const result = await deliver(completed(), fakeApi({ subscriptions: [] }));
    expect(result).toMatchObject({
      kind: "unresolved",
      providerEventId: `PIX_AUTOMATIC_COBR_COMPLETED:${INSTALLMENT_ID}`,
      resourceId: SUBSCRIPTION_LOG_ID,
    });
  });

  it("a provider that is down rejects, so the delivery is sent again", async () => {
    for (const body of [approved(), completed()]) {
      // biome-ignore lint/performance/noAwaitInLoops: One delivery per body.
      await expect(
        deliver(body, fakeApi({ down: true }))
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
  });
});

describe("AC-2: the event ID is the event and the globalID", () => {
  it("a webhook and the reconciliation give the same ID for the same fact", async () => {
    const subscription = pickWooviSubscription(
      parseProviderJson(JSON.stringify(subscriptionJson()))
    );
    const installment = pickWooviInstallment(
      parseProviderJson(JSON.stringify(installmentJson()))
    );
    const [byWebhook] = await factsOf(approved());
    const [paidByWebhook] = await factsOf(completed());
    const reconciled = reconcileWooviSubscription({
      installments: [installment],
      now: clock,
      subscription,
    });
    expect(reconciled.map((entry) => entry.providerEventId)).toEqual([
      byWebhook?.providerEventId,
      paidByWebhook?.providerEventId,
    ]);
    expect(reconciled.map((entry) => entry.fact.type)).toEqual([
      "trial_method_ready",
      "charge_succeeded",
    ]);
  });

  it("a redelivery gives the same ID", async () => {
    const first = await factsOf(completed());
    const again = await factsOf(completed());
    expect(again[0]?.providerEventId).toBe(first[0]?.providerEventId);
    expect(first[0]?.providerEventId).toBe(
      `PIX_AUTOMATIC_COBR_COMPLETED:${INSTALLMENT_ID}`
    );
  });

  it("two events about the same resource never share an ID", () => {
    expect(wooviEventId("PIX_AUTOMATIC_APPROVED", SUBSCRIPTION_ID)).not.toBe(
      wooviEventId("PIX_AUTOMATIC_REJECTED", SUBSCRIPTION_ID)
    );
    expect(
      wooviEventId("PIX_AUTOMATIC_COBR_COMPLETED", INSTALLMENT_ID)
    ).not.toBe(wooviEventId("PIX_AUTOMATIC_COBR_REJECTED", INSTALLMENT_ID));
    expect(wooviEventId("PIX_AUTOMATIC_APPROVED", SUBSCRIPTION_ID)).not.toBe(
      wooviEventId("PIX_AUTOMATIC_APPROVED", OTHER_SUBSCRIPTION_ID)
    );
  });

  it("a subscription approved and later cancelled gives two different IDs", async () => {
    const [first] = await factsOf(approved());
    const [second] = await factsOf(
      rejected(),
      fakeApi({ subscriptions: [subscriptionOf({ status: "INACTIVE" })] })
    );
    expect(first?.providerEventId).not.toBe(second?.providerEventId);
  });

  it("PIX_AUTOMATIC_REJECTED twice on the same globalID gives the same ID", async () => {
    const api = fakeApi({
      subscriptions: [subscriptionOf({}, { status: "REJECTED" })],
    });
    const [first] = await factsOf(rejected(), api);
    const [second] = await factsOf(rejected(), api);
    expect(second?.providerEventId).toBe(first?.providerEventId);
  });
});

describe("AC-3: nothing personal leaves the mapper", () => {
  it("the fact has only the allowed keys and no personal value, for every event", async () => {
    const cases: [Resource, Resource[], Resource[], string[]][] = [
      [
        approved(),
        [subscriptionJson()],
        [],
        ["cycleMonths", "occurredAt", "type"],
      ],
      [
        rejected(),
        [subscriptionOf({ status: "INACTIVE" })],
        [],
        ["occurredAt", "type"],
      ],
      [
        completed(),
        [subscriptionJson()],
        [installmentJson()],
        [
          "amount",
          "currency",
          "cycleMonths",
          "occurredAt",
          "periodEndsAt",
          "type",
        ],
      ],
      [
        failed(),
        [subscriptionJson()],
        [installmentOf({ status: "EXPIRED" }, { status: "REJECTED" })],
        ["occurredAt", "type"],
      ],
    ];
    for (const [body, subscriptions, installments, keys] of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: One delivery per event.
      const events = await factsOf(
        body,
        fakeApi({ installments, subscriptions })
      );
      expect(events).toHaveLength(1);
      for (const event of events) {
        expect(Object.keys(event).sort()).toEqual([
          "fact",
          "providerEventId",
          "providerRef",
          // the subscription's own `globalID`, an ID of the provider, never a person's data
          "providerSubscriptionId",
        ]);
        expect(
          Object.keys(serializeBillingFact(event.fact as BillingFact)).sort()
        ).toEqual(keys);
        const shown = JSON.stringify(event);
        for (const personal of PERSONAL_VALUES) {
          expect(shown).not.toContain(personal);
        }
      }
    }
  });

  it("an unresolved event carries only IDs", async () => {
    const result = await deliver(approved(), fakeApi({ subscriptions: [] }));
    const shown = JSON.stringify(result);
    for (const personal of PERSONAL_VALUES) {
      expect(shown).not.toContain(personal);
    }
  });

  it("the picked resources keep only the allowed keys", () => {
    const subscription = pickWooviSubscription(
      parseProviderJson(JSON.stringify(subscriptionJson()))
    );
    expect(Object.keys(subscription).sort()).toEqual([
      "authorization",
      "cycleMonths",
      "id",
      "journey",
      "status",
      "type",
    ]);
    const installment = pickWooviInstallment(
      parseProviderJson(JSON.stringify(installmentJson()))
    );
    expect(Object.keys(installment).sort()).toEqual(
      ["amount", "chargeOn", "charge", "id", "status", "subscriptionId"].sort()
    );
    for (const personal of PERSONAL_VALUES) {
      expect(JSON.stringify([subscription, installment])).not.toContain(
        personal
      );
    }
  });
});

describe("a resource out of shape is refused", () => {
  it.each([
    ["a globalID of another type", { globalID: INSTALLMENT_ID }],
    ["no globalID", { globalID: undefined }],
    ["a frequency in lower case", { frequency: "monthly" }],
    ["no status", { status: undefined }],
    ["a status that is not text", { status: 1 }],
    ["a pixRecurring that is not an object", { pixRecurring: "x" }],
  ])("a subscription with %s", async (_name, overrides) => {
    // answered whatever the ID asked, so only the shape of the answer is under test
    const api = fakeApi();
    api.client.getSubscription = vi.fn(() =>
      Promise.resolve(
        parseProviderJson(JSON.stringify(subscriptionOf(overrides)))
      )
    );
    await expect(deliver(approved(), api)).rejects.toMatchObject({
      code: "provider_response_malformed",
    });
  });

  it.each([
    ["a value that is not an integer", { value: 24.9 }],
    ["a value as text", { value: "2490" }],
    ["a negative value", { value: -5 }],
    ["a date without a zone", { dateGenerateCharge: "2026-10-27T12:00:00" }],
    [
      "a date that is not one",
      { dateGenerateCharge: "2026-13-45T12:00:00.000Z" },
    ],
    ["no subscription ID", { paymentSubscriptionGlobalID: undefined }],
    [
      "a subscription ID of another type",
      { paymentSubscriptionGlobalID: INSTALLMENT_ID },
    ],
  ])("an installment with %s", async (_name, overrides) => {
    const api = fakeApi({ installments: [installmentOf(overrides)] });
    await expect(deliver(completed(), api)).rejects.toMatchObject({
      code: "provider_response_malformed",
    });
  });
});

describe("reconcileWooviSubscription", () => {
  const subscription = () =>
    pickWooviSubscription(
      parseProviderJson(JSON.stringify(subscriptionJson()))
    );
  const installment = (overrides: Resource, cobr: Resource = {}) =>
    pickWooviInstallment(
      parseProviderJson(JSON.stringify(installmentOf(overrides, cobr)))
    );
  const idOf = (hex: string) => globalId("PaymentSubscriptionInstallment", hex);

  it("a cancelled installment is never charge_failed: cancelling must not grant grace days", () => {
    const cancelled = pickWooviSubscription(
      parseProviderJson(
        JSON.stringify(
          subscriptionJson({
            pixRecurring: { journey: "ONLY_RECURRENCY", status: "CANCELED" },
            status: "INACTIVE",
          })
        )
      )
    );
    const scheduled = installment(
      { status: "CANCELED" },
      { status: "CANCELED" }
    );
    expect(
      reconcileWooviSubscription({
        installments: [scheduled],
        now: clock,
        subscription: cancelled,
      }).map((entry) => entry.fact.type)
    ).toEqual(["subscription_cancelled"]);
  });

  it("a cancelled installment read back gives no fact for COBR_REJECTED", async () => {
    const events = await factsOf(
      failed(),
      fakeApi({
        installments: [
          installmentOf({ status: "CANCELED" }, { status: "ACTIVE" }),
        ],
      })
    );
    expect(events).toEqual([]);
  });

  it("skips an installment whose period has already ended", () => {
    const old = installment({ dateGenerateCharge: "2026-08-27T12:00:00.000Z" });
    const events = reconcileWooviSubscription({
      installments: [old],
      now: clock,
      subscription: subscription(),
    });
    // 27/08 + 1 month ended at the end of 27/09
    expect(events.map((entry) => entry.fact.type)).toEqual([
      "trial_method_ready",
    ]);
  });

  it("keeps an installment until the instant its period ends", () => {
    const current = installment({});
    const before = new Date(monthlyEnd.getTime() - 1);
    expect(
      reconcileWooviSubscription({
        installments: [current],
        now: before,
        subscription: subscription(),
      }).map((entry) => entry.fact.type)
    ).toContain("charge_succeeded");
    expect(
      reconcileWooviSubscription({
        installments: [current],
        now: monthlyEnd,
        subscription: subscription(),
      }).map((entry) => entry.fact.type)
    ).not.toContain("charge_succeeded");
  });

  it("a cancelled subscription gives subscription_cancelled", () => {
    const cancelled = pickWooviSubscription(
      parseProviderJson(JSON.stringify(subscriptionOf({ status: "INACTIVE" })))
    );
    const events = reconcileWooviSubscription({
      installments: [],
      now: clock,
      subscription: cancelled,
    });
    expect(events).toEqual([
      {
        fact: { occurredAt: clock, type: "subscription_cancelled" },
        providerEventId: `PIX_AUTOMATIC_REJECTED:${SUBSCRIPTION_ID}`,
        providerRef: SUBSCRIPTION_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);
  });

  it("orders the installments by the day of the charge, whatever the order given", () => {
    const first = installment({
      dateGenerateCharge: "2026-10-27T12:00:00.000Z",
      globalID: idOf("aaaaaaaaaaaaaaaaaaaaaaa1"),
    });
    const second = installment({
      dateGenerateCharge: "2026-11-27T12:00:00.000Z",
      globalID: idOf("aaaaaaaaaaaaaaaaaaaaaaa2"),
    });
    const third = installment({
      dateGenerateCharge: "2026-12-27T12:00:00.000Z",
      globalID: idOf("aaaaaaaaaaaaaaaaaaaaaaa0"),
    });
    const events = reconcileWooviSubscription({
      installments: [third, first, second],
      now: clock,
      subscription: pickWooviSubscription(
        parseProviderJson(
          JSON.stringify(subscriptionOf({}, { status: "CREATED" }))
        )
      ),
    });
    expect(events.map((entry) => entry.providerEventId)).toEqual(
      [first, second, third].map(
        (entry) => `PIX_AUTOMATIC_COBR_COMPLETED:${entry.id}`
      )
    );
    expect(events.map((entry) => entry.fact.type)).toEqual([
      "charge_succeeded",
      "charge_succeeded",
      "charge_succeeded",
    ]);
  });

  it("ignores an installment of another subscription", () => {
    const foreign = pickWooviInstallment(
      parseProviderJson(
        JSON.stringify(
          installmentJson({
            paymentSubscriptionGlobalID: OTHER_SUBSCRIPTION_ID,
          })
        )
      )
    );
    const events = reconcileWooviSubscription({
      installments: [foreign],
      now: clock,
      subscription: subscription(),
    });
    expect(events.map((entry) => entry.fact.type)).toEqual([
      "trial_method_ready",
    ]);
  });

  it("a failed installment gives charge_failed; the cancelled subscription follows it", () => {
    const events = reconcileWooviSubscription({
      installments: [
        installment({ status: "EXPIRED" }, { status: "REJECTED" }),
      ],
      now: clock,
      subscription: pickWooviSubscription(
        parseProviderJson(
          JSON.stringify(subscriptionOf({ status: "INACTIVE" }))
        )
      ),
    });
    expect(events.map((entry) => entry.fact.type)).toEqual([
      "charge_failed",
      "subscription_cancelled",
    ]);
  });

  it("a subscription that is not Polaris's gives nothing", () => {
    expect(
      reconcileWooviSubscription({
        installments: [installment({})],
        now: clock,
        subscription: pickWooviSubscription(
          parseProviderJson(
            JSON.stringify(subscriptionOf({ frequency: "WEEKLY" }))
          )
        ),
      })
    ).toEqual([]);
  });
});

describe("an event whose fact the resource read back does not show", () => {
  async function reports(body: Resource, api = fakeApi()) {
    const found: WooviStateNotShownReport[] = [];
    const envelope = readWooviWebhook(JSON.stringify(body));
    if (!envelope) {
      throw new Error("expected a readable webhook");
    }
    const result = await resolveWooviWebhook(api.client, envelope, clock, (r) =>
      found.push(r)
    );
    return { found, result };
  }

  it.each([
    [
      "COBR_COMPLETED of an installment not paid",
      completed(),
      fakeApi({
        installments: [
          installmentOf({ status: "ACTIVE" }, { status: "ACTIVE" }),
        ],
      }),
    ],
    [
      "COBR_REJECTED of an installment still being tried",
      failed(),
      fakeApi({
        installments: [
          installmentOf({ status: "ACTIVE" }, { status: "FAILED_TRY" }),
        ],
      }),
    ],
    ["REJECTED of a subscription still approved", rejected(), fakeApi()],
    [
      "APPROVED of a subscription still being created",
      approved(),
      fakeApi({
        subscriptions: [subscriptionOf({}, { status: "CREATED" })],
      }),
    ],
  ])("%s is reported, with no events", async (_name, body, api) => {
    const { found, result } = await reports(body, api);
    expect(result).toEqual([]);
    expect(found).toHaveLength(1);
    expect(found[0]?.subscriptionStatus).toBeDefined();
  });

  it.each([
    [
      "an approval of the journey that pays on approval",
      approved(),
      fakeApi({
        subscriptions: [subscriptionOf({}, { journey: "PAYMENT_ON_APPROVAL" })],
      }),
    ],
    [
      "the rejection of a cancelled installment",
      failed(),
      fakeApi({
        installments: [installmentOf({ status: "CANCELED" })],
      }),
    ],
    [
      "an event of a subscription that is not Polaris's",
      completed(),
      fakeApi({ subscriptions: [subscriptionOf({ frequency: "WEEKLY" })] }),
    ],
    ["an event that gives a fact", completed(), fakeApi()],
    [
      "an event Polaris does not use",
      installmentWebhookBody("PIX_AUTOMATIC_COBR_CREATED"),
      fakeApi(),
    ],
  ])("%s is not reported", async (_name, body, api) => {
    const { found } = await reports(body, api);
    expect(found).toEqual([]);
  });

  it("the payment of a cancelled installment is reported: a paid charge announced is not a cancellation", async () => {
    const { found } = await reports(
      completed(),
      fakeApi({ installments: [installmentOf({ status: "CANCELED" })] })
    );
    expect(found).toHaveLength(1);
  });

  it("carries codes and the decoded subscription ID, nothing else", async () => {
    const { found } = await reports(
      completed(),
      fakeApi({
        installments: [
          installmentOf({ status: "ACTIVE" }, { status: "ACTIVE" }),
        ],
      })
    );
    expect(found).toEqual([
      {
        authorization: "APPROVED",
        charge: "ACTIVE",
        installmentStatus: "ACTIVE",
        journey: "ONLY_RECURRENCY",
        subscriptionLogId: SUBSCRIPTION_LOG_ID,
        subscriptionStatus: "ACTIVE",
      },
    ]);
  });
});

describe("inspectWooviWebhook", () => {
  it("names the event of a body that would give a fact but has no valid globalID", () => {
    expect(
      inspectWooviWebhook(JSON.stringify({ event: "PIX_AUTOMATIC_APPROVED" }))
    ).toEqual({ envelope: null, refusedFactEvent: "PIX_AUTOMATIC_APPROVED" });
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", "[]"],
    [
      "an event without a fact",
      JSON.stringify({ event: "PIX_AUTOMATIC_COBR_CREATED" }),
    ],
    ["an event name out of pattern", JSON.stringify({ event: "approved" })],
  ])("names nothing for %s", (_name, text) => {
    expect(inspectWooviWebhook(text).refusedFactEvent).toBeNull();
  });
});
