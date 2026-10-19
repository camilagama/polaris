import { describe, expect, it } from "vitest";
import type { FetchInit, FetchLike } from "../http";
import type { PrepareSubscriptionInput } from "../provider-port";
import {
  ProviderResponseMalformedError,
  ProviderUnavailableError,
} from "../provider-port";
import { checkoutReturnUrls, createAsaasPort } from "./port";

const BASE_URL = "https://api-sandbox.asaas.com/v3";
const APP_URL = "https://app.example.test";
const UUID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const REFERENCE = `pol_${UUID}`;
const CHECKOUT_ID = "7a1d5c20-3b4e-4f60-9a8b-0c1d2e3f4a5b";
const CHECKOUT_LINK = `https://sandbox.asaas.com/checkoutSession/show?id=${CHECKOUT_ID}`;
const PAYER_NAME = "Maria Fictícia da Silva";
const PAYER_EMAIL = "maria.ficticia@example.com";
const PAYER_TAX_ID = "529.982.247-25";
const CARD_TOKEN = "tok_FAKE_0000-1111-2222";
const INVOICE_URL = "https://sandbox.asaas.com/i/fake_invoice_abc";

interface Call {
  body?: string;
  headers: Record<string, string>;
  method: string;
  url: string;
}

type Route = (call: Call) => { status?: number; text: string } | undefined;

/** A fake fetch that records every call and answers by the first route that matches. */
function fakeAsaas(...routes: Route[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init: FetchInit) => {
    const call: Call = {
      headers: init.headers,
      method: init.method,
      url: url.replace(BASE_URL, ""),
      ...(init.body === undefined ? {} : { body: init.body }),
    };
    calls.push(call);
    for (const route of routes) {
      const answer = route(call);
      if (answer) {
        return Promise.resolve({
          status: answer.status ?? 200,
          text: () => Promise.resolve(answer.text),
        });
      }
    }
    return Promise.resolve({ status: 404, text: () => Promise.resolve("{}") });
  };
  return { calls, fetch };
}

function portWith(fetch: FetchLike, appBaseUrl = APP_URL) {
  return createAsaasPort({
    apiKey: "$aact_hmlg_FAKE_TEST_KEY",
    appBaseUrl,
    baseUrl: BASE_URL,
    fetch,
    randomUuid: () => UUID,
    timeoutMs: 5000,
  });
}

function list(items: unknown[], hasMore = false): string {
  return `{"object":"list","hasMore":${hasMore},"totalCount":${items.length},"limit":100,"offset":0,"data":[${items.join(",")}]}`;
}

function subscription(
  overrides: {
    deleted?: boolean;
    id?: string;
    status?: string;
    cycle?: string;
  } = {}
): string {
  const {
    deleted = false,
    id = "sub_abc123",
    status = "ACTIVE",
    cycle = "MONTHLY",
  } = overrides;
  return `{"object":"subscription","id":"${id}","dateCreated":"2026-10-19","customer":"cus_000FAKE","value":24.90,"nextDueDate":"2026-11-19","cycle":"${cycle}","description":"Polaris Pro mensal","billingType":"CREDIT_CARD","deleted":${deleted},"status":"${status}","externalReference":"${REFERENCE}","checkoutSession":"${CHECKOUT_ID}","creditCard":{"creditCardNumber":"1234","creditCardBrand":"VISA","creditCardToken":"${CARD_TOKEN}"}}`;
}

function payment(
  overrides: {
    created?: string;
    deleted?: boolean;
    due?: string;
    id?: string;
    status?: string;
    subscription?: string;
  } = {}
): string {
  const {
    created = "2026-10-19",
    deleted = false,
    due = "2026-10-19",
    id = "pay_one111",
    status = "CONFIRMED",
    subscription: sub = "sub_abc123",
  } = overrides;
  return `{"object":"payment","id":"${id}","dateCreated":"${created}","customer":"cus_000FAKE","subscription":"${sub}","value":24.90,"netValue":23.91,"billingType":"CREDIT_CARD","status":"${status}","dueDate":"${due}","originalDueDate":"${due}","confirmedDate":"${due}","creditCard":{"creditCardNumber":"1234","creditCardBrand":"VISA","creditCardToken":"${CARD_TOKEN}"},"invoiceUrl":"${INVOICE_URL}","transactionReceiptUrl":"${INVOICE_URL}/r","externalReference":"${REFERENCE}","deleted":${deleted},"refunds":null,"customerName":"${PAYER_NAME}","email":"${PAYER_EMAIL}","cpfCnpj":"${PAYER_TAX_ID}"}`;
}

