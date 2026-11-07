import type { FetchLike } from "@polaris/billing/http";
import type { BillingStore } from "@polaris/db/billing-store";
import { logger } from "@polaris/observability/logger";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv, WorkerBindings } from "../environment";
import { requestIdMiddleware } from "../middleware/request-id";
import { createBillingWebhookRoutes } from "../routes/billing-webhooks";
import { billingProviderAdapters } from "./adapters";
import { createAsaasAdapter } from "./asaas-adapter";

/**
 * The Asaas adapter behind the real webhook route, with the Asaas API and the
 * billing store faked. The payloads follow the shape the sandbox returned;
 * every value is made up.
 */

const TOKEN = "fake-webhook-token-0123456789abcdef";
/** The ID of the checkout: the `providerRef`, and the `checkoutSession` of the subscription (S1.3). */
const REF = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const EVENT_ID = "evt_0123456789abcdef0123456789abcdef&100000001";
const PAYER = {
  cpf: "529.982.247-25",
  email: "pagador.teste@example.com",
  name: "Pagadora de Teste",
};
const CARD_TOKEN = "tok_FAKE_9f8e7d6c5b4a39281706";
const INVOICE_URL = "https://sandbox.asaas.com/i/fakeinvoice000";
const WHY_WORDS = /token|asaas/i;
const LEAKS = [
  PAYER.cpf,
  PAYER.email,
  PAYER.name,
  CARD_TOKEN,
  INVOICE_URL,
  TOKEN,
];

const payment = (overrides: Record<string, unknown> = {}) => ({
  billingType: "CREDIT_CARD",
  confirmedDate: "2026-10-26",
  creditCard: {
    creditCardBrand: "VISA",
    creditCardNumber: "4444",
    creditCardToken: CARD_TOKEN,
  },
  customer: "cus_fake0000000001",
  dateCreated: "2026-10-26",
  deleted: false,
  dueDate: "2026-10-26",
  externalReference: null,
  id: "pay_fake0000000001",
  invoiceUrl: INVOICE_URL,
  originalDueDate: "2026-10-26",
  status: "CONFIRMED",
  subscription: "sub_fake0000000001",
  value: 24.9,
  ...overrides,
});
const subscription = {
  checkoutSession: REF,
  creditCard: { creditCardToken: CARD_TOKEN },
  customer: "cus_fake0000000001",
  cycle: "MONTHLY",
  deleted: false,
  externalReference: null,
  id: "sub_fake0000000001",
  status: "ACTIVE",
  value: 24.9,
};
const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    dateCreated: nowInBrasilia(),
    event: "PAYMENT_CONFIRMED",
    id: EVENT_ID,
    payment: {
      ...payment(),
      customer: { cpfCnpj: PAYER.cpf, email: PAYER.email, name: PAYER.name },
    },
    ...overrides,
  });

type Answer = { json?: unknown; status: number } | "network" | "timeout";

function fakeApi(answers: Record<string, Answer> = {}) {
  const urls: string[] = [];
  const routes: Record<string, Answer> = {
    "/v3/payments/pay_fake0000000001": { json: payment(), status: 200 },
    "/v3/subscriptions/sub_fake0000000001": { json: subscription, status: 200 },
    ...answers,
  };
  const fetch: FetchLike = (url, init) => {
    urls.push(url);
    expect(init.headers.access_token).toBe("$aact_hmlg_FAKE_TEST_KEY");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const answer = routes[new URL(url).pathname] ?? { status: 404 };
    if (answer === "network") {
      return Promise.reject(
        new TypeError("fetch failed: https://api-sandbox.asaas.com")
      );
    }
    if (answer === "timeout") {
      return Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError")
      );
    }
    return Promise.resolve({
      status: answer.status,
      text: () =>
        Promise.resolve(
          answer.json === undefined
            ? // an error body with personal data: it must never be read into a log
              JSON.stringify({
                errors: [{ description: `${PAYER.email} ${PAYER.cpf}` }],
              })
            : JSON.stringify(answer.json)
        ),
    });
  };
  return { fetch, urls };
}

function fakeStore() {
  return {
    attachProvider: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
    processEvent: vi.fn((id: string) =>
      Promise.resolve({
        eventId: id,
        organizationId: "org",
        outcomeCode: null,
        status: "applied" as const,
      })
    ),
    readRecord: vi.fn(),
    recordEvent: vi.fn((input: { providerEventId: string }) =>
      Promise.resolve({ duplicate: false, id: `id-${input.providerEventId}` })
    ),
    retryPending: vi.fn(),
    startTrial: vi.fn(),
    sweepDue: vi.fn(),
  };
}

const configured: Record<string, unknown> = {
  ASAAS_API_KEY: "$aact_hmlg_FAKE_TEST_KEY",
  ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
  ASAAS_WEBHOOK_TOKEN: TOKEN,
  BILLING_HYPERDRIVE: {
    connectionString: "postgresql://billing.invalid/db",
  },
};

