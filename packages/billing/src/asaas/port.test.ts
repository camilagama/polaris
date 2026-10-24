import { paidPeriodEndsAt } from "@polaris/domain/billing/provider-period";
import { describe, expect, it } from "vitest";
import type { FetchInit, FetchLike } from "../http";
import type { PrepareSubscriptionInput } from "../provider-port";
import {
  NotFirstChargeError,
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

const API_BASE = /^https:\/\/api(-sandbox)?\.asaas\.com\/v3/;

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
      url: url.replace(API_BASE, ""),
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
  return `{"object":"subscription","id":"${id}","dateCreated":"2026-10-19","customer":"cus_000FAKE","value":24.90,"nextDueDate":"2026-11-19","cycle":"${cycle}","description":"Polaris Pro mensal","billingType":"CREDIT_CARD","deleted":${deleted},"status":"${status}","externalReference":null,"checkoutSession":"${CHECKOUT_ID}","creditCard":{"creditCardNumber":"1234","creditCardBrand":"VISA","creditCardToken":"${CARD_TOKEN}"}}`;
}

function payment(
  overrides: {
    created?: string;
    deleted?: boolean;
    due?: string;
    id?: string;
    invoiceUrl?: string;
    status?: string;
    subscription?: string;
  } = {}
): string {
  const {
    created = "2026-10-19",
    deleted = false,
    due = "2026-10-19",
    id = "pay_one111",
    invoiceUrl = INVOICE_URL,
    status = "CONFIRMED",
    subscription: sub = "sub_abc123",
  } = overrides;
  return `{"object":"payment","id":"${id}","dateCreated":"${created}","customer":"cus_000FAKE","subscription":"${sub}","value":24.90,"netValue":23.91,"billingType":"CREDIT_CARD","status":"${status}","dueDate":"${due}","originalDueDate":"${due}","confirmedDate":"${due}","creditCard":{"creditCardNumber":"1234","creditCardBrand":"VISA","creditCardToken":"${CARD_TOKEN}"},"invoiceUrl":"${invoiceUrl}","transactionReceiptUrl":"${INVOICE_URL}/r","externalReference":null,"deleted":${deleted},"refunds":null,"customerName":"${PAYER_NAME}","email":"${PAYER_EMAIL}","cpfCnpj":"${PAYER_TAX_ID}"}`;
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

  it("needs no payer at all: the card command sends none", async () => {
    const { calls, fetch } = fakeAsaas(checkoutCreated);
    const { payer: _payer, ...withoutPayer } = input();
    const prepared = await portWith(fetch).prepareSubscription(withoutPayer);
    expect(prepared.providerRef).toBe(CHECKOUT_ID);
    expect(calls).toHaveLength(1);
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

  it("returns the checkout ID as the reference, and a redirect handoff", async () => {
    const { fetch } = fakeAsaas(checkoutCreated);
    await expect(portWith(fetch).prepareSubscription(input())).resolves.toEqual(
      {
        checkoutId: CHECKOUT_ID,
        handoff: { kind: "redirect", url: CHECKOUT_LINK },
        providerRef: CHECKOUT_ID,
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
    await expect(portWith(fetch).cancelRenewal(CHECKOUT_ID)).resolves.toBe(
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
    await expect(portWith(fetch).cancelRenewal(CHECKOUT_ID)).resolves.toBe(
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
    await expect(portWith(fetch).cancelRenewal(CHECKOUT_ID)).resolves.toBe(
      "cancelled"
    );
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.url)).toEqual([
      "/subscriptions/sub_live01",
    ]);
  });

  it("reads the subscriptions newest first, including the deleted ones, and keeps those of the checkout", async () => {
    const { calls, fetch } = fakeAsaas(() => ({ text: list([]) }));
    await portWith(fetch).cancelRenewal(CHECKOUT_ID);
    expect(calls[0]?.url).toContain(
      "/subscriptions?includeDeleted=true&sort=dateCreated&order=desc"
    );
  });

  it("never deletes a subscription of another checkout that the list returned", async () => {
    const other = subscription({ id: "sub_other01" }).replace(
      CHECKOUT_ID,
      "bbbbbbbb-0000-4000-8000-000000000002"
    );
    const { calls, fetch } = fakeAsaas(() => ({ text: list([other]) }));
    await expect(portWith(fetch).cancelRenewal(CHECKOUT_ID)).resolves.toBe(
      "nothing_to_cancel"
    );
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("propagates an unavailable provider instead of reporting a state", async () => {
    const { fetch } = fakeAsaas(() => ({ status: 503, text: "{}" }));
    await expect(
      portWith(fetch).cancelRenewal(CHECKOUT_ID)
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

it("says it can refund, so the refund command may cancel the renewal first", () => {
  expect(portWith(fakeAsaas().fetch).refundsEnabled).toBe(true);
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
      portWith(fetch).refundCurrentPeriod(CHECKOUT_ID, NOW, null, "any_paid")
    ).resolves.toBe("nothing_to_refund");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("does nothing when the reference has no subscription", async () => {
    const { calls, fetch } = fakeAsaas(() => ({ text: list([]) }));
    await expect(
      portWith(fetch).refundCurrentPeriod(CHECKOUT_ID, NOW, null, "any_paid")
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
      portWith(fetch).refundCurrentPeriod(CHECKOUT_ID, NOW, null, "any_paid")
    ).resolves.toBe("refund_requested");
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("/payments/pay_new001/refund");
    expect(calls.indexOf(posts[0] as Call)).toBe(calls.length - 1);
  });

  describe("with the first charge recorded (the owner's refund, ADR 0104)", () => {
    const FIRST_EVENT = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const paidFirst = () =>
      fakeAsaas(
        ...withCharges(
          payment({ due: "2026-10-19", id: "pay_first1", status: "CONFIRMED" }),
          payment({ due: "2026-11-19", id: "pay_next01", status: "PENDING" })
        )
      );

    it("refunds the charge in force when it pays the first charge's period", async () => {
      const { calls, fetch } = paidFirst();

      await expect(
        portWith(fetch).refundCurrentPeriod(CHECKOUT_ID, NOW, null, {
          eventId: FIRST_EVENT,
          periodEndsAt: paidPeriodEndsAt("2026-10-19", 1),
        })
      ).resolves.toBe("refund_requested");

      const posts = calls.filter((call) => call.method === "POST");
      expect(posts.map((call) => call.url)).toEqual([
        "/payments/pay_first1/refund",
      ]);
    });

    it("refuses, asking for no refund, when the charge in force pays another period (the provider reordered)", async () => {
      const { calls, fetch } = paidFirst();

      await expect(
        portWith(fetch).refundCurrentPeriod(CHECKOUT_ID, NOW, null, {
          eventId: FIRST_EVENT,
          periodEndsAt: paidPeriodEndsAt("2026-09-19", 1),
        })
      ).rejects.toBeInstanceOf(NotFirstChargeError);

      expect(calls.some((call) => call.method === "POST")).toBe(false);
    });

    it.each([
      ["no event", { eventId: null, periodEndsAt: new Date(0) }],
      ["no period", { eventId: FIRST_EVENT, periodEndsAt: null }],
    ])(
      "refuses with %s recorded, before it reads anything from Asaas",
      async (_label, firstCharge) => {
        const { calls, fetch } = paidFirst();

        await expect(
          portWith(fetch).refundCurrentPeriod(
            CHECKOUT_ID,
            NOW,
            null,
            firstCharge
          )
        ).rejects.toBeInstanceOf(NotFirstChargeError);

        expect(calls).toEqual([]);
      }
    );
  });

  it("refunds the paid charge of a subscription already deleted (the refund command cancels the renewal first)", async () => {
    const { calls, fetch } = fakeAsaas(
      (call) =>
        call.method === "POST"
          ? { text: '{"status":"REFUND_REQUESTED"}' }
          : undefined,
      (call) =>
        call.url.includes("/subscriptions/sub_abc123/payments")
          ? {
              text: list([
                payment({
                  due: "2026-10-19",
                  id: "pay_new001",
                  status: "CONFIRMED",
                }),
              ]),
            }
          : undefined,
      (call) =>
        call.url.startsWith("/subscriptions?")
          ? {
              text: list([subscription({ deleted: true, status: "INACTIVE" })]),
            }
          : undefined
    );
    await expect(
      portWith(fetch).refundCurrentPeriod(CHECKOUT_ID, NOW, null, "any_paid")
    ).resolves.toBe("refund_requested");
    expect(
      calls.filter((call) => call.method === "POST").map((call) => call.url)
    ).toEqual(["/payments/pay_new001/refund"]);
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
      portWith(fetch).refundCurrentPeriod(CHECKOUT_ID, NOW, null, "any_paid")
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
      portWith(fetch).refundCurrentPeriod(CHECKOUT_ID, NOW, null, "any_paid")
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
      portWith(fetch).refundCurrentPeriod(CHECKOUT_ID, NOW, null, "any_paid")
    ).resolves.toBe("nothing_to_refund");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("discardCheckout", () => {
  // the shape of the sandbox answers (19/10/2026): 200 with CANCELED, then a 400 for the same checkout
  const cancelled = `{"id":"${CHECKOUT_ID}","status":"CANCELED"}`;
  const alreadyCancelled =
    '{"errors":[{"code":"invalid_action","description":"Checkout já cancelado."}]}';

  it("posts to /checkouts/<uuid>/cancel", async () => {
    const { calls, fetch } = fakeAsaas(() => ({ text: cancelled }));
    await expect(portWith(fetch).discardCheckout(CHECKOUT_ID)).resolves.toBe(
      "discarded"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`/checkouts/${CHECKOUT_ID}/cancel`);
  });

  it("is safe to repeat: a checkout cancelled before is already_closed", async () => {
    let answered = 0;
    const { calls, fetch } = fakeAsaas(() => {
      answered += 1;
      return answered === 1
        ? { text: cancelled }
        : { status: 400, text: alreadyCancelled };
    });
    const port = portWith(fetch);
    await expect(port.discardCheckout(CHECKOUT_ID)).resolves.toBe("discarded");
    await expect(port.discardCheckout(CHECKOUT_ID)).resolves.toBe(
      "already_closed"
    );
    expect(calls).toHaveLength(2);
  });

  it("a checkout the provider does not know is already_closed", async () => {
    const { fetch } = fakeAsaas(() => ({ status: 404, text: "{}" }));
    await expect(portWith(fetch).discardCheckout(CHECKOUT_ID)).resolves.toBe(
      "already_closed"
    );
  });

  it("a refused key or an outage still throws, for the caller to log", async () => {
    const refused = fakeAsaas(() => ({ status: 401, text: "{}" }));
    await expect(
      portWith(refused.fetch).discardCheckout(CHECKOUT_ID)
    ).rejects.toMatchObject({ code: "provider_rejected", status: 401 });
    const down = fakeAsaas(() => ({ status: 503, text: "{}" }));
    await expect(
      portWith(down.fetch).discardCheckout(CHECKOUT_ID)
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("never sends an ID that is not a checkout's", async () => {
    const { calls, fetch } = fakeAsaas(() => ({ text: cancelled }));
    await expect(
      portWith(fetch).discardCheckout("../payments/pay_1")
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
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
    const events = await portWith(fetch).readState(CHECKOUT_ID, now);
    expect(events).toHaveLength(1);
    expect(events[0]?.providerEventId).toBe("reconcile:pay_one111:CONFIRMED");
    expect(events[0]?.providerRef).toBe(CHECKOUT_ID);
    expect(events[0]?.providerSubscriptionId).toBe("sub_abc123");
    expect(events[0]?.fact).toEqual({
      amount: { currency: "BRL", value: "24.90" },
      cycleMonths: 1,
      occurredAt: now,
      periodEndsAt: new Date("2026-11-20T03:00:00.000Z"),
      type: "charge_succeeded",
    });
  });

  it("gives the same event IDs when the same state is read twice", async () => {
    const { fetch } = fakeAsaas(...routes(payment()));
    const port = portWith(fetch);
    const first = await port.readState(CHECKOUT_ID, now);
    const second = await port.readState(
      CHECKOUT_ID,
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
    const events = await portWith(fetch).readState(CHECKOUT_ID, now);
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
    const events = await portWith(fetch).readState(CHECKOUT_ID, now);
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
    const events = await portWith(fetch).readState(CHECKOUT_ID, now);
    expect(events.map((entry) => entry.providerEventId)).toEqual([
      "reconcile:sub_abc123:CHECKOUT_PAID",
    ]);
    expect(events[0]?.fact.type).toBe("trial_method_ready");
  });

  it("gives no fact for a period that has already ended", async () => {
    const { fetch } = fakeAsaas(
      ...routes(payment({ created: "2026-01-10", due: "2026-01-10" }))
    );
    const events = await portWith(fetch).readState(CHECKOUT_ID, now);
    expect(events).toEqual([]);
  });

  it("returns nothing when the reference has no subscription", async () => {
    const { fetch } = fakeAsaas(() => ({ text: list([]) }));
    await expect(portWith(fetch).readState(CHECKOUT_ID, now)).resolves.toEqual(
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
    const events = await portWith(fetch).readState(CHECKOUT_ID, now);
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
      portWith(fetch).readState(CHECKOUT_ID, now)
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
  });
});

describe("hasSubscription", () => {
  const listRoute =
    (items: string[]): Route =>
    (call) =>
      call.url.startsWith("/subscriptions?")
        ? { text: list(items) }
        : undefined;

  it("is true for a live subscription of the checkout even when no charge shows a fact yet", async () => {
    const { fetch } = fakeAsaas(listRoute([subscription()]));
    // the same subscription gives readState nothing to say: no charge of the period
    await expect(portWith(fetch).hasSubscription(CHECKOUT_ID)).resolves.toBe(
      true
    );
  });

  it("is true for a subscription already deleted", async () => {
    const { fetch } = fakeAsaas(
      listRoute([subscription().replace('"deleted":false', '"deleted":true')])
    );
    await expect(portWith(fetch).hasSubscription(CHECKOUT_ID)).resolves.toBe(
      true
    );
  });

  it("is false for a checkout no subscription came from", async () => {
    const { fetch } = fakeAsaas(listRoute([]));
    await expect(portWith(fetch).hasSubscription(CHECKOUT_ID)).resolves.toBe(
      false
    );
  });

  it("is false when the only subscription listed belongs to another checkout", async () => {
    const { fetch } = fakeAsaas(
      listRoute([
        subscription().replace(
          CHECKOUT_ID,
          "bbbbbbbb-0000-4000-8000-000000000002"
        ),
      ])
    );
    await expect(portWith(fetch).hasSubscription(CHECKOUT_ID)).resolves.toBe(
      false
    );
  });

  it("throws when the provider is down", async () => {
    const { fetch } = fakeAsaas(() => ({ status: 503, text: "{}" }));
    await expect(
      portWith(fetch).hasSubscription(CHECKOUT_ID)
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("overduePaymentPage", () => {
  const routes = (...charges: string[]): Route[] => [
    (call) =>
      call.url.includes("/subscriptions/sub_abc123/payments")
        ? { text: list(charges) }
        : undefined,
    (call) =>
      call.url.startsWith("/subscriptions?")
        ? { text: list([subscription()]) }
        : undefined,
  ];
  /** A port against production (a production key and base), where the sandbox's page host is not allowed. */
  const productionPort = (fetch: FetchLike) =>
    createAsaasPort({
      apiKey: "$aact_prod_FAKE_TEST_KEY",
      appBaseUrl: APP_URL,
      baseUrl: "https://api.asaas.com/v3",
      fetch,
      randomUuid: () => UUID,
      timeoutMs: 5000,
    });

  it("gives the invoiceUrl of the newest OVERDUE charge of the subscription", async () => {
    const { fetch } = fakeAsaas(
      ...routes(
        payment({
          due: "2026-08-19",
          id: "pay_old001",
          invoiceUrl: "https://sandbox.asaas.com/i/old",
          status: "OVERDUE",
        }),
        payment({
          due: "2026-10-19",
          id: "pay_new001",
          invoiceUrl: "https://sandbox.asaas.com/i/newest",
          status: "OVERDUE",
        }),
        payment({
          due: "2026-09-19",
          id: "pay_mid001",
          invoiceUrl: "https://sandbox.asaas.com/i/middle",
          status: "OVERDUE",
        }),
        payment({
          due: "2026-11-19",
          id: "pay_next01",
          invoiceUrl: "https://sandbox.asaas.com/i/pending",
          status: "PENDING",
        })
      )
    );

    await expect(
      portWith(fetch).overduePaymentPage(CHECKOUT_ID, null)
    ).resolves.toBe("https://sandbox.asaas.com/i/newest");
  });

  it("gives null when no charge is OVERDUE", async () => {
    const { calls, fetch } = fakeAsaas(
      ...routes(
        payment({ id: "pay_pend01", status: "PENDING" }),
        payment({ id: "pay_paid01", status: "CONFIRMED" })
      )
    );

    await expect(
      portWith(fetch).overduePaymentPage(CHECKOUT_ID, null)
    ).resolves.toBeNull();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("throws ProviderResponseMalformedError when the invoiceUrl is of another host", async () => {
    const { fetch } = fakeAsaas(
      ...routes(
        payment({
          invoiceUrl: "https://sandbox.asaas.com.evil.example/i/x",
          status: "OVERDUE",
        })
      )
    );

    await expect(
      portWith(fetch).overduePaymentPage(CHECKOUT_ID, null)
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
  });

  it("accepts the sandbox's page only with the sandbox's API base", async () => {
    const overdue = payment({
      invoiceUrl: "https://sandbox.asaas.com/i/abc",
      status: "OVERDUE",
    });

    await expect(
      portWith(fakeAsaas(...routes(overdue)).fetch).overduePaymentPage(
        CHECKOUT_ID,
        null
      )
    ).resolves.toBe("https://sandbox.asaas.com/i/abc");
    await expect(
      productionPort(fakeAsaas(...routes(overdue)).fetch).overduePaymentPage(
        CHECKOUT_ID,
        null
      )
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
  });

  it("accepts the production page host with the production base", async () => {
    const { fetch } = fakeAsaas(
      ...routes(
        payment({
          invoiceUrl: "https://www.asaas.com/i/abc",
          status: "OVERDUE",
        })
      )
    );

    await expect(
      productionPort(fetch).overduePaymentPage(CHECKOUT_ID, null)
    ).resolves.toBe("https://www.asaas.com/i/abc");
  });
});

describe("provider", () => {
  it("is asaas", () => {
    expect(portWith(fakeAsaas().fetch).provider).toBe("asaas");
  });
});

describe("a stored subscription ID (sub_) is read directly, never by the list scan", () => {
  const SUB = "sub_abc123";
  const OTHER_CHECKOUT = "bbbbbbbb-0000-4000-8000-000000000002";
  const now = new Date("2026-10-20T12:00:00.000Z");
  const isList = (call: Call) => call.url.startsWith("/subscriptions?");
  const isDirect = (call: Call) =>
    call.method === "GET" && call.url === `/subscriptions/${SUB}`;

  /** The provider: the direct read answers `direct`, the list answers the subscription. */
  const provider = (
    direct: { status?: number; text: string },
    listed: unknown[] = [subscription()]
  ): Route[] => [
    (call) => (isDirect(call) ? direct : undefined),
    (call) =>
      call.method === "DELETE" ? { text: '{"deleted":true}' } : undefined,
    (call) =>
      call.method === "POST"
        ? { text: '{"status":"REFUND_REQUESTED"}' }
        : undefined,
    (call) =>
      call.url.startsWith(`/subscriptions/${SUB}/payments`)
        ? { text: list([payment()]) }
        : undefined,
    (call) => (isList(call) ? { text: list(listed) } : undefined),
  ];

  const ofAnotherCheckout = subscription().replace(CHECKOUT_ID, OTHER_CHECKOUT);

  const operations = {
    cancelRenewal: (fetch: FetchLike, sub?: string) =>
      portWith(fetch).cancelRenewal(CHECKOUT_ID, sub),
    readState: (fetch: FetchLike, sub?: string) =>
      portWith(fetch).readState(CHECKOUT_ID, now, sub),
    refundCurrentPeriod: (fetch: FetchLike, sub?: string) =>
      portWith(fetch).refundCurrentPeriod(
        CHECKOUT_ID,
        now,
        sub ?? null,
        "any_paid"
      ),
  };

  describe.each(Object.entries(operations))("%s", (_name, run) => {
    it("with a matching sub_ reads only GET /subscriptions/{sub}: an old subscription beyond the newest 1000 is found, the list is never called", async () => {
      // the list would not find it (empty), the direct read does
      const { calls, fetch } = fakeAsaas(
        ...provider({ text: subscription() }, [])
      );
      await run(fetch, SUB);
      expect(calls.some(isDirect)).toBe(true);
      expect(calls.some(isList)).toBe(false);
    });

    it("with a sub_ of another checkout falls back to the list scan", async () => {
      const { calls, fetch } = fakeAsaas(
        ...provider({ text: ofAnotherCheckout })
      );
      await run(fetch, SUB);
      expect(calls.some(isDirect)).toBe(true);
      expect(calls.some(isList)).toBe(true);
    });

    it("with a sub_ the provider does not know (404) falls back to the list scan", async () => {
      const { calls, fetch } = fakeAsaas(
        ...provider({ status: 404, text: "{}" })
      );
      await run(fetch, SUB);
      expect(calls.some(isList)).toBe(true);
    });

    it("with a sub_ and the provider answering 5xx is unavailable, with no list call", async () => {
      const { calls, fetch } = fakeAsaas(
        ...provider({ status: 503, text: "{}" })
      );
      await expect(run(fetch, SUB)).rejects.toBeInstanceOf(
        ProviderUnavailableError
      );
      expect(calls.some(isList)).toBe(false);
    });

    it("without the ID reads the list scan, as before, and never the direct read", async () => {
      const { calls, fetch } = fakeAsaas(...provider({ text: subscription() }));
      await run(fetch);
      expect(calls.some(isList)).toBe(true);
      expect(calls.some(isDirect)).toBe(false);
    });
  });

  it("cancelRenewal with a matching sub_ deletes exactly that subscription", async () => {
    const { calls, fetch } = fakeAsaas(...provider({ text: subscription() }));
    await expect(operations.cancelRenewal(fetch, SUB)).resolves.toBe(
      "cancelled"
    );
    expect(
      calls.filter((call) => call.method === "DELETE").map((call) => call.url)
    ).toEqual([`/subscriptions/${SUB}`]);
  });

  it("cancelRenewal never deletes a sub_ of another checkout when the list has none of this checkout", async () => {
    const { calls, fetch } = fakeAsaas(
      (call) => (isDirect(call) ? { text: ofAnotherCheckout } : undefined),
      (call) => (isList(call) ? { text: list([]) } : undefined)
    );
    await expect(operations.cancelRenewal(fetch, SUB)).resolves.toBe(
      "nothing_to_cancel"
    );
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("readState with a matching sub_ still gives the charge fact", async () => {
    const { fetch } = fakeAsaas(...provider({ text: subscription() }));
    const events = await operations.readState(fetch, SUB);
    expect(events.map((entry) => entry.fact.type)).toEqual([
      "charge_succeeded",
    ]);
  });
});
