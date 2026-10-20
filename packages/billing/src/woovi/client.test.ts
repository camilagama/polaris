import { describe, expect, it } from "vitest";
import type { FetchInit, FetchLike } from "../http";
import {
  ProviderNotConfiguredError,
  ProviderNotFoundError,
  ProviderRejectedError,
  ProviderResponseMalformedError,
  ProviderUnavailableError,
} from "../provider-port";
import { createWooviClient } from "./client";
import {
  globalId,
  INSTALLMENT_ID,
  SUBSCRIPTION_ID,
  subscriptionJson,
} from "./test-fixtures";

const APP_ID = "fake-app-id-0123";
const SANDBOX_URL = "https://api.woovi-sandbox.com";
const PRODUCTION_URL = "https://api.woovi.com";
const PERSONAL_BODY =
  '{"error":"Cliente maria@example.com CPF 52998224725 recusado"}';
const CPF = "52998224725";
const PAYER_KEY = "polaris-payer-0123456789abcdef0123456789abcdef";
const UNENCODED = /[=+/]/;

interface Call {
  init: FetchInit;
  url: string;
}

function recorder(
  respond: (call: Call, index: number) => { status: number; text: string }
) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const call = { init, url };
    calls.push(call);
    const answer = respond(call, calls.length - 1);
    return Promise.resolve({
      status: answer.status,
      text: () => Promise.resolve(answer.text),
    });
  };
  return { calls, fetch };
}

function ok(text = "{}") {
  return { status: 200, text };
}

function clientWith(
  fetch: FetchLike,
  overrides: { appId?: string; baseUrl?: string; timeoutMs?: number } = {}
) {
  return createWooviClient({
    appId: overrides.appId ?? APP_ID,
    baseUrl: overrides.baseUrl ?? SANDBOX_URL,
    fetch,
    timeoutMs: overrides.timeoutMs ?? 5000,
  });
}

/** Runs the call inside a promise: the client may refuse an ID by throwing before it returns one. */
function settled<T>(run: () => Promise<T>): Promise<T> {
  return (async () => await run())();
}

async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected_failure");
}

function installmentsPage(count: number): string {
  const installments = Array.from({ length: count }, (_, index) => ({
    n: index,
  }));
  return JSON.stringify({
    installments,
    pageInfo: { hasNextPage: true, skip: 0 },
  });
}

/** A subscription as the API answers it: wrapped. */
const wrappedSubscription = () =>
  ok(JSON.stringify({ subscription: subscriptionJson() }));

describe("createWooviClient host lock", () => {
  const never = recorder(() => ok()).fetch;

  it.each([SANDBOX_URL, PRODUCTION_URL, `${SANDBOX_URL}/`])(
    "accepts %s",
    (baseUrl) => {
      expect(() => clientWith(never, { baseUrl })).not.toThrow();
    }
  );

  it.each([
    ["http", "http://api.woovi-sandbox.com"],
    ["another host", "https://api.example.com"],
    ["a look-alike host", "https://api.woovi-sandbox.com.evil.test"],
    ["a look-alike prefix", "https://evil-api.woovi.com"],
    ["a subdomain", "https://x.api.woovi.com"],
    ["a path", "https://api.woovi-sandbox.com/api/v1"],
    ["a port", "https://api.woovi-sandbox.com:8443"],
    ["credentials", "https://user:pass@api.woovi-sandbox.com"],
    ["a user without password", "https://user@api.woovi.com"],
    ["a query string", "https://api.woovi-sandbox.com?x=1"],
    ["a fragment", "https://api.woovi-sandbox.com#x"],
    ["not a URL", "api.woovi-sandbox.com"],
    ["empty", ""],
  ])("refuses %s", (_name, baseUrl) => {
    expect(() => clientWith(never, { baseUrl })).toThrow(
      ProviderNotConfiguredError
    );
  });

  it("refuses an empty AppID on either host", () => {
    expect(() => clientWith(never, { appId: "" })).toThrow(
      ProviderNotConfiguredError
    );
    expect(() =>
      clientWith(never, { appId: "", baseUrl: PRODUCTION_URL })
    ).toThrow(ProviderNotConfiguredError);
  });

  it("never reaches the network when the configuration is refused", () => {
    const { calls, fetch } = recorder(() => ok());
    expect(() => clientWith(fetch, { appId: "" })).toThrow();
    expect(calls).toHaveLength(0);
  });

  it("drops a trailing slash of the base URL", async () => {
    const { calls, fetch } = recorder(wrappedSubscription);
    await clientWith(fetch, { baseUrl: `${SANDBOX_URL}/` }).getSubscription(
      SUBSCRIPTION_ID
    );
    expect(calls[0]?.url.startsWith(`${SANDBOX_URL}/api/v1/`)).toBe(true);
  });
});