const input = (
  overrides: Partial<PrepareSubscriptionInput> = {}
): PrepareSubscriptionInput => ({
  amount: "24.90",
  cycleMonths: 1,
  firstChargeOn: "2026-11-02",
  payer: { email: PAYER_EMAIL, name: PAYER_NAME },
  ...overrides,
});

const checkoutCreated: Route = (call) =>
  call.method === "POST" && call.url === "/checkouts"
    ? {
        text: `{"id":"${CHECKOUT_ID}","link":"${CHECKOUT_LINK}","status":"ACTIVE"}`,
      }
    : undefined;

describe("checkoutReturnUrls", () => {
  it("builds the three URLs on the origin of the app", () => {
    expect(
      checkoutReturnUrls("https://app.example.test/qualquer/caminho?x=1")
    ).toEqual({
      cancelUrl: "https://app.example.test/?assinatura=cancelada",
      returnUrl: "https://app.example.test/?assinatura=expirada",
      successUrl: "https://app.example.test/?assinatura=concluida",
    });
  });

  it("allows http on localhost", () => {
    expect(checkoutReturnUrls("http://localhost:5173").successUrl).toBe(
      "http://localhost:5173/?assinatura=concluida"
    );
  });

  it.each(["http://app.example.test", "not a url", "", "javascript:alert(1)"])(
    "refuses the base %j",
    (base) => {
      expect(() => checkoutReturnUrls(base)).toThrow(TypeError);
    }
  );
});

