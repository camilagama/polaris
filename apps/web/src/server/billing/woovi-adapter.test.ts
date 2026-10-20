import type { FetchLike } from "@polaris/billing/http";
import type { BillingStore } from "@polaris/db/billing-store";
import { logger } from "@polaris/observability/logger";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerEnv, WorkerBindings } from "../environment";
import { requestIdMiddleware } from "../middleware/request-id";
import { createBillingWebhookRoutes } from "../routes/billing-webhooks";
import { createWooviAdapter } from "./woovi-adapter";

/**
 * The Woovi adapter behind the real webhook route, with the Woovi API and the
 * billing store faked. The payloads follow the shape the sandbox returned
 * (20/10/2026); every value is made up, and the RSA pair is made by the test.
 */

const APP_ID = "fake-app-id";
const SUBSCRIPTION_ID = btoa("PaymentSubscription:6a1b2c3d4e5f60718293a4b5");
const SUBSCRIPTION_LOG_ID = "PaymentSubscription:6a1b2c3d4e5f60718293a4b5";
const INSTALLMENT_ID = btoa(
  "PaymentSubscriptionInstallment:6b1b2c3d4e5f60718293a4c7"
);
const PAYER = {
  cpf: "52998224725",
  email: "pagador.teste@example.com",
  name: "Pagadora de Teste",
  phone: "+5511987654321",
};
const EMV =
  "00020126FAKE0000PIXAUTOMATICO5204000053039865802BR5909POLARISFK6009SAO PAULO62070503***6304ABCD";
const PIX_KEY = "chave.pix.falsa@example.com";
const WHY_WORDS = /signature|assinatura|woovi|key|chave/i;
const LEAKS = [
  PAYER.cpf,
  PAYER.email,
  PAYER.name,
  PAYER.phone,
  EMV,
  PIX_KEY,
  APP_ID,
];
const MAX_BYTES = 64 * 1024;

const encoder = new TextEncoder();
type SigningKey = Awaited<ReturnType<typeof makePair>>["privateKey"];
let publicKey = "";
let strangerPublicKey = "";
let privateKey: SigningKey;
let strangerKey: SigningKey;

async function makePair() {
  const pair = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 1024,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"]
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey)
  );
  return {
    privateKey: pair.privateKey,
    publicKey: btoa(String.fromCharCode(...spki)),
  };
}

async function sign(
  text: string,
  key: typeof privateKey = privateKey
): Promise<string> {
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(text))
  );
  return btoa(String.fromCharCode(...signature));
}

beforeAll(async () => {
  const pair = await makePair();
  const stranger = await makePair();
  ({ privateKey, publicKey } = pair);
  strangerKey = stranger.privateKey;
  strangerPublicKey = stranger.publicKey;
});

const subscription = (
  overrides: Record<string, unknown> = {},
  pix: Record<string, unknown> = {}
) => ({
  correlationID: "sub-corr-fake-0001",
  customer: {
    address: { street: "Rua Ficticia 123" },
    correlationID: "cust-fake-0001",
    email: PAYER.email,
    name: PAYER.name,
    phone: PAYER.phone,
    taxID: { taxID: PAYER.cpf, type: "BR:CPF" },
  },
  dayGenerateCharge: 27,
  frequency: "MONTHLY",
  globalID: SUBSCRIPTION_ID,
  name: "Polaris Pro mensal",
  paymentLink: "https://woovi-sandbox.com/pay/fake-link-0001",
  pixRecurring: {
    emv: EMV,
    journey: "ONLY_RECURRENCY",
    recurrencyId: "RN0000000020261020FAKE000001",
    status: "APPROVED",
    ...pix,
  },
  status: "ACTIVE",
  type: "PIX_RECURRING",
  value: 2490,
  ...overrides,
});
const installment = (overrides: Record<string, unknown> = {}) => ({
  cobr: {
    identifierId: "fake-identifier-0001",
    status: "CONCLUDED",
    value: 2490,
  },
  dateGenerateCharge: "2026-10-27T12:00:00.000Z",
  expiration: 86_400,
  globalID: INSTALLMENT_ID,
  installmentNumber: 1,
  paymentSubscriptionGlobalID: SUBSCRIPTION_ID,
  status: "COMPLETED",
  value: 2490,
  ...overrides,
});

