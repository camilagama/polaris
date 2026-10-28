import { describe, expect, it } from "vitest";
import type { FetchInit, FetchLike } from "../http";
import { parseProviderJson } from "../json";
import {
  NotFirstChargeError,
  type PrepareSubscriptionInput,
  ProviderNotConfiguredError,
  ProviderNotFoundError,
  ProviderResponseMalformedError,
  ProviderUnavailableError,
} from "../provider-port";
import { WooviCustomerMismatchError } from "./customer";
import {
  installmentPeriodEndsAt,
  pickWooviInstallment,
  pickWooviSubscription,
  reconcileWooviSubscription,
} from "./mapper";
import { createWooviPort, type WooviPortConfig } from "./port";
import {
  INSTALLMENT_ID,
  installmentJson,
  OTHER_INSTALLMENT_ID,
  PERSONAL_VALUES,
  SUBSCRIPTION_ID,
  subscriptionBeforeApprovalJson,
  subscriptionJson,
} from "./test-fixtures";

const BASE_URL = "https://api.woovi-sandbox.com";
const UUID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const CPF = "52998224725";
const OTHER_CPF = "11144477735";
const PAYER_NAME = "Pagadora de Teste";
const PAYER_EMAIL = "pagador.teste@example.com";
const CUSTOMER_KEY = "polaris-payer-0123456789abcdef0123456789abcdef";
const CUSTOMER_PATH = `/api/v1/customer/${CUSTOMER_KEY}`;
const END_TO_END_ID = "E00000000202610271200FAKE0000001";
const FAKE_EMV =
  "00020126FAKE0000PIXAUTOMATICO5204000053039865802BR5909POLARISFK6009SAO PAULO62070503***6304ABCD";
/** Inside the period of the installment charged on `2026-10-27`. */
const NOW = new Date("2026-10-28T15:00:00.000Z");
const encoded = (id: string) => encodeURIComponent(id);
const SUBSCRIPTION_PATH = `/api/v1/subscriptions/${encoded(SUBSCRIPTION_ID)}`;
const INSTALLMENTS_PATH = `${SUBSCRIPTION_PATH}/installments?skip=0&limit=100`;

interface Call {
  body?: string;
  method: string;
  /** Path and query, without the host. */
  url: string;
}

type Answer = { status?: number; text: string } | undefined;
type Route = (call: Call) => Answer;