describe("what a request carries", () => {
  it("sends the AppID as Authorization, never follows a redirect, and sets a signal", async () => {
    const { calls, fetch } = recorder(wrappedSubscription);
    await clientWith(fetch).getSubscription(SUBSCRIPTION_ID);
    const [call] = calls;
    expect(call?.init.method).toBe("GET");
    expect(call?.init.headers.authorization).toBe(APP_ID);
    expect(call?.init.headers.accept).toBe("application/json");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(call?.init.body).toBeUndefined();
    expect(call?.init.headers["content-type"]).toBeUndefined();
  });

  it("encodes the globalID in the path: the = of the padding goes as %3D", async () => {
    for (const [id, padding] of [
      [SUBSCRIPTION_ID, "%3D"],
      [globalId("PaymentSubscription"), "%3D"],
    ] as const) {
      const { calls, fetch } = recorder(wrappedSubscription);
      // biome-ignore lint/performance/noAwaitInLoops: One call per ID.
      await clientWith(fetch).getSubscription(id);
      const url = calls[0]?.url ?? "";
      expect(url).toBe(
        `${SANDBOX_URL}/api/v1/subscriptions/${encodeURIComponent(id)}`
      );
      const path = url.slice(`${SANDBOX_URL}/api/v1/subscriptions/`.length);
      expect(path).not.toMatch(UNENCODED);
      expect(path.endsWith(padding)).toBe(true);
    }
  });

  it("encodes an installment ID, whose padding is two =", async () => {
    const { calls, fetch } = recorder(() => ok("{}"));
    await clientWith(fetch).getInstallment(INSTALLMENT_ID);
    expect(calls[0]?.url.endsWith("%3D%3D")).toBe(true);
  });

  it("builds the installment and cancel paths", async () => {
    const { calls, fetch } = recorder(() => ok("{}"));
    const client = clientWith(fetch);
    await client.getInstallment(INSTALLMENT_ID);
    await client.cancelSubscription(SUBSCRIPTION_ID);
    expect(calls[0]?.url).toBe(
      `${SANDBOX_URL}/api/v1/installments/${encodeURIComponent(INSTALLMENT_ID)}`
    );
    expect(calls[1]?.init.method).toBe("PUT");
    expect(calls[1]?.url).toBe(
      `${SANDBOX_URL}/api/v1/subscriptions/${encodeURIComponent(SUBSCRIPTION_ID)}/cancel`
    );
  });

  it("unwraps { subscription } and answers an installment as it comes", async () => {
    const wrapped = recorder(() =>
      ok(JSON.stringify({ subscription: { globalID: SUBSCRIPTION_ID } }))
    );
    expect(
      await clientWith(wrapped.fetch).getSubscription(SUBSCRIPTION_ID)
    ).toEqual({
      globalID: SUBSCRIPTION_ID,
    });
    const bare = recorder(() =>
      ok(JSON.stringify({ globalID: INSTALLMENT_ID }))
    );
    expect(await clientWith(bare.fetch).getInstallment(INSTALLMENT_ID)).toEqual(
      {
        globalID: INSTALLMENT_ID,
      }
    );
  });

  it("refuses a subscription answer that is not wrapped or not an object", async () => {
    for (const text of ["{}", "[]", "null", '{"subscription":[]}']) {
      const { fetch } = recorder(() => ok(text));
      // biome-ignore lint/performance/noAwaitInLoops: One call per answer.
      const error = await failureOf(() =>
        clientWith(fetch).getSubscription(SUBSCRIPTION_ID)
      );
      expect(error).toBeInstanceOf(ProviderResponseMalformedError);
    }
  });

  it("a 2xx that is not JSON (a gateway page) is an outage, worth a retry", async () => {
    const { fetch } = recorder(() => ok("<html>"));
    const error = await failureOf(() =>
      clientWith(fetch).getSubscription(SUBSCRIPTION_ID)
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("an ID is checked before the network", () => {
  it.each([
    ["a path", "../x"],
    ["a query", `${SUBSCRIPTION_ID}?x=1`],
    ["an empty ID", ""],
    ["an ID of another type", globalId("Customer")],
    ["an installment ID", INSTALLMENT_ID],
  ])("refuses %s as a subscription ID", async (_name, id) => {
    const { calls, fetch } = recorder(() => ok());
    const client = clientWith(fetch);
    for (const run of [
      () => client.getSubscription(id),
      () => client.cancelSubscription(id),
      () => client.listSubscriptionInstallments(id),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: One call per method.
      const error = await failureOf(() => settled(run));
      expect(error).toBeInstanceOf(ProviderResponseMalformedError);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a subscription ID as an installment ID", async () => {
    const { calls, fetch } = recorder(() => ok());
    const error = await failureOf(() =>
      settled(() => clientWith(fetch).getInstallment(SUBSCRIPTION_ID))
    );
    expect(error).toBeInstanceOf(ProviderResponseMalformedError);
    expect(calls).toHaveLength(0);
  });
});

describe("createWooviClient errors", () => {
  it("maps 404 to ProviderNotFoundError", async () => {
    const { fetch } = recorder(() => ({ status: 404, text: PERSONAL_BODY }));
    const error = await failureOf(() =>
      clientWith(fetch).getSubscription(SUBSCRIPTION_ID)
    );
    expect(error).toBeInstanceOf(ProviderNotFoundError);
    expect((error as ProviderNotFoundError).code).toBe("provider_not_found");
  });

  it.each([500, 502, 503, 429])(
    "maps %i to ProviderUnavailableError",
    async (status) => {
      const { fetch } = recorder(() => ({ status, text: PERSONAL_BODY }));
      const error = await failureOf(() =>
        clientWith(fetch).getSubscription(SUBSCRIPTION_ID)
      );
      expect(error).toBeInstanceOf(ProviderUnavailableError);
    }
  );

  it.each([400, 401, 403, 422, 301])(
    "maps %i to ProviderRejectedError with the status",
    async (status) => {
      const { fetch } = recorder(() => ({ status, text: PERSONAL_BODY }));
      const error = await failureOf(() =>
        clientWith(fetch).getSubscription(SUBSCRIPTION_ID)
      );
      expect(error).toBeInstanceOf(ProviderRejectedError);
      expect(error).not.toBeInstanceOf(ProviderNotFoundError);
      expect((error as ProviderRejectedError).status).toBe(status);
    }
  );

  it("maps a network failure to ProviderUnavailableError, without its cause", async () => {
    const fetch: FetchLike = () =>
      Promise.reject(new Error("connect ECONNREFUSED api.woovi-sandbox.com"));
    const error = await failureOf(() =>
      clientWith(fetch).getSubscription(SUBSCRIPTION_ID)
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.message).not.toContain("ECONNREFUSED");
    expect(error.cause).toBeUndefined();
  });

  it("maps a body that cannot be read to ProviderUnavailableError", async () => {
    const fetch: FetchLike = () =>
      Promise.resolve({
        status: 200,
        text: () => Promise.reject(new Error("stream reset")),
      });
    const error = await failureOf(() =>
      clientWith(fetch).getSubscription(SUBSCRIPTION_ID)
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  });

  it("aborts through the timeout signal and maps it to ProviderUnavailableError", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    const error = await failureOf(() =>
      clientWith(fetch, { timeoutMs: 10 }).getSubscription(SUBSCRIPTION_ID)
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  });

  it.each([404, 400, 401, 422, 429, 500])(
    "an error %i carries nothing of the answer: message, JSON and cause",
    async (status) => {
      const { fetch } = recorder(() => ({ status, text: PERSONAL_BODY }));
      const error = await failureOf(() =>
        clientWith(fetch).getSubscription(SUBSCRIPTION_ID)
      );
      const shown = `${error.message} ${error.stack ?? ""} ${JSON.stringify(error)} ${String(error.cause)}`;
      for (const leak of [CPF, "maria@example.com", "Cliente", APP_ID]) {
        expect(shown).not.toContain(leak);
      }
    }
  );
});

describe("getCustomer", () => {
  const customer = () => ({
    correlationID: PAYER_KEY,
    email: "maria@example.com",
    name: "Maria",
    taxID: { taxID: CPF, type: "BR:CPF" },
  });

  it("reads one customer by its key and unwraps { customer }", async () => {
    const { calls, fetch } = recorder(() =>
      ok(JSON.stringify({ customer: customer() }))
    );
    expect(await clientWith(fetch).getCustomer(PAYER_KEY)).toEqual(customer());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${SANDBOX_URL}/api/v1/customer/${PAYER_KEY}`);
    // the tax ID is never in a URL (traces may keep it)
    expect(calls[0]?.url).not.toContain(CPF);
  });

  it("an answer without { customer } is malformed", async () => {
    for (const text of ["{}", "[]", "null", '{"customer":[]}']) {
      const { fetch } = recorder(() => ok(text));
      // biome-ignore lint/performance/noAwaitInLoops: One call per answer.
      const error = await failureOf(() =>
        clientWith(fetch).getCustomer(PAYER_KEY)
      );
      expect(error).toBeInstanceOf(ProviderResponseMalformedError);
    }
  });

  it("a 400 `Cliente não encontrado` is an absent customer", async () => {
    const { calls, fetch } = recorder(() => ({
      status: 400,
      text: '{"error":"Cliente não encontrado"}',
    }));
    expect(await clientWith(fetch).getCustomer(PAYER_KEY)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("a 404 is a wrong route, never an absent customer", async () => {
    const { fetch } = recorder(() => ({ status: 404, text: PERSONAL_BODY }));
    await expect(clientWith(fetch).getCustomer(PAYER_KEY)).rejects.toThrow(
      ProviderNotFoundError
    );
  });

  it.each([
    ["another error text", '{"error":"Outro erro"}'],
    ["personal data", PERSONAL_BODY],
    ["a body that is not JSON", "<html>"],
    ["an empty body", ""],
    ["a body that is null", "null"],
    ["an error that is not text", '{"error":["Cliente não encontrado"]}'],
  ])(
    "a 400 with %s is a rejection, never an absent customer",
    async (_name, text) => {
      const { fetch } = recorder(() => ({ status: 400, text }));
      const error = await failureOf(() =>
        clientWith(fetch).getCustomer(PAYER_KEY)
      );
      expect(error).toBeInstanceOf(ProviderRejectedError);
      expect((error as ProviderRejectedError).status).toBe(400);
      expect(JSON.stringify(error)).not.toContain(CPF);
    }
  );

  it("the absence is only a 400 or a 404: a 401 is a rejection", async () => {
    const { fetch } = recorder(() => ({
      status: 401,
      text: '{"error":"Cliente não encontrado"}',
    }));
    const error = await failureOf(() =>
      clientWith(fetch).getCustomer(PAYER_KEY)
    );
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect((error as ProviderRejectedError).status).toBe(401);
  });

  it.each([500, 503, 429])(
    "a %i is an outage, not an absent customer",
    async (status) => {
      const { fetch } = recorder(() => ({ status, text: PERSONAL_BODY }));
      const error = await failureOf(() =>
        clientWith(fetch).getCustomer(PAYER_KEY)
      );
      expect(error).toBeInstanceOf(ProviderUnavailableError);
    }
  );

  it.each([
    ["a CPF", CPF],
    ["a CNPJ", "11222333000181"],
    ["a path step", ".."],
    ["a path", "../x"],
    ["a plain key", "cust-1"],
    ["a key with a path", `${PAYER_KEY}/x`],
    ["a key with a query", `${PAYER_KEY}?x=1`],
    ["an empty key", ""],
  ])("refuses %s as the key before the network", async (_name, key) => {
    const { calls, fetch } = recorder(() => ok());
    const error = await failureOf(() =>
      settled(() => clientWith(fetch).getCustomer(key))
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe("invalid_customer_key");
    expect(calls).toHaveLength(0);
  });
});

describe("createCustomer", () => {
  const input = {
    correlationId: PAYER_KEY,
    email: "maria@example.com",
    name: "Maria",
    taxId: CPF,
  };
  const created = () => ({
    correlationID: PAYER_KEY,
    email: input.email,
    name: input.name,
    taxID: { taxID: CPF, type: "BR:CPF" },
  });

  it("posts the key, e-mail, name and tax ID, and unwraps { customer }", async () => {
    const { calls, fetch } = recorder(() =>
      ok(JSON.stringify({ customer: created() }))
    );
    expect(await clientWith(fetch).createCustomer(input)).toEqual(created());
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.init.method).toBe("POST");
    expect(call?.url).toBe(`${SANDBOX_URL}/api/v1/customer`);
    expect(call?.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call?.init.body ?? "")).toEqual({
      correlationID: PAYER_KEY,
      email: input.email,
      name: input.name,
      taxID: CPF,
    });
    // the tax ID goes in the body, never in the URL
    expect(call?.url).not.toContain(CPF);
  });

  it("an answer without { customer } is malformed", async () => {
    const { fetch } = recorder(() => ok("{}"));
    const error = await failureOf(() =>
      clientWith(fetch).createCustomer(input)
    );
    expect(error).toBeInstanceOf(ProviderResponseMalformedError);
  });

  it("a 400 is a rejection carrying nothing of the answer", async () => {
    const { fetch } = recorder(() => ({ status: 400, text: PERSONAL_BODY }));
    const error = await failureOf(() =>
      clientWith(fetch).createCustomer(input)
    );
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect((error as ProviderRejectedError).status).toBe(400);
    const shown = `${error.message} ${JSON.stringify(error)} ${String(error.cause)}`;
    expect(shown).not.toContain(CPF);
    expect(shown).not.toContain("maria@example.com");
  });

  it("a 5xx is an outage", async () => {
    const { fetch } = recorder(() => ({ status: 503, text: PERSONAL_BODY }));
    const error = await failureOf(() =>
      clientWith(fetch).createCustomer(input)
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  });

  it.each([
    ["a CPF as the key", { correlationId: CPF }],
    ["a path step as the key", { correlationId: ".." }],
    ["a plain key", { correlationId: "cust-1" }],
    ["a tax ID with punctuation", { taxId: "529.982.247-25" }],
    ["a tax ID of the wrong length", { taxId: "5299822472" }],
    ["an empty tax ID", { taxId: "" }],
  ])("refuses %s before the network", async (_name, override) => {
    const { calls, fetch } = recorder(() => ok());
    const error = await failureOf(() =>
      settled(() => clientWith(fetch).createCustomer({ ...input, ...override }))
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("listSubscriptionInstallments", () => {
  it("a short page is the last one", async () => {
    const { calls, fetch } = recorder(() => ok(installmentsPage(3)));
    const items =
      await clientWith(fetch).listSubscriptionInstallments(SUBSCRIPTION_ID);
    expect(items).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${SANDBOX_URL}/api/v1/subscriptions/${encodeURIComponent(SUBSCRIPTION_ID)}/installments?skip=0&limit=100`
    );
  });

  it("reads the next page after a full one", async () => {
    const { calls, fetch } = recorder((_call, index) =>
      ok(installmentsPage(index === 0 ? 100 : 2))
    );
    const items =
      await clientWith(fetch).listSubscriptionInstallments(SUBSCRIPTION_ID);
    expect(items).toHaveLength(102);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("?skip=100&limit=100");
  });

  it("ten full pages are not an answer to trust", async () => {
    const { calls, fetch } = recorder(() => ok(installmentsPage(100)));
    const error = await failureOf(() =>
      clientWith(fetch).listSubscriptionInstallments(SUBSCRIPTION_ID)
    );
    expect(error).toBeInstanceOf(ProviderResponseMalformedError);
    expect(calls).toHaveLength(10);
  });

  it("refuses a page without a list", async () => {
    const { fetch } = recorder(() => ok('{"pageInfo":{}}'));
    const error = await failureOf(() =>
      clientWith(fetch).listSubscriptionInstallments(SUBSCRIPTION_ID)
    );
    expect(error).toBeInstanceOf(ProviderResponseMalformedError);
  });
});

describe("refundPix", () => {
  it("posts the given body to /api/v1/refund, as JSON", async () => {
    const body = '{"correlationID":"refund:a:b","value":2490}';
    const { calls, fetch } = recorder(() =>
      ok(JSON.stringify({ refund: { status: "IN_PROCESSING" } }))
    );

    const answer = await clientWith(fetch).refundPix(body);

    expect(answer).toEqual({ status: "IN_PROCESSING" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SANDBOX_URL}/api/v1/refund`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(body);
    expect(calls[0]?.init.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.init.headers.authorization).toBe(APP_ID);
  });

  it("a refusal carries nothing of the answer", async () => {
    const { fetch } = recorder(() => ({ status: 422, text: PERSONAL_BODY }));
    const error = await failureOf(() => clientWith(fetch).refundPix("{}"));
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect(JSON.stringify(error)).not.toContain(CPF);
    expect(error.message).not.toContain(CPF);
  });
});