/** The body the webhook sends: the body's claim, with the payer's data. */
const approvedBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...subscription(),
    event: "PIX_AUTOMATIC_APPROVED",
    ...overrides,
  });
const paidBody = () =>
  JSON.stringify({
    ...installment(),
    correlationID: "inst-corr-fake-0001",
    event: "PIX_AUTOMATIC_COBR_COMPLETED",
  });

type Answer = { json?: unknown; status: number } | "network" | "timeout";

const SUBSCRIPTION_PATH = `/api/v1/subscriptions/${encodeURIComponent(SUBSCRIPTION_ID)}`;
const INSTALLMENT_PATH = `/api/v1/installments/${encodeURIComponent(INSTALLMENT_ID)}`;

function fakeApi(answers: Record<string, Answer> = {}) {
  const urls: string[] = [];
  const routes: Record<string, Answer> = {
    [INSTALLMENT_PATH]: { json: installment(), status: 200 },
    [SUBSCRIPTION_PATH]: {
      json: { subscription: subscription() },
      status: 200,
    },
    ...answers,
  };
  const fetch: FetchLike = (url, init) => {
    urls.push(url);
    expect(url.startsWith("https://api.woovi-sandbox.com/")).toBe(true);
    expect(init.headers.authorization).toBe(APP_ID);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const answer = routes[new URL(url).pathname] ?? { status: 404 };
    if (answer === "network") {
      return Promise.reject(
        new TypeError("fetch failed: https://api.woovi-sandbox.com")
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
              JSON.stringify({ error: `${PAYER.email} ${PAYER.cpf}` })
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

function configured(): Record<string, unknown> {
  return {
    BILLING_HYPERDRIVE: { connectionString: "postgresql://billing.invalid/db" },
    WOOVI_APP_ID: APP_ID,
    WOOVI_BASE_URL: "https://api.woovi-sandbox.com",
    WOOVI_WEBHOOK_PUBLIC_KEYS: publicKey,
  };
}

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
      adapters: { woovi: createWooviAdapter({ fetch: api.fetch }) },
      createStore: () => store as unknown as BillingStore,
      runInBackground: (promise) => {
        background.push(promise);
      },
    })
  );
  const bindings = {
    ...configured(),
    ...options.bindings,
  } as unknown as WorkerBindings;
  /** Sends `text` with the signature given (by default, the right key's over `text`). */
  const send = async (text: string, signature?: string | null) => {
    const headers: Record<string, string> = {};
    const value = signature === undefined ? await sign(text) : signature;
    if (value !== null) {
      headers["x-webhook-signature"] = value;
    }
    const response = await app.fetch(
      new Request("https://polaris.example.invalid/webhooks/billing/woovi", {
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

function expectNoLeak(...texts: string[]) {
  for (const text of texts) {
    for (const leak of LEAKS) {
      expect(text).not.toContain(leak);
    }
    expect(text).not.toContain("emv");
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the signature (AC-1b), checked over the raw bytes", () => {
  it("a valid signature stores the fact read back from the API, as woovi, and answers 200", async () => {
    const t = setup();
    const { answer, response } = await t.send(approvedBody());
    expect(response.status).toBe(200);
    expect(JSON.parse(answer)).toMatchObject({ duplicates: 0, received: 1 });
    expect(t.store.recordEvent).toHaveBeenCalledWith({
      fact: {
        cycleMonths: 1,
        occurredAt: expect.any(Date),
        type: "trial_method_ready",
      },
      provider: "woovi",
      providerEventId: `PIX_AUTOMATIC_APPROVED:${SUBSCRIPTION_ID}`,
      providerRef: SUBSCRIPTION_ID,
      providerSubscriptionId: null,
    });
    expect(t.api.urls).toEqual([
      `https://api.woovi-sandbox.com${SUBSCRIPTION_PATH}`,
    ]);
  });

  it("a paid installment stores charge_succeeded with the period and the amount", async () => {
    const t = setup();
    const { response } = await t.send(paidBody());
    expect(response.status).toBe(200);
    expect(t.store.recordEvent).toHaveBeenCalledWith({
      fact: {
        amount: { currency: "BRL", value: "24.90" },
        cycleMonths: 1,
        occurredAt: expect.any(Date),
        periodEndsAt: new Date("2026-11-28T03:00:00.000Z"),
        type: "charge_succeeded",
      },
      provider: "woovi",
      providerEventId: `PIX_AUTOMATIC_COBR_COMPLETED:${INSTALLMENT_ID}`,
      providerRef: SUBSCRIPTION_ID,
      providerSubscriptionId: null,
    });
    expect(t.api.urls).toHaveLength(2);
  });

  it("the second key is accepted during a rotation", async () => {
    const t = setup({
      bindings: {
        WOOVI_WEBHOOK_PUBLIC_KEYS: `${strangerPublicKey},${publicKey}`,
      },
    });
    const { response } = await t.send(approvedBody());
    expect(response.status).toBe(200);
  });

  it("an event Polaris does not use is acknowledged without reading the API", async () => {
    const t = setup();
    const { answer, response } = await t.send(
      JSON.stringify({
        dispute: { email: PAYER.email, name: PAYER.name },
        event: "OPENPIX:DISPUTE_CREATED",
      })
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(answer)).toMatchObject({ received: 0 });
    expect(t.api.urls).toEqual([]);
    expect(t.store.recordEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", () => null],
    ["empty", () => ""],
    ["made over another body", () => sign(approvedBody({ value: 1 }))],
    ["made by another key", () => sign(approvedBody(), strangerKey)],
    ["not base64", () => "!!!not-base64!!!"],
  ] as [string, () => Promise<string | null> | string | null][])(
    "a %s signature is a 401 that says nothing about why, and reads nothing",
    async (_case, make) => {
      const t = setup();
      const { answer, logged, response } = await t.send(
        approvedBody(),
        await make()
      );
      expect(response.status).toBe(401);
      expect(JSON.parse(answer).error).toEqual({ code: "unauthorized" });
      expect(answer).not.toMatch(WHY_WORDS);
      expect(t.api.urls).toEqual([]);
      expect(t.store.recordEvent).not.toHaveBeenCalled();
      expectNoLeak(answer, logged);
    }
  );

  it("a body changed by one byte after signing is a 401", async () => {
    const t = setup();
    const text = approvedBody();
    const signature = await sign(text);
    const changed = text.replace("Pagadora", "Pagadore");
    expect(changed).not.toBe(text);
    const { response } = await t.send(changed, signature);
    expect(response.status).toBe(401);
    expect(t.api.urls).toEqual([]);
  });

  it("the same JSON with its keys reordered or re-spaced keeps no signature (AC-1b)", async () => {
    const text = approvedBody();
    const signature = await sign(text);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(parsed).reverse())
    );
    const spaced = JSON.stringify(parsed, null, 2);
    for (const variant of [reordered, spaced, `${text}\n`]) {
      const t = setup();
      // biome-ignore lint/performance/noAwaitInLoops: One request per variant.
      const { response } = await t.send(variant, signature);
      expect(response.status).toBe(401);
      expect(t.api.urls).toEqual([]);
    }
  });

  it("a body above 64 KiB is a 413, signed or not", async () => {
    const t = setup();
    const big = JSON.stringify({
      event: "PIX_AUTOMATIC_APPROVED",
      filler: "a".repeat(MAX_BYTES),
    });
    const { response } = await t.send(big);
    expect(response.status).toBe(413);
    expect(t.api.urls).toEqual([]);
    expect(t.store.recordEvent).not.toHaveBeenCalled();
  });
});

describe("the configuration: never a 200 without it", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["garbage", "this is not a key"],
    ["three keys", `${"AAAA"},${"BBBB"},${"CCCC"}`],
  ])("WOOVI_WEBHOOK_PUBLIC_KEYS %s gives 503", async (_name, value) => {
    const t = setup({ bindings: { WOOVI_WEBHOOK_PUBLIC_KEYS: value } });
    const { answer, response } = await t.send(approvedBody());
    expect(response.status).toBe(503);
    expect(JSON.parse(answer).error).toEqual({
      code: "billing_provider_not_configured",
    });
    expect(t.api.urls).toEqual([]);
    expect(t.store.recordEvent).not.toHaveBeenCalled();
  });

  it.each(["WOOVI_APP_ID", "WOOVI_BASE_URL"] as const)(
    "a valid signature without %s gives 503",
    async (name) => {
      const t = setup({ bindings: { [name]: undefined } });
      const { answer, response } = await t.send(approvedBody());
      expect(response.status).toBe(503);
      expect(JSON.parse(answer).error).toEqual({
        code: "billing_provider_not_configured",
      });
      expect(t.api.urls).toEqual([]);
    }
  );

  it("a host that is not Woovi's gives 503 and the AppID never leaves", async () => {
    const t = setup({
      bindings: { WOOVI_BASE_URL: "https://api.example.com" },
    });
    const { response } = await t.send(approvedBody());
    expect(response.status).toBe(503);
    expect(t.api.urls).toEqual([]);
  });

  it("checks the signature before the rest of the configuration", async () => {
    const t = setup({ bindings: { WOOVI_APP_ID: undefined } });
    const { response } = await t.send(approvedBody(), "AAAA");
    expect(response.status).toBe(401);
  });
});

describe("what happens when the read back does not give the resource", () => {
  it("an authentic body Woovi would not send is acknowledged and logged as malformed", async () => {
    const t = setup();
    const { answer, response } = await t.send("{not json");
    expect(response.status).toBe(200);
    expect(JSON.parse(answer)).toMatchObject({ duplicates: 0, received: 0 });
    expect(t.logs.warn).toHaveBeenCalledWith(
      "billing_webhook_malformed",
      expect.objectContaining({ provider: "woovi" })
    );
    expect(t.api.urls).toEqual([]);
  });

  it("an authentic body with no globalID is malformed too", async () => {
    const t = setup();
    const { response } = await t.send(
      JSON.stringify({ event: "PIX_AUTOMATIC_APPROVED" })
    );
    expect(response.status).toBe(200);
    expect(t.logs.warn).toHaveBeenCalledWith(
      "billing_webhook_malformed",
      expect.objectContaining({ provider: "woovi" })
    );
    // the kind of event that may have been lost is named, and nothing else
    expect(t.logs.error).toHaveBeenCalledWith(
      "billing_webhook_fact_event_malformed",
      { eventType: "PIX_AUTOMATIC_APPROVED", provider: "woovi" }
    );
  });

  it("an authentic body of an event without a fact is not an error", async () => {
    const t = setup();
    await t.send(JSON.stringify({ event: "PIX_AUTOMATIC_COBR_CREATED" }));
    expect(t.logs.error).not.toHaveBeenCalledWith(
      "billing_webhook_fact_event_malformed",
      expect.anything()
    );
  });

  it("a resource out of shape is acknowledged with the alert, never a 503", async () => {
    const t = setup({
      answers: {
        [SUBSCRIPTION_PATH]: {
          json: { subscription: subscription({ status: 1 }) },
          status: 200,
        },
      },
    });
    const { answer, logged, response } = await t.send(approvedBody());
    expect(response.status).toBe(200);
    expect(t.store.recordEvent).not.toHaveBeenCalled();
    expect(t.logs.error).toHaveBeenCalledWith(
      "billing_provider_response_malformed",
      expect.objectContaining({
        provider: "woovi",
        resourceId: SUBSCRIPTION_LOG_ID,
      })
    );
    expectNoLeak(answer, logged);
  });

  it("a resource the API does not find is acknowledged with the given-up log and the decoded ID", async () => {
    const t = setup({ answers: { [SUBSCRIPTION_PATH]: { status: 404 } } });
    const { answer, logged, response } = await t.send(approvedBody());
    expect(response.status).toBe(200);
    expect(JSON.parse(answer)).toMatchObject({ duplicates: 0, received: 0 });
    expect(t.store.recordEvent).not.toHaveBeenCalled();
    expect(t.logs.error).toHaveBeenCalledWith(
      "billing_webhook_unresolved_given_up",
      expect.objectContaining({
        eventType: "PIX_AUTOMATIC_APPROVED",
        provider: "woovi",
        providerEventId: `PIX_AUTOMATIC_APPROVED:${SUBSCRIPTION_ID}`,
        resourceId: SUBSCRIPTION_LOG_ID,
      })
    );
    expectNoLeak(answer, logged);
  });

  it("an installment not found names the installment", async () => {
    const t = setup({ answers: { [INSTALLMENT_PATH]: { status: 404 } } });
    const { response } = await t.send(paidBody());
    expect(response.status).toBe(200);
    expect(t.logs.error).toHaveBeenCalledWith(
      "billing_webhook_unresolved_given_up",
      expect.objectContaining({
        resourceId: "PaymentSubscriptionInstallment:6b1b2c3d4e5f60718293a4c7",
      })
    );
  });

  it.each([
    ["is down", { status: 502 }],
    ["limits the calls", { status: 429 }],
    ["cannot be reached", "network"],
    ["does not answer within 5 s", "timeout"],
  ] as [string, Answer][])(
    "an API that %s gives a 503, so Woovi sends it again",
    async (_case, failure) => {
      const t = setup({ answers: { [SUBSCRIPTION_PATH]: failure } });
      const { answer, logged, response } = await t.send(approvedBody());
      expect(response.status).toBe(503);
      expect(t.store.recordEvent).not.toHaveBeenCalled();
      expectNoLeak(answer, logged);
      expect(logged).not.toContain("api.woovi-sandbox.com");
    }
  );

  it.each([401, 403])(
    "an AppID the API refuses (%i) gives a 503 and an alert with the status, without the answer",
    async (status) => {
      const t = setup({ answers: { [SUBSCRIPTION_PATH]: { status } } });
      const { answer, logged, response } = await t.send(approvedBody());
      expect(response.status).toBe(503);
      expect(t.logs.error).toHaveBeenCalledWith(
        "billing_provider_rejected",
        expect.objectContaining({ httpStatus: status, provider: "woovi" })
      );
      expectNoLeak(answer, logged);
    }
  );

  it("another 4xx is a 503 without the key alert", async () => {
    const t = setup({ answers: { [SUBSCRIPTION_PATH]: { status: 400 } } });
    const { response } = await t.send(approvedBody());
    expect(response.status).toBe(503);
    expect(t.logs.error).not.toHaveBeenCalledWith(
      "billing_provider_rejected",
      expect.anything()
    );
  });
});

describe("AC-3: nothing of the payer, the Pix payload or the AppID reaches the store, the answer or the log", () => {
  it.each([
    ["an approval", approvedBody],
    ["a paid installment", paidBody],
  ])("%s", async (_name, make) => {
    const t = setup();
    const { answer, logged, response } = await t.send(make());
    expect(response.status).toBe(200);
    const stored = JSON.stringify(t.store.recordEvent.mock.calls);
    expectNoLeak(stored, answer, logged);
    for (const key of ["customer", "paymentLink", "pixRecurring", "taxID"]) {
      expect(stored).not.toContain(key);
    }
  });

  it("every failure path logs only IDs and codes", async () => {
    const failures: [string, Record<string, Answer>][] = [
      ["404", { [SUBSCRIPTION_PATH]: { status: 404 } }],
      ["401", { [SUBSCRIPTION_PATH]: { status: 401 } }],
      ["500", { [SUBSCRIPTION_PATH]: { status: 500 } }],
      ["network", { [SUBSCRIPTION_PATH]: "network" }],
      [
        "malformed",
        { [SUBSCRIPTION_PATH]: { json: { subscription: [] }, status: 200 } },
      ],
    ];
    for (const [, answers] of failures) {
      const t = setup({ answers });
      // biome-ignore lint/performance/noAwaitInLoops: One request per failure.
      const { answer, logged } = await t.send(approvedBody());
      expectNoLeak(answer, logged);
      vi.restoreAllMocks();
    }
  });
});