function setup(
  options: {
    answers?: Record<string, Answer>;
    bindings?: Record<string, unknown>;
  } = {}
) {
  const api = fakeApi(options.answers);
  const store = fakeStore();
  const background: Promise<unknown>[] = [];
  const logs = {
    error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
    info: vi.spyOn(logger, "info").mockImplementation(() => undefined),
    warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
  };
  const app = new Hono<ServerEnv>();
  app.use("*", requestIdMiddleware);
  app.route(
    "/",
    createBillingWebhookRoutes({
      adapters: { asaas: createAsaasAdapter({ fetch: api.fetch }) },
      createStore: () => store as unknown as BillingStore,
      runInBackground: (promise) => {
        background.push(promise);
      },
    })
  );
  const bindings = {
    ...configured,
    ...options.bindings,
  } as unknown as WorkerBindings;
  const send = async (
    text: string,
    headers: Record<string, string> = { "asaas-access-token": TOKEN }
  ) => {
    const response = await app.fetch(
      new Request("https://polaris.example.invalid/webhooks/billing/asaas", {
        body: text,
        headers,
        method: "POST",
      }),
      bindings
    );
    const answer = await response.text();
    await Promise.all(background);
    const logged = JSON.stringify([
      logs.error.mock.calls,
      logs.info.mock.calls,
      logs.warn.mock.calls,
    ]);
    return { answer, logged, response };
  };
  return { api, logs, send, store };
}