/** A fake fetch that records every call and answers by the first route that matches. */
function fakeWoovi(...routes: Route[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init: FetchInit) => {
    const call: Call = {
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

const json = (value: unknown): Answer => ({ text: JSON.stringify(value) });

function on(
  method: string,
  url: string,
  answer: Answer | (() => Answer)
): Route {
  return (call) => {
    if (call.method !== method || call.url !== url) {
      return;
    }
    return typeof answer === "function" ? answer() : answer;
  };
}

const getSubscription = (overrides: Record<string, unknown> = {}) =>
  on(
    "GET",
    SUBSCRIPTION_PATH,
    json({ subscription: subscriptionJson(overrides) })
  );
const getInstallments = (...installments: Record<string, unknown>[]) =>
  on("GET", INSTALLMENTS_PATH, json({ installments }));
const cancelRoute = () =>
  on("PUT", `${SUBSCRIPTION_PATH}/cancel`, json({ subscription: {} }));
const refundRoute = () => on("POST", "/api/v1/refund", json({ refund: {} }));

function portWith(fetch: FetchLike, overrides: Partial<WooviPortConfig> = {}) {
  return createWooviPort({
    appId: "fake-app-id-0123",
    baseUrl: BASE_URL,
    fetch,
    randomUuid: () => UUID,
    timeoutMs: 5000,
    ...overrides,
  });
}

async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected_failure");
}

/** What an error or a result shows when logged or serialized. */
function shown(value: unknown): string {
  const error = value instanceof Error ? value : undefined;
  return `${error?.message ?? ""} ${error?.stack ?? ""} ${JSON.stringify(value)}`;
}

describe("prepareSubscription", () => {
  const input = (
    overrides: Partial<PrepareSubscriptionInput> = {}
  ): PrepareSubscriptionInput => ({
    amount: "24.90",
    cycleMonths: 1,
    firstChargeOn: "2026-11-03",
    payer: {
      customerKey: CUSTOMER_KEY,
      email: `  ${PAYER_EMAIL} `,
      name: `  ${PAYER_NAME}  `,
      taxId: CPF,
    },
    trial: true,
    ...overrides,
  });

  const storedCustomer = (overrides: Record<string, unknown> = {}) => ({
    correlationID: CUSTOMER_KEY,
    email: PAYER_EMAIL,
    name: PAYER_NAME,
    taxID: { taxID: CPF, type: "BR:CPF" },
    ...overrides,
  });
  /** The customer Woovi holds under the key; by default the payer's own (one read, no creation). */
  const findCustomer = (customer: Record<string, unknown> = storedCustomer()) =>
    on("GET", CUSTOMER_PATH, json({ customer }));
  /** Woovi's answer to a key it does not know. */
  const absentCustomer = () =>
    on("GET", CUSTOMER_PATH, {
      status: 400,
      text: JSON.stringify({ error: "Cliente não encontrado" }),
    });
  const createCustomerRoute = (answer?: Answer) =>
    on(
      "POST",
      "/api/v1/customer",
      answer ?? json({ customer: storedCustomer() })
    );
  const createRoute = (answer?: Answer) =>
    on(
      "POST",
      "/api/v1/subscriptions",
      answer ?? json({ subscription: subscriptionBeforeApprovalJson() })
    );
  const patchRoute = () =>
    on("PATCH", CUSTOMER_PATH, json({ customer: storedCustomer() }));
  const woovi = (...routes: Route[]) => fakeWoovi(...routes);
  const postOf = (calls: Call[]) =>
    calls.find(
      (call) => call.method === "POST" && call.url === "/api/v1/subscriptions"
    ) as Call;
  const requests = (calls: Call[]) =>
    calls.map((call) => `${call.method} ${call.url}`);

  it("with the trial, creates a journey 2 subscription with the exact body", async () => {
    const { calls, fetch } = woovi(findCustomer(), createRoute());

    await portWith(fetch).prepareSubscription(input());

    const body = postOf(calls).body ?? "";
    expect(postOf(calls).url).toBe("/api/v1/subscriptions");
    // the amount is an integer JSON number of cents, in the raw text
    expect(body).toContain('"value":2490');
    expect(body).not.toContain("2490.");
    expect(body).not.toContain('"value":"');
    expect(JSON.parse(body)).toEqual({
      comment: "Polaris Pro mensal",
      correlationID: `pol_${UUID}`,
      customer: { email: PAYER_EMAIL, name: PAYER_NAME, taxID: CPF },
      dayGenerateCharge: "2026-11-03T12:00:00.000Z",
      frequency: "MONTHLY",
      name: "Polaris Pro mensal",
      pixRecurringOptions: {
        journey: "ONLY_RECURRENCY",
        retryPolicy: "THREE_RETRIES_7_DAYS",
      },
      type: "PIX_RECURRING",
      value: 2490,
    });
  });

  it("without the trial, the journey is PAYMENT_ON_APPROVAL", async () => {
    const { calls, fetch } = woovi(findCustomer(), createRoute());

    await portWith(fetch).prepareSubscription(
      input({ firstChargeOn: "2026-10-20", trial: false })
    );

    const body = JSON.parse(postOf(calls).body ?? "") as {
      dayGenerateCharge: string;
      pixRecurringOptions: { journey: string };
    };
    expect(body.pixRecurringOptions.journey).toBe("PAYMENT_ON_APPROVAL");
    expect(body.dayGenerateCharge).toBe("2026-10-20T12:00:00.000Z");
  });

  it.each([
    [1, "MONTHLY", "Polaris Pro mensal"],
    [12, "ANNUALLY", "Polaris Pro anual"],
  ] as const)(
    "a %i-month cycle is %s",
    async (cycleMonths, frequency, name) => {
      const { calls, fetch } = woovi(findCustomer(), createRoute());

      await portWith(fetch).prepareSubscription(
        input({ amount: "249.00", cycleMonths })
      );

      const body = postOf(calls).body ?? "";
      expect(body).toContain('"value":24900');
      expect(JSON.parse(body)).toMatchObject({ frequency, name });
    }
  );

  it("gives the globalID as providerRef and checkoutId, and the handoff", async () => {
    const { fetch } = woovi(
      findCustomer(),
      createRoute(
        json({
          subscription: subscriptionBeforeApprovalJson({
            paymentLink: "https://woovi-sandbox.com/pay/fake-link-0001",
          }),
        })
      )
    );

    const prepared = await portWith(fetch).prepareSubscription(input());

    expect(prepared.providerRef).toBe(SUBSCRIPTION_ID);
    expect(prepared.checkoutId).toBe(SUBSCRIPTION_ID);
    expect(prepared.handoff).toEqual({
      emv: FAKE_EMV,
      kind: "pix_authorization",
      url: "https://woovi-sandbox.com/pay/fake-link-0001",
    });
  });

  it.each([
    ["https://woovi.com/pay/x", "https://woovi.com/pay/x"],
    ["https://app.woovi.com/pay/x", "https://app.woovi.com/pay/x"],
    ["https://woovi-sandbox.com/pay/x", "https://woovi-sandbox.com/pay/x"],
    ["https://openpix.com.br/pay/x", "https://openpix.com.br/pay/x"],
    ["https://pay.openpix.com.br/x", "https://pay.openpix.com.br/x"],
    ["sandbox-pix-abc123/def456", null],
    ["http://woovi.com/pay/x", null],
    ["https://woovi.com.evil.example/pay/x", null],
    ["https://evilwoovi.com/pay/x", null],
    ["https://user:pass@woovi.com/pay/x", null],
    ["https://woovi.com:8443/pay/x", null],
    ["javascript:alert(1)", null],
    ["", null],
  ])("the paymentLink %j becomes the url %j", async (paymentLink, url) => {
    const { fetch } = woovi(
      findCustomer(),
      createRoute(
        json({ subscription: subscriptionBeforeApprovalJson({ paymentLink }) })
      )
    );

    const prepared = await portWith(fetch).prepareSubscription(input());

    expect(prepared.handoff).toMatchObject({ url });
  });

  it("a response without paymentLink has no url", async () => {
    const { paymentLink: _link, ...bare } = subscriptionBeforeApprovalJson();
    const { fetch } = woovi(
      findCustomer(),
      createRoute(json({ subscription: bare }))
    );

    expect(
      (await portWith(fetch).prepareSubscription(input())).handoff
    ).toMatchObject({ url: null });
  });

  it("customer that exists and is the same: one read by the key, no list, no write, and the subscription is created", async () => {
    const { calls, fetch } = woovi(findCustomer(), createRoute());

    const prepared = await portWith(fetch).prepareSubscription(input());

    expect(prepared.customerAlignment).toBe("matches");
    expect(requests(calls)).toEqual([
      `GET ${CUSTOMER_PATH}`,
      "POST /api/v1/subscriptions",
    ]);
    expect(calls.filter((call) => call.url.includes("/customer"))).toHaveLength(
      1
    );
    // no list read: nothing of /customer without an ID, nothing of a list of subscriptions
    expect(
      calls.some(
        (call) =>
          call.method === "GET" &&
          (call.url.startsWith("/api/v1/customer?") ||
            call.url === "/api/v1/customer" ||
            call.url.startsWith("/api/v1/subscriptions"))
      )
    ).toBe(false);
    // the CPF is in no URL
    for (const call of calls) {
      expect(call.url).not.toContain(CPF);
    }
  });

  it("customer absent: reads once by the key, creates it with the key, then creates the subscription", async () => {
    const { calls, fetch } = woovi(
      absentCustomer(),
      createCustomerRoute(),
      createRoute()
    );

    const prepared = await portWith(fetch).prepareSubscription(input());

    expect(prepared.customerAlignment).toBe("created");
    expect(requests(calls)).toEqual([
      `GET ${CUSTOMER_PATH}`,
      "POST /api/v1/customer",
      "POST /api/v1/subscriptions",
    ]);
    expect(
      calls.filter(
        (call) => call.method === "GET" && call.url.includes("/customer")
      )
    ).toHaveLength(1);
    expect(
      calls.some(
        (call) =>
          call.method === "GET" &&
          (call.url.includes("?") || call.url === "/api/v1/customer")
      )
    ).toBe(false);
    for (const call of calls) {
      expect(call.url).not.toContain(CPF);
    }
  });

  it("the customer is created with the correlationID given in payer.customerKey, and the trimmed data", async () => {
    const { calls, fetch } = woovi(
      absentCustomer(),
      createCustomerRoute(),
      createRoute()
    );

    await portWith(fetch).prepareSubscription(input());

    const post = calls.find(
      (call) => call.method === "POST" && call.url === "/api/v1/customer"
    );
    expect(JSON.parse(post?.body ?? "")).toEqual({
      correlationID: CUSTOMER_KEY,
      email: PAYER_EMAIL,
      name: PAYER_NAME,
      taxID: CPF,
    });
  });

  it("matches when the name has extra spaces and the e-mail other capitals, with no write", async () => {
    const { calls, fetch } = woovi(
      findCustomer(
        storedCustomer({
          email: PAYER_EMAIL.toUpperCase(),
          name: `  ${PAYER_NAME.replace(" de ", "   de ")} `,
        })
      ),
      createRoute()
    );

    expect(
      (await portWith(fetch).prepareSubscription(input())).customerAlignment
    ).toBe("matches");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it.each([
    ["another name", { name: "Nome Antigo" }],
    ["another e-mail", { email: "outro@example.com" }],
    ["another document", { taxID: { taxID: OTHER_CPF, type: "BR:CPF" } }],
  ])(
    "a customer with %s is refused: no PATCH, no customer created, no subscription",
    async (_name, difference) => {
      const { calls, fetch } = woovi(
        findCustomer(storedCustomer(difference)),
        patchRoute(),
        createCustomerRoute(),
        createRoute()
      );

      const error = await failureOf(() =>
        portWith(fetch).prepareSubscription(input())
      );

      expect(error).toBeInstanceOf(WooviCustomerMismatchError);
      expect((error as WooviCustomerMismatchError).code).toBe(
        "payer_data_mismatch"
      );
      expect(requests(calls)).toEqual([`GET ${CUSTOMER_PATH}`]);
      expect(calls.some((call) => call.method === "PATCH")).toBe(false);
      expect(calls.some((call) => call.method === "POST")).toBe(false);
    }
  );

  it("a customer Woovi refuses to create (400 of another kind) is payer_data_mismatch, with no subscription", async () => {
    const { calls, fetch } = woovi(
      absentCustomer(),
      createCustomerRoute({
        status: 400,
        text: JSON.stringify({ error: `CPF ${CPF} já cadastrado` }),
      }),
      createRoute()
    );

    const error = await failureOf(() =>
      portWith(fetch).prepareSubscription(input())
    );

    expect(error).toBeInstanceOf(WooviCustomerMismatchError);
    expect((error as WooviCustomerMismatchError).code).toBe(
      "payer_data_mismatch"
    );
    expect(requests(calls)).toEqual([
      `GET ${CUSTOMER_PATH}`,
      "POST /api/v1/customer",
    ]);
    expect(shown(error)).not.toContain(CPF);
  });

  it("an outage creating the customer is ProviderUnavailableError, not a refusal", async () => {
    const { calls, fetch } = woovi(
      absentCustomer(),
      createCustomerRoute({ status: 503, text: "{}" }),
      createRoute()
    );

    const error = await failureOf(() =>
      portWith(fetch).prepareSubscription(input())
    );

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).not.toBeInstanceOf(WooviCustomerMismatchError);
    expect(calls.some((call) => call.url === "/api/v1/subscriptions")).toBe(
      false
    );
  });

  it("an outage reading the customer is ProviderUnavailableError, with nothing written", async () => {
    const { calls, fetch } = woovi(
      on("GET", CUSTOMER_PATH, { status: 502, text: "<html>" }),
      createCustomerRoute(),
      createRoute()
    );

    await expect(
      portWith(fetch).prepareSubscription(input())
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("the refusal carries no personal data", async () => {
    const { fetch } = woovi(
      findCustomer(storedCustomer({ name: "Nome Antigo" })),
      createRoute()
    );

    const error = await failureOf(() =>
      portWith(fetch).prepareSubscription(input())
    );

    const text = shown(error);
    for (const value of [CPF, PAYER_EMAIL, PAYER_NAME, FAKE_EMV]) {
      expect(text).not.toContain(value);
    }
  });

  it.each([
    ["no payer", { payer: undefined }],
    [
      "a payer with no tax ID",
      {
        payer: {
          customerKey: CUSTOMER_KEY,
          email: PAYER_EMAIL,
          name: PAYER_NAME,
        },
      },
    ],
    [
      "a payer with no customer key",
      { payer: { email: PAYER_EMAIL, name: PAYER_NAME, taxId: CPF } },
    ],
    [
      "a payer with an empty customer key",
      {
        payer: {
          customerKey: "",
          email: PAYER_EMAIL,
          name: PAYER_NAME,
          taxId: CPF,
        },
      },
    ],
  ])("%s is a TypeError before any fetch", async (_name, overrides) => {
    const { calls, fetch } = woovi(findCustomer(), createRoute());

    const error = await failureOf(() =>
      portWith(fetch).prepareSubscription(
        input(overrides as Partial<PrepareSubscriptionInput>)
      )
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe("payer_required_for_pix");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["the CPF", CPF],
    ["a path step", ".."],
    ["a plain key", "cust-1"],
  ])(
    "a customer key that is %s is a TypeError before any fetch",
    async (_name, customerKey) => {
      const { calls, fetch } = woovi(findCustomer(), createRoute());

      const error = await failureOf(() =>
        portWith(fetch).prepareSubscription(
          input({
            payer: {
              customerKey,
              email: PAYER_EMAIL,
              name: PAYER_NAME,
              taxId: CPF,
            },
          })
        )
      );

      expect(error).toBeInstanceOf(TypeError);
      expect(calls).toHaveLength(0);
    }
  );

  it.each([
    ["no globalID", { globalID: undefined }],
    ["a globalID of another type", { globalID: INSTALLMENT_ID }],
    ["a globalID that is a path", { globalID: "../x" }],
    ["no pixRecurring", { pixRecurring: undefined }],
    ["no emv", { pixRecurring: { journey: "ONLY_RECURRENCY" } }],
    ["an emv that is not text", { pixRecurring: { emv: 1 } }],
    ["an empty emv", { pixRecurring: { emv: "" } }],
  ])("a creation answer with %s is malformed", async (_name, overrides) => {
    const { fetch } = woovi(
      findCustomer(),
      createRoute(
        json({ subscription: subscriptionBeforeApprovalJson(overrides) })
      )
    );

    const error = await failureOf(() =>
      portWith(fetch).prepareSubscription(input())
    );

    expect(error).toBeInstanceOf(ProviderResponseMalformedError);
    expect(shown(error)).not.toContain(FAKE_EMV);
  });
});

describe("cancelRenewal", () => {
  it("cancels an ACTIVE subscription, reading it first with the encoded globalID", async () => {
    const { calls, fetch } = fakeWoovi(getSubscription(), cancelRoute());

    const outcome = await portWith(fetch).cancelRenewal(SUBSCRIPTION_ID);

    expect(outcome).toBe("cancelled");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${SUBSCRIPTION_PATH}`,
      `PUT ${SUBSCRIPTION_PATH}/cancel`,
    ]);
    expect(SUBSCRIPTION_PATH).not.toContain("=");
  });

  it("reads the stored providerSubscriptionId when there is one", async () => {
    const { calls, fetch } = fakeWoovi(getSubscription(), cancelRoute());

    await portWith(fetch).cancelRenewal("not-a-global-id", SUBSCRIPTION_ID);

    expect(calls[0]?.url).toBe(SUBSCRIPTION_PATH);
  });

  it("an INACTIVE subscription is already cancelled, with no PUT", async () => {
    const { calls, fetch } = fakeWoovi(
      getSubscription({ status: "INACTIVE" }),
      cancelRoute()
    );

    expect(await portWith(fetch).cancelRenewal(SUBSCRIPTION_ID)).toBe(
      "already_cancelled"
    );
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("a 404 is nothing to cancel", async () => {
    const { calls, fetch } = fakeWoovi();

    expect(await portWith(fetch).cancelRenewal(SUBSCRIPTION_ID)).toBe(
      "nothing_to_cancel"
    );
    expect(calls).toHaveLength(1);
  });
});

describe("discardCheckout", () => {
  it("a subscription the payer has not approved is cancelled and discarded", async () => {
    const { calls, fetch } = fakeWoovi(
      on(
        "GET",
        SUBSCRIPTION_PATH,
        json({ subscription: subscriptionBeforeApprovalJson() })
      ),
      cancelRoute()
    );

    expect(await portWith(fetch).discardCheckout(SUBSCRIPTION_ID)).toBe(
      "discarded"
    );
    expect(calls.at(-1)?.method).toBe("PUT");
    expect(calls.at(-1)?.url).toBe(`${SUBSCRIPTION_PATH}/cancel`);
  });

  it("an approved subscription is no longer a checkout: already closed, with no PUT", async () => {
    const { calls, fetch } = fakeWoovi(
      getSubscription({
        pixRecurring: { emv: FAKE_EMV, status: "APPROVED" },
      }),
      cancelRoute()
    );

    expect(await portWith(fetch).discardCheckout(SUBSCRIPTION_ID)).toBe(
      "already_closed"
    );
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("an INACTIVE subscription is already closed, with no PUT", async () => {
    const { calls, fetch } = fakeWoovi(
      on(
        "GET",
        SUBSCRIPTION_PATH,
        json({
          subscription: subscriptionBeforeApprovalJson({ status: "INACTIVE" }),
        })
      ),
      cancelRoute()
    );

    expect(await portWith(fetch).discardCheckout(SUBSCRIPTION_ID)).toBe(
      "already_closed"
    );
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("a 404 is already closed", async () => {
    const { fetch } = fakeWoovi();
    expect(await portWith(fetch).discardCheckout(SUBSCRIPTION_ID)).toBe(
      "already_closed"
    );
  });

  it("a 503 is ProviderUnavailableError", async () => {
    const { fetch } = fakeWoovi(() => ({ status: 503, text: "" }));
    await expect(
      portWith(fetch).discardCheckout(SUBSCRIPTION_ID)
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("hasSubscription", () => {
  const notApproved = () =>
    on(
      "GET",
      SUBSCRIPTION_PATH,
      json({ subscription: subscriptionBeforeApprovalJson() })
    );

  it("an approved authorization is a subscription, without reading installments", async () => {
    const { calls, fetch } = fakeWoovi(getSubscription());

    expect(await portWith(fetch).hasSubscription(SUBSCRIPTION_ID)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("a subscription not approved and with no installments is not one", async () => {
    const { fetch } = fakeWoovi(notApproved(), getInstallments());
    expect(await portWith(fetch).hasSubscription(SUBSCRIPTION_ID)).toBe(false);
  });

  it("a subscription not approved but with an installment was one (approved, then revoked)", async () => {
    const { fetch } = fakeWoovi(
      notApproved(),
      getInstallments(installmentJson())
    );
    expect(await portWith(fetch).hasSubscription(SUBSCRIPTION_ID)).toBe(true);
  });

  it("a 404 throws ProviderNotFoundError", async () => {
    const { fetch } = fakeWoovi();
    await expect(
      portWith(fetch).hasSubscription(SUBSCRIPTION_ID)
    ).rejects.toBeInstanceOf(ProviderNotFoundError);
  });
});

/** A resource as the client hands it over: numbers kept as text. */
const parsed = (value: unknown) => parseProviderJson(JSON.stringify(value));

describe("readState", () => {
  it("gives the same facts as the reconciliation, tied to the globalID", async () => {
    const { fetch } = fakeWoovi(
      getSubscription(),
      getInstallments(
        installmentJson(),
        installmentJson({
          dateGenerateCharge: "2026-11-27T12:00:00.000Z",
          globalID: OTHER_INSTALLMENT_ID,
          status: "SCHEDULED",
        })
      )
    );

    const events = await portWith(fetch).readState(SUBSCRIPTION_ID, NOW);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.fact.type)).toEqual([
      "trial_method_ready",
      "charge_succeeded",
    ]);
    for (const event of events) {
      expect(event.providerRef).toBe(SUBSCRIPTION_ID);
      expect(event.providerSubscriptionId).toBe(SUBSCRIPTION_ID);
    }
    // the reconciliation's own reading of the same resources
    expect(events).toEqual(
      reconcileWooviSubscription({
        installments: [
          pickWooviInstallment(parsed(installmentJson())),
          pickWooviInstallment(
            parsed(
              installmentJson({
                dateGenerateCharge: "2026-11-27T12:00:00.000Z",
                globalID: OTHER_INSTALLMENT_ID,
                status: "SCHEDULED",
              })
            )
          ),
        ],
        now: NOW,
        subscription: pickWooviSubscription(parsed(subscriptionJson())),
      })
    );
  });

  it("carries nothing personal", async () => {
    const { fetch } = fakeWoovi(
      getSubscription(),
      getInstallments(installmentJson())
    );
    const events = await portWith(fetch).readState(SUBSCRIPTION_ID, NOW);
    const text = JSON.stringify(events);
    for (const value of PERSONAL_VALUES) {
      expect(text).not.toContain(value);
    }
  });
});

it.each([
  [{}, false],
  [{ refundEnabled: false }, false],
  [{ refundEnabled: true }, true],
])(
  "says whether it can refund (%o: %s), so the refund command cancels nothing it cannot refund",
  (config, expected) => {
    expect(portWith(fakeWoovi().fetch, config).refundsEnabled).toBe(expected);
  }
);

describe("refundCurrentPeriod", () => {
  const CORRELATION_ID = `refund:${SUBSCRIPTION_ID}:${INSTALLMENT_ID}`;
  const refundingPort = (fetch: FetchLike) =>
    portWith(fetch, { refundEnabled: true });

  it.each([
    ["by default", {}],
    ["when refundEnabled is false", { refundEnabled: false }],
  ])(
    "is not configured %s: ProviderNotConfiguredError and no fetch at all",
    async (_name, config) => {
      const { calls, fetch } = fakeWoovi(
        getSubscription(),
        getInstallments(installmentJson()),
        refundRoute()
      );

      const error = await failureOf(() =>
        portWith(fetch, config).refundCurrentPeriod(
          SUBSCRIPTION_ID,
          NOW,
          null,
          "any_paid"
        )
      );

      expect(error).toBeInstanceOf(ProviderNotConfiguredError);
      expect(calls).toHaveLength(0);
    }
  );

  it("refunds the paid installment of the period in force and answers the fact", async () => {
    const { calls, fetch } = fakeWoovi(
      getSubscription(),
      getInstallments(installmentJson()),
      refundRoute()
    );

    const outcome = await refundingPort(fetch).refundCurrentPeriod(
      SUBSCRIPTION_ID,
      NOW,
      null,
      "any_paid"
    );

    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toBe("/api/v1/refund");
    expect(post?.body).toContain('"value":2490');
    expect(post?.body).not.toContain('"value":"');
    expect(JSON.parse(post?.body ?? "")).toEqual({
      comment: "Reembolso Polaris Pro",
      correlationID: CORRELATION_ID,
      transactionEndToEndId: END_TO_END_ID,
      value: 2490,
    });
    expect(outcome).toEqual({
      event: {
        fact: {
          amount: { currency: "BRL", value: "24.90" },
          occurredAt: NOW,
          // `2026-10-27` plus one month, through the whole day in São Paulo
          periodEndsAt: new Date("2026-11-28T03:00:00.000Z"),
          type: "charge_refunded",
        },
        providerEventId: CORRELATION_ID,
        providerRef: SUBSCRIPTION_ID,
        providerSubscriptionId: SUBSCRIPTION_ID,
      },
      kind: "refund_requested",
    });
  });

  describe("with the first charge recorded (the owner's refund, ADR 0104)", () => {
    const FIRST_EVENT = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const firstPeriod = () =>
      installmentPeriodEndsAt(
        pickWooviInstallment(parsed(installmentJson())),
        pickWooviSubscription(parsed(subscriptionJson()))
      );
    const paid = () =>
      fakeWoovi(
        getSubscription(),
        getInstallments(installmentJson()),
        refundRoute()
      );

    it("refunds the installment in force when it pays the first charge's period", async () => {
      const { calls, fetch } = paid();

      const outcome = await refundingPort(fetch).refundCurrentPeriod(
        SUBSCRIPTION_ID,
        NOW,
        null,
        { eventId: FIRST_EVENT, periodEndsAt: firstPeriod() }
      );

      expect(outcome).toMatchObject({ kind: "refund_requested" });
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    });

    it("refuses, asking for no refund, when the installment in force pays another period", async () => {
      const { calls, fetch } = paid();

      const error = await failureOf(() =>
        refundingPort(fetch).refundCurrentPeriod(SUBSCRIPTION_ID, NOW, null, {
          eventId: FIRST_EVENT,
          periodEndsAt: new Date(firstPeriod().getTime() - 1),
        })
      );

      expect(error).toBeInstanceOf(NotFirstChargeError);
      expect(calls.some((call) => call.method === "POST")).toBe(false);
    });

    it("refuses with no first charge recorded, before it reads anything from Woovi", async () => {
      const { calls, fetch } = paid();

      const error = await failureOf(() =>
        refundingPort(fetch).refundCurrentPeriod(SUBSCRIPTION_ID, NOW, null, {
          eventId: null,
          periodEndsAt: firstPeriod(),
        })
      );

      expect(error).toBeInstanceOf(NotFirstChargeError);
      expect(calls).toHaveLength(0);
    });
  });

  it("uses the latest paid installment, not an earlier one", async () => {
    const { calls, fetch } = fakeWoovi(
      getSubscription(),
      getInstallments(
        installmentJson({
          dateGenerateCharge: "2026-09-27T12:00:00.000Z",
          globalID: OTHER_INSTALLMENT_ID,
        }),
        installmentJson()
      ),
      refundRoute()
    );

    await refundingPort(fetch).refundCurrentPeriod(
      SUBSCRIPTION_ID,
      NOW,
      null,
      "any_paid"
    );

    expect(
      JSON.parse(calls.find((call) => call.method === "POST")?.body ?? "")
    ).toMatchObject({ correlationID: CORRELATION_ID });
  });

  it.each([
    [
      "only a future installment",
      installmentJson({
        dateGenerateCharge: "2026-11-27T12:00:00.000Z",
        status: "SCHEDULED",
      }),
    ],
    [
      "a paid installment charged tomorrow in São Paulo",
      installmentJson({ dateGenerateCharge: "2026-10-29T12:00:00.000Z" }),
    ],
    [
      "an installment whose period has ended",
      installmentJson({ dateGenerateCharge: "2026-09-20T12:00:00.000Z" }),
    ],
    ["an installment not paid", installmentJson({ status: "ACTIVE" })],
  ])("%s is nothing to refund, with no POST", async (_name, installment) => {
    const { calls, fetch } = fakeWoovi(
      getSubscription(),
      getInstallments(installment),
      refundRoute()
    );

    expect(
      await refundingPort(fetch).refundCurrentPeriod(
        SUBSCRIPTION_ID,
        NOW,
        null,
        "any_paid"
      )
    ).toBe("nothing_to_refund");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("no installments at all is nothing to refund", async () => {
    const { fetch } = fakeWoovi(
      getSubscription(),
      getInstallments(),
      refundRoute()
    );
    expect(
      await refundingPort(fetch).refundCurrentPeriod(
        SUBSCRIPTION_ID,
        NOW,
        null,
        "any_paid"
      )
    ).toBe("nothing_to_refund");
  });

  it("a paid installment without an endToEndId is malformed, with no POST", async () => {
    const { calls, fetch } = fakeWoovi(
      getSubscription(),
      getInstallments(
        installmentJson({
          cobr: { status: "CONCLUDED" },
        })
      ),
      refundRoute()
    );

    await expect(
      refundingPort(fetch).refundCurrentPeriod(
        SUBSCRIPTION_ID,
        NOW,
        null,
        "any_paid"
      )
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("an endToEndId of another shape is malformed, with no POST", async () => {
    const { calls, fetch } = fakeWoovi(
      getSubscription(),
      getInstallments(
        installmentJson({ cobr: { endToEndId: "../x", status: "CONCLUDED" } })
      ),
      refundRoute()
    );

    await expect(
      refundingPort(fetch).refundCurrentPeriod(
        SUBSCRIPTION_ID,
        NOW,
        null,
        "any_paid"
      )
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("the result carries no personal data nor the Pix payload", async () => {
    const { fetch } = fakeWoovi(
      getSubscription(),
      getInstallments(installmentJson()),
      refundRoute()
    );

    const outcome = await refundingPort(fetch).refundCurrentPeriod(
      SUBSCRIPTION_ID,
      NOW,
      null,
      "any_paid"
    );

    const text = JSON.stringify(outcome);
    for (const value of PERSONAL_VALUES) {
      expect(text).not.toContain(value);
    }
  });
});

describe("overduePaymentPage", () => {
  it("gives null without calling Woovi (Pix Automático has no page to pay a failed installment)", async () => {
    const { calls, fetch } = fakeWoovi(
      getSubscription(),
      getInstallments(installmentJson())
    );

    await expect(
      portWith(fetch).overduePaymentPage(SUBSCRIPTION_ID, null)
    ).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});