describe("prepareSubscription", () => {
  it("posts the checkout to /v3/checkouts with the opaque reference", async () => {
    const { calls, fetch } = fakeAsaas(checkoutCreated);
    await portWith(fetch).prepareSubscription(input());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/checkouts");
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.externalReference).toBe(REFERENCE);
    expect(body.billingTypes).toEqual(["CREDIT_CARD"]);
    expect(body.chargeTypes).toEqual(["RECURRENT"]);
    expect(body.subscription.nextDueDate).toBe("2026-11-02 00:00:00");
  });

  it.each([
    [1, "MONTHLY"],
    [6, "SEMIANNUALLY"],
    [12, "YEARLY"],
  ] as const)("maps %i months to the Asaas cycle %s", async (months, cycle) => {
    const { calls, fetch } = fakeAsaas(checkoutCreated);
    await portWith(fetch).prepareSubscription(input({ cycleMonths: months }));
    expect(JSON.parse(calls[0]?.body ?? "").subscription.cycle).toBe(cycle);
  });

  it("writes the catalog price as a JSON number with its exact text", async () => {
    const { calls, fetch } = fakeAsaas(checkoutCreated);
    await portWith(fetch).prepareSubscription(input({ amount: "24.90" }));
    expect(calls[0]?.body).toContain('"value":24.90');
    expect(calls[0]?.body).not.toContain('"value":"');
  });

  it("writes another catalog price with its own text (AC-42)", async () => {
    const { calls, fetch } = fakeAsaas(checkoutCreated);
    await portWith(fetch).prepareSubscription(
      input({ amount: "249.00", cycleMonths: 12 })
    );
    expect(calls[0]?.body).toContain('"value":249.00');
    expect(calls[0]?.body).not.toContain("24.90");
  });

  it("builds the callback from the app base URL", async () => {
    const { calls, fetch } = fakeAsaas(checkoutCreated);
    await portWith(fetch).prepareSubscription(input());
    expect(JSON.parse(calls[0]?.body ?? "").callback).toEqual({
      cancelUrl: "https://app.example.test/?assinatura=cancelada",
      expiredUrl: "https://app.example.test/?assinatura=expirada",
      successUrl: "https://app.example.test/?assinatura=concluida",
    });
  });

  it("sends no name, e-mail or tax ID of the payer", async () => {
    const { calls, fetch } = fakeAsaas(checkoutCreated);
    await portWith(fetch).prepareSubscription(input());
    const body = calls[0]?.body ?? "";
    expect(body).not.toContain(PAYER_NAME);
    expect(body).not.toContain(PAYER_EMAIL);
    expect(body).not.toContain("example.com");
    expect(body).not.toContain("529");
    expect(body).not.toContain("customerData");
  });

  it("refuses a payer with a tax ID before calling fetch", async () => {
    const { calls, fetch } = fakeAsaas(checkoutCreated);
    await expect(
      portWith(fetch).prepareSubscription(
        input({
          payer: { email: PAYER_EMAIL, name: PAYER_NAME, taxId: PAYER_TAX_ID },
        })
      )
    ).rejects.toThrow("tax_id_not_accepted_for_card");
    expect(calls).toHaveLength(0);
  });

  it("refuses an invalid first charge date, amount or app URL before calling fetch", async () => {
    const { calls, fetch } = fakeAsaas(checkoutCreated);
    const port = portWith(fetch);
    await expect(
      port.prepareSubscription(input({ firstChargeOn: "2026-02-30" }))
    ).rejects.toThrow();
    await expect(
      port.prepareSubscription(input({ amount: "0.00" }))
    ).rejects.toThrow();
    await expect(
      portWith(fetch, "http://app.example.test").prepareSubscription(input())
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("returns the reference, the checkout ID and a redirect handoff", async () => {
    const { fetch } = fakeAsaas(checkoutCreated);
    await expect(portWith(fetch).prepareSubscription(input())).resolves.toEqual(
      {
        checkoutId: CHECKOUT_ID,
        handoff: { kind: "redirect", url: CHECKOUT_LINK },
        providerRef: REFERENCE,
      }
    );
  });

  it.each([
    ["http", `http://sandbox.asaas.com/checkoutSession/show?id=${CHECKOUT_ID}`],
    [
      "another host",
      `https://evil.example.test/checkoutSession/show?id=${CHECKOUT_ID}`,
    ],
    ["a look-alike host", "https://sandbox.asaas.com.evil.test/x"],
    ["a suffix host", "https://notasaas.com/x"],
    ["not a URL", "sandbox.asaas.com/x"],
  ])("refuses a checkout link with %s", async (_name, link) => {
    const { fetch } = fakeAsaas(() => ({
      text: `{"id":"${CHECKOUT_ID}","link":"${link}"}`,
    }));
    await expect(
      portWith(fetch).prepareSubscription(input())
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
  });

  it("accepts the bare asaas.com host and any subdomain", async () => {
    const { fetch } = fakeAsaas(() => ({
      text: `{"id":"${CHECKOUT_ID}","link":"https://asaas.com/c/x"}`,
    }));
    const prepared = await portWith(fetch).prepareSubscription(input());
    expect(prepared.handoff).toEqual({
      kind: "redirect",
      url: "https://asaas.com/c/x",
    });
  });

  it("refuses a checkout answer without a UUID ID", async () => {
    const { fetch } = fakeAsaas(() => ({
      text: `{"id":"chk_1","link":"${CHECKOUT_LINK}"}`,
    }));
    await expect(
      portWith(fetch).prepareSubscription(input())
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
  });
});

describe("cancelRenewal", () => {
  it("does nothing when no subscription carries the reference", async () => {
    const { calls, fetch } = fakeAsaas(() => ({ text: list([]) }));
    await expect(portWith(fetch).cancelRenewal(REFERENCE)).resolves.toBe(
      "nothing_to_cancel"
    );
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reports already_cancelled when every subscription is deleted", async () => {
    const { calls, fetch } = fakeAsaas(() => ({
      text: list([
        subscription({ deleted: true, id: "sub_old001" }),
        subscription({ deleted: true, id: "sub_old002" }),
      ]),
    }));
    await expect(portWith(fetch).cancelRenewal(REFERENCE)).resolves.toBe(
      "already_cancelled"
    );
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("deletes the live subscription and only it", async () => {
    const { calls, fetch } = fakeAsaas(
      (call) =>
        call.method === "DELETE"
          ? { text: '{"deleted":true,"id":"sub_live01"}' }
          : undefined,
      () => ({
        text: list([
          subscription({ deleted: true, id: "sub_old001" }),
          subscription({ id: "sub_live01" }),
        ]),
      })
    );
    await expect(portWith(fetch).cancelRenewal(REFERENCE)).resolves.toBe(
      "cancelled"
    );
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.url)).toEqual([
      "/subscriptions/sub_live01",
    ]);
  });

  it("reads the subscriptions by reference including the deleted ones", async () => {
    const { calls, fetch } = fakeAsaas(() => ({ text: list([]) }));
    await portWith(fetch).cancelRenewal(REFERENCE);
    expect(calls[0]?.url).toContain(
      `externalReference=${encodeURIComponent(REFERENCE)}&includeDeleted=true`
    );
  });

  it("propagates an unavailable provider instead of reporting a state", async () => {
    const { fetch } = fakeAsaas(() => ({ status: 503, text: "{}" }));
    await expect(
      portWith(fetch).cancelRenewal(REFERENCE)
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("refundCurrentPeriod", () => {
  const NOW = new Date("2026-10-25T12:00:00.000Z");
  const withCharges = (...charges: string[]): Route[] => [
    (call) =>
      call.method === "POST"
        ? { text: '{"status":"REFUND_REQUESTED"}' }
        : undefined,
    (call) =>
      call.url.includes("/subscriptions/sub_abc123/payments")
        ? { text: list(charges) }
        : undefined,
    (call) =>
      call.url.startsWith("/subscriptions?")
        ? { text: list([subscription()]) }
        : undefined,
  ];

  it("reads the charges before and does not refund when none is paid", async () => {
    const { calls, fetch } = fakeAsaas(
      ...withCharges(
        payment({ id: "pay_pend01", status: "PENDING" }),
        payment({ due: "2026-09-19", id: "pay_over01", status: "OVERDUE" })
      )
    );
    await expect(
      portWith(fetch).refundCurrentPeriod(REFERENCE, NOW)
    ).resolves.toBe("nothing_to_refund");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("does nothing when the reference has no subscription", async () => {
    const { calls, fetch } = fakeAsaas(() => ({ text: list([]) }));
    await expect(
      portWith(fetch).refundCurrentPeriod(REFERENCE, NOW)
    ).resolves.toBe("nothing_to_refund");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("refunds the most recent paid charge by original due date", async () => {
    const { calls, fetch } = fakeAsaas(
      ...withCharges(
        payment({ due: "2026-08-19", id: "pay_old001", status: "RECEIVED" }),
        payment({ due: "2026-10-19", id: "pay_new001", status: "CONFIRMED" }),
        payment({ due: "2026-09-19", id: "pay_mid001", status: "CONFIRMED" }),
        payment({ due: "2026-11-19", id: "pay_next01", status: "PENDING" })
      )
    );
    await expect(
      portWith(fetch).refundCurrentPeriod(REFERENCE, NOW)
    ).resolves.toBe("refund_requested");
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("/payments/pay_new001/refund");
    expect(calls.indexOf(posts[0] as Call)).toBe(calls.length - 1);
  });

  it("never falls back to an earlier charge when the current one is already being refunded", async () => {
    const { calls, fetch } = fakeAsaas(
      ...withCharges(
        payment({ due: "2026-09-19", id: "pay_mid001", status: "CONFIRMED" }),
        payment({
          due: "2026-10-19",
          id: "pay_new001",
          status: "REFUND_REQUESTED",
        })
      )
    );
    await expect(
      portWith(fetch).refundCurrentPeriod(REFERENCE, NOW)
    ).resolves.toBe("nothing_to_refund");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("does not refund a charge whose period is over", async () => {
    const { calls, fetch } = fakeAsaas(
      ...withCharges(
        payment({ due: "2026-08-19", id: "pay_old001", status: "CONFIRMED" }),
        payment({ due: "2026-09-19", id: "pay_over01", status: "OVERDUE" })
      )
    );
    await expect(
      portWith(fetch).refundCurrentPeriod(REFERENCE, NOW)
    ).resolves.toBe("nothing_to_refund");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("ignores a deleted charge and a charge of another subscription", async () => {
    const { calls, fetch } = fakeAsaas(
      ...withCharges(
        payment({ deleted: true, id: "pay_del001", status: "CONFIRMED" }),
        payment({
          id: "pay_oth001",
          status: "CONFIRMED",
          subscription: "sub_other1",
        })
      )
    );
    await expect(
      portWith(fetch).refundCurrentPeriod(REFERENCE, NOW)
    ).resolves.toBe("nothing_to_refund");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("discardCheckout", () => {
  it("posts to /checkouts/<uuid>/cancel", async () => {
    const { calls, fetch } = fakeAsaas(() => ({ text: "{}" }));
    await portWith(fetch).discardCheckout(CHECKOUT_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`/checkouts/${CHECKOUT_ID}/cancel`);
  });
});

describe("readState", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const routes = (...charges: string[]): Route[] => [
    (call) =>
      call.url.startsWith("/subscriptions/sub_abc123/payments")
        ? { text: list(charges) }
        : undefined,
    (call) =>
      call.url.startsWith("/subscriptions?")
        ? { text: list([subscription()]) }
        : undefined,
  ];

  it("returns a charge_succeeded fact with a reconcile event ID", async () => {
    const { fetch } = fakeAsaas(...routes(payment()));
    const events = await portWith(fetch).readState(REFERENCE, now);
    expect(events).toHaveLength(1);
    expect(events[0]?.providerEventId).toBe("reconcile:pay_one111:CONFIRMED");
    expect(events[0]?.providerRef).toBe(REFERENCE);
    expect(events[0]?.fact).toEqual({
      cycleMonths: 1,
      occurredAt: now,
      periodEndsAt: new Date("2026-11-20T03:00:00.000Z"),
      type: "charge_succeeded",
    });
  });

  it("gives the same event IDs when the same state is read twice", async () => {
    const { fetch } = fakeAsaas(...routes(payment()));
    const port = portWith(fetch);
    const first = await port.readState(REFERENCE, now);
    const second = await port.readState(
      REFERENCE,
      new Date("2026-10-21T08:00:00.000Z")
    );
    expect(second.map((entry) => entry.providerEventId)).toEqual(
      first.map((entry) => entry.providerEventId)
    );
  });

  it("reports a failed charge and a refunded charge by status", async () => {
    const { fetch } = fakeAsaas(
      ...routes(
        payment({ due: "2026-10-19", id: "pay_over01", status: "OVERDUE" }),
        payment({ due: "2026-10-18", id: "pay_ref001", status: "REFUNDED" })
      )
    );
    const events = await portWith(fetch).readState(REFERENCE, now);
    const ids = events.map((entry) => entry.providerEventId);
    expect(ids).toContain("reconcile:pay_over01:OVERDUE");
    expect(ids).toContain("reconcile:pay_ref001:REFUNDED");
  });

  it("reports the cancellation of a deleted subscription", async () => {
    const { fetch } = fakeAsaas(
      (call) =>
        call.url.startsWith("/subscriptions/sub_abc123/payments")
          ? { text: list([]) }
          : undefined,
      (call) =>
        call.url.startsWith("/subscriptions?")
          ? { text: list([subscription({ deleted: true })]) }
          : undefined
    );
    const events = await portWith(fetch).readState(REFERENCE, now);
    expect(events.map((entry) => entry.providerEventId)).toEqual([
      "reconcile:sub_abc123:DELETED",
    ]);
    expect(events[0]?.fact.type).toBe("subscription_cancelled");
  });

  it("reports a trial whose method is ready when the first charge falls due later", async () => {
    const { fetch } = fakeAsaas(
      ...routes(
        payment({ created: "2026-10-19", due: "2026-11-02", status: "PENDING" })
      )
    );
    const events = await portWith(fetch).readState(REFERENCE, now);
    expect(events.map((entry) => entry.providerEventId)).toEqual([
      "reconcile:sub_abc123:CHECKOUT_PAID",
    ]);
    expect(events[0]?.fact.type).toBe("trial_method_ready");
  });

  it("gives no fact for a period that has already ended", async () => {
    const { fetch } = fakeAsaas(
      ...routes(payment({ created: "2026-01-10", due: "2026-01-10" }))
    );
    const events = await portWith(fetch).readState(REFERENCE, now);
    expect(events).toEqual([]);
  });

  it("returns nothing when the reference has no subscription", async () => {
    const { fetch } = fakeAsaas(() => ({ text: list([]) }));
    await expect(portWith(fetch).readState(REFERENCE, now)).resolves.toEqual(
      []
    );
  });

  it("keeps no card token, invoice URL, name, e-mail or tax ID in any fact", async () => {
    const { fetch } = fakeAsaas(
      ...routes(
        payment(),
        payment({ due: "2026-10-19", id: "pay_over01", status: "OVERDUE" })
      )
    );
    const events = await portWith(fetch).readState(REFERENCE, now);
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(CARD_TOKEN);
    expect(serialized).not.toContain("creditCard");
    expect(serialized).not.toContain("invoice");
    expect(serialized).not.toContain(INVOICE_URL);
    expect(serialized).not.toContain(PAYER_NAME);
    expect(serialized).not.toContain(PAYER_EMAIL);
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain(PAYER_TAX_ID);
    expect(serialized).not.toContain("cus_000FAKE");
  });

  it("refuses a malformed charge instead of guessing", async () => {
    const { fetch } = fakeAsaas(
      ...routes('{"id":"pay_bad001","value":"24.90"}')
    );
    await expect(
      portWith(fetch).readState(REFERENCE, now)
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
  });
});

describe("provider", () => {
  it("is asaas", () => {
    expect(portWith(fakeAsaas().fetch).provider).toBe("asaas");
  });
});