/** The current time as Asaas writes `dateCreated` (Brasília, UTC−3). */
function nowInBrasilia(): string {
  return new Date(Date.now() - 3 * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function expectNoLeak(...texts: string[]) {
  for (const text of texts) {
    for (const leak of LEAKS) {
      expect(text).not.toContain(leak);
    }
    expect(text).not.toContain("creditCardToken");
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the provider adapters are registered (AC-11)", () => {
  it("asaas and woovi answer at /webhooks/billing/:provider", () => {
    expect(Object.hasOwn(billingProviderAdapters, "asaas")).toBe(true);
    expect(Object.hasOwn(billingProviderAdapters, "woovi")).toBe(true);
    expect(billingProviderAdapters.asaas?.provider).toBe("asaas");
    expect(billingProviderAdapters.woovi?.provider).toBe("woovi");
  });

  it("any other name is a 404, before the body is read", async () => {
    const app = new Hono<ServerEnv>();
    app.use("*", requestIdMiddleware);
    app.route("/", createBillingWebhookRoutes());
    for (const name of ["stripe", "constructor", "Asaas", "asaas2"]) {
      // biome-ignore lint/performance/noAwaitInLoops: One request per name.
      const response = await app.fetch(
        new Request(
          `https://polaris.example.invalid/webhooks/billing/${name}`,
          {
            body: "{}",
            method: "POST",
          }
        ),
        configured as unknown as WorkerBindings
      );
      expect(response.status).toBe(404);
    }
  });
});

describe("AC-1a: the token, in constant time, with no reason given", () => {
  it("a valid token stores the fact read back from the API and answers 200", async () => {
    const t = setup();
    const { answer, response } = await t.send(body());
    expect(response.status).toBe(200);
    expect(JSON.parse(answer)).toMatchObject({ duplicates: 0, received: 1 });
    expect(t.store.recordEvent).toHaveBeenCalledWith({
      fact: {
        amount: { currency: "BRL", value: "24.90" },
        cycleMonths: 1,
        occurredAt: expect.any(Date),
        periodEndsAt: new Date("2026-11-27T03:00:00.000Z"),
        type: "charge_succeeded",
      },
      provider: "asaas",
      providerEventId: EVENT_ID,
      providerRef: REF,
      providerSubscriptionId: "sub_fake0000000001",
    });
  });

  it.each([
    ["missing", {}],
    ["wrong", { "asaas-access-token": `${TOKEN.slice(0, -1)}X` }],
    ["empty", { "asaas-access-token": "" }],
  ])(
    "a %s token is a 401 that says nothing about why, and reads nothing",
    async (_case, headers) => {
      const t = setup();
      const { answer, response } = await t.send(body(), headers);
      expect(response.status).toBe(401);
      expect(JSON.parse(answer).error).toEqual({ code: "unauthorized" });
      expect(answer).not.toMatch(WHY_WORDS);
      expect(t.api.urls).toEqual([]);
      expect(t.store.recordEvent).not.toHaveBeenCalled();
    }
  );

  it("the next token is accepted during a rotation", async () => {
    const t = setup({
      bindings: {
        ASAAS_WEBHOOK_TOKEN_NEXT: "fake-next-token-abcdef0123456789",
      },
    });
    const { response } = await t.send(body(), {
      "asaas-access-token": "fake-next-token-abcdef0123456789",
    });
    expect(response.status).toBe(200);
  });

  it.each(["ASAAS_WEBHOOK_TOKEN", "ASAAS_API_KEY", "ASAAS_BASE_URL"] as const)(
    "without %s the route answers 503, never 200",
    async (name) => {
      const t = setup({ bindings: { [name]: undefined } });
      const { answer, response } = await t.send(body());
      expect(response.status).toBe(503);
      expect(JSON.parse(answer).error).toEqual({
        code: "billing_provider_not_configured",
      });
    }
  );

  it("a production key against the sandbox host is refused as not configured", async () => {
    const t = setup({
      bindings: { ASAAS_API_KEY: "$aact_prod_FAKE_TEST_KEY" },
    });
    const { response } = await t.send(body());
    expect(response.status).toBe(503);
    expect(t.api.urls).toEqual([]);
  });
});

describe("AC-1c and AC-48 through the route", () => {
  it("a resource the API does not find is not acknowledged: 503 and only IDs in the log", async () => {
    const t = setup({
      answers: { "/v3/payments/pay_fake0000000001": { status: 404 } },
    });
    const { answer, logged, response } = await t.send(body());
    expect(response.status).toBe(503);
    expect(JSON.parse(answer).error).toEqual({
      code: "billing_resource_unresolved",
    });
    expect(t.store.recordEvent).not.toHaveBeenCalled();
    expect(t.logs.warn).toHaveBeenCalledWith(
      "billing_webhook_unresolved",
      expect.objectContaining({
        eventType: "PAYMENT_CONFIRMED",
        provider: "asaas",
        providerEventId: EVENT_ID,
        resourceId: "pay_fake0000000001",
      })
    );
    expectNoLeak(answer, logged);
  });

  it.each([
    ["is down", { status: 502 }],
    ["cannot be reached", "network"],
    ["does not answer within 5 s", "timeout"],
  ] as [string, Answer][])(
    "an API that %s gives a 503, so Asaas sends it again",
    async (_case, failure) => {
      const t = setup({
        answers: { "/v3/payments/pay_fake0000000001": failure },
      });
      const { answer, logged, response } = await t.send(body());
      expect(response.status).toBe(503);
      expect(t.store.recordEvent).not.toHaveBeenCalled();
      expectNoLeak(answer, logged);
      expect(logged).not.toContain("api-sandbox.asaas.com");
    }
  );

  it("a key the API refuses (rotated or revoked) gives a 503 and an alert, without the provider's answer", async () => {
    const t = setup({
      answers: { "/v3/payments/pay_fake0000000001": { status: 401 } },
    });
    const { answer, logged, response } = await t.send(body());
    expect(response.status).toBe(503);
    expect(t.logs.error).toHaveBeenCalledWith(
      "billing_provider_rejected",
      expect.objectContaining({
        httpStatus: 401,
        provider: "asaas",
        providerEventId: EVENT_ID,
      })
    );
    expectNoLeak(answer, logged);
  });

  it("an authentic body Asaas would not send is acknowledged and logged as malformed", async () => {
    const t = setup();
    const { answer, response } = await t.send("{not json");
    expect(response.status).toBe(200);
    expect(JSON.parse(answer)).toMatchObject({ duplicates: 0, received: 0 });
    expect(t.logs.warn).toHaveBeenCalledWith(
      "billing_webhook_malformed",
      expect.objectContaining({ provider: "asaas" })
    );
  });

  it("a resource that is not what Asaas documents is refused while recent, then acknowledged with an alert", async () => {
    const answers = {
      "/v3/payments/pay_fake0000000001": {
        json: { ...payment(), value: "24.90" },
        status: 200,
      },
    };
    const recent = setup({ answers });
    const first = await recent.send(body({ dateCreated: nowInBrasilia() }));
    expect(first.response.status).toBe(503);
    expectNoLeak(first.logged, first.answer);

    const old = setup({ answers });
    const late = await old.send(body({ dateCreated: "2026-01-02 10:00:00" }));
    expect(late.response.status).toBe(200);
    expect(old.logs.error).toHaveBeenCalledWith(
      "billing_provider_response_malformed",
      expect.objectContaining({ provider: "asaas", providerEventId: EVENT_ID })
    );
    expectNoLeak(late.logged);
  });

  it("an unresolved event older than the retry window is acknowledged with an error log of its IDs", async () => {
    const t = setup({
      answers: { "/v3/payments/pay_fake0000000001": { status: 404 } },
    });
    const { response } = await t.send(
      body({ dateCreated: "2026-01-02 10:00:00" })
    );
    expect(response.status).toBe(200);
    expect(t.store.recordEvent).not.toHaveBeenCalled();
    expect(t.logs.error).toHaveBeenCalledWith(
      "billing_webhook_unresolved_given_up",
      expect.objectContaining({
        provider: "asaas",
        providerEventId: EVENT_ID,
        resourceId: "pay_fake0000000001",
      })
    );
  });

  it("checks the token before the rest of the configuration, and refuses a short token", async () => {
    const unconfigured = setup({ bindings: { ASAAS_API_KEY: undefined } });
    const wrong = await unconfigured.send(body(), {
      "asaas-access-token": "x".repeat(40),
    });
    expect(wrong.response.status).toBe(401);
    const short = setup({ bindings: { ASAAS_WEBHOOK_TOKEN: "short-token" } });
    const answer = await short.send(body(), {
      "asaas-access-token": "short-token",
    });
    expect(answer.response.status).toBe(503);
  });

  it("a next token shorter than the minimum is refused at the configuration, even with the current token", async () => {
    const short = "fake-next-token";
    const t = setup({ bindings: { ASAAS_WEBHOOK_TOKEN_NEXT: short } });
    for (const token of [TOKEN, short]) {
      // biome-ignore lint/performance/noAwaitInLoops: Two sends, one after the other.
      const { answer, response } = await t.send(body(), {
        "asaas-access-token": token,
      });
      expect(response.status).toBe(503);
      expect(JSON.parse(answer).error).toEqual({
        code: "billing_provider_not_configured",
      });
    }
    expect(t.api.urls).toEqual([]);
    expect(t.store.recordEvent).not.toHaveBeenCalled();
  });

  it("an empty next token is no rotation: the current token still works", async () => {
    const t = setup({ bindings: { ASAAS_WEBHOOK_TOKEN_NEXT: "" } });
    const { response } = await t.send(body());
    expect(response.status).toBe(200);
  });

  it("only a refused key (401 or 403) raises the key alert", async () => {
    const t = setup({
      answers: { "/v3/payments/pay_fake0000000001": { status: 400 } },
    });
    const { response } = await t.send(body());
    expect(response.status).toBe(503);
    expect(t.logs.error).not.toHaveBeenCalledWith(
      "billing_provider_rejected",
      expect.anything()
    );
  });

  it("an event Polaris does not use is acknowledged without reading the API", async () => {
    const t = setup();
    const { response } = await t.send(body({ event: "PAYMENT_CREATED" }));
    expect(response.status).toBe(200);
    expect(t.api.urls).toEqual([]);
  });
});

describe("a body dated in the future is never a reason for a 503", () => {
  const future = "2099-01-01 00:00:00";

  it("stores the fact, dated at most now, and logs the case with IDs only", async () => {
    const t = setup();
    const { logged, response } = await t.send(body({ dateCreated: future }));
    expect(response.status).toBe(200);
    const [call] = t.store.recordEvent.mock.calls as unknown as [
      [{ fact: { occurredAt: Date } }],
    ];
    expect(call[0].fact.occurredAt.getTime()).toBeLessThanOrEqual(Date.now());
    // cut down to the present: never a day or a year ahead
    expect(call[0].fact.occurredAt.getFullYear()).toBeLessThan(2099);
    expect(t.logs.warn).toHaveBeenCalledWith("billing_webhook_date_clamped", {
      eventType: "PAYMENT_CONFIRMED",
      provider: "asaas",
      providerEventId: EVENT_ID,
    });
    expect(logged).not.toContain("2099");
    expectNoLeak(logged);
  });

  it("a resource not found is acknowledged with the given-up log, not held for a retry that never ends", async () => {
    const t = setup({
      answers: { "/v3/payments/pay_fake0000000001": { status: 404 } },
    });
    const { response } = await t.send(body({ dateCreated: future }));
    expect(response.status).toBe(200);
    expect(t.logs.error).toHaveBeenCalledWith(
      "billing_webhook_unresolved_given_up",
      expect.objectContaining({ providerEventId: EVENT_ID })
    );
  });

  it("a resource out of shape is acknowledged with the alert, not a 503", async () => {
    const t = setup({
      answers: {
        "/v3/payments/pay_fake0000000001": {
          json: { ...payment(), value: "24.90" },
          status: 200,
        },
      },
    });
    const { response } = await t.send(body({ dateCreated: future }));
    expect(response.status).toBe(200);
    expect(t.logs.error).toHaveBeenCalledWith(
      "billing_provider_response_malformed",
      expect.objectContaining({ providerEventId: EVENT_ID })
    );
  });
});

describe("AC-3: nothing of the payer, the card or the token reaches the store, the answer or the log", () => {
  it("only the fact and the IDs are stored", async () => {
    const t = setup();
    const { answer, logged } = await t.send(body());
    const stored = JSON.stringify(t.store.recordEvent.mock.calls);
    expectNoLeak(stored, answer, logged);
    expect(stored).not.toContain("invoiceUrl");
  });
});
