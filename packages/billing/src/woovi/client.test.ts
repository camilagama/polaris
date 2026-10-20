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
const OTHER_CPF = "11144477735";
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

describe("findCustomerByTaxId", () => {
  const listed = (...taxIds: string[]) =>
    ok(
      JSON.stringify({
        customers: taxIds.map((taxID, index) => ({
          correlationID: `c-${index}`,
          name: "N",
          taxID: { taxID, type: "BR:CPF" },
        })),
        pageInfo: { hasNextPage: false, limit: 100, skip: 0 },
      })
    );

  it("reads the list filtered by the tax ID and keeps the exact match", async () => {
    const { calls, fetch } = recorder(() => listed("11144477735", CPF));
    expect(await clientWith(fetch).findCustomerByTaxId(CPF)).toEqual({
      correlationID: "c-1",
      name: "N",
      taxID: { taxID: CPF, type: "BR:CPF" },
    });
    expect(calls[0]?.url).toBe(
      `${SANDBOX_URL}/api/v1/customer?skip=0&limit=100`
    );
    expect(calls[0]?.init.method).toBe("GET");
    // the tax ID is never in a URL (traces may keep it)
    for (const call of calls) {
      expect(call.url).not.toContain(CPF);
    }
  });

  it("reads the whole list page by page and finds the customer on a later one", async () => {
    const customer = (taxID: string) => ({
      correlationID: "c-late",
      name: "N",
      taxID: { taxID, type: "BR:CPF" },
    });
    const { calls, fetch } = recorder((_call, index) =>
      ok(
        JSON.stringify({
          customers:
            index === 0
              ? Array.from({ length: 100 }, () => customer(OTHER_CPF))
              : [customer(CPF)],
        })
      )
    );

    expect(await clientWith(fetch).findCustomerByTaxId(CPF)).toMatchObject({
      correlationID: "c-late",
    });
    expect(calls.map((call) => call.url.slice(SANDBOX_URL.length))).toEqual([
      "/api/v1/customer?skip=0&limit=100",
      "/api/v1/customer?skip=100&limit=100",
    ]);
    for (const call of calls) {
      expect(call.url).not.toContain(CPF);
    }
  });

  it("more than ten full pages are not an answer to trust", async () => {
    const { calls, fetch } = recorder(() =>
      ok(
        JSON.stringify({
          customers: Array.from({ length: 100 }, () => ({
            correlationID: "c-x",
            name: "N",
            taxID: { taxID: OTHER_CPF, type: "BR:CPF" },
          })),
        })
      )
    );
    const error = await failureOf(() =>
      clientWith(fetch).findCustomerByTaxId(CPF)
    );
    expect(error).toBeInstanceOf(ProviderResponseMalformedError);
    expect(calls).toHaveLength(10);
    for (const call of calls) {
      expect(call.url).not.toContain(CPF);
    }
  });

  it("an empty list, or one without this tax ID, means there is no such customer", async () => {
    expect(
      await clientWith(recorder(() => listed()).fetch).findCustomerByTaxId(CPF)
    ).toBeNull();
    expect(
      await clientWith(
        recorder(() => listed("11144477735")).fetch
      ).findCustomerByTaxId(CPF)
    ).toBeNull();
  });

  it("two customers with the same tax ID is not an answer to trust", async () => {
    const { fetch } = recorder(() => listed(CPF, CPF));
    const error = await failureOf(() =>
      clientWith(fetch).findCustomerByTaxId(CPF)
    );
    expect(error).toBeInstanceOf(ProviderResponseMalformedError);
  });

  it("a 400 is a rejection, never an absent customer", async () => {
    const { fetch } = recorder(() => ({ status: 400, text: PERSONAL_BODY }));
    const error = await failureOf(() =>
      clientWith(fetch).findCustomerByTaxId(CPF)
    );
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect(JSON.stringify(error)).not.toContain(CPF);
  });

  it("a 401 is a rejection, not an absent customer", async () => {
    const { fetch } = recorder(() => ({ status: 401, text: PERSONAL_BODY }));
    const error = await failureOf(() =>
      clientWith(fetch).findCustomerByTaxId(CPF)
    );
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect((error as ProviderRejectedError).status).toBe(401);
  });

  it.each(["529.982.247-25", "../x", "", "123"])(
    "refuses the tax ID %j before the network",
    async (taxId) => {
      const { calls, fetch } = recorder(() => ok());
      const error = await failureOf(() =>
        settled(() => clientWith(fetch).findCustomerByTaxId(taxId))
      );
      expect(error).toBeInstanceOf(TypeError);
      expect(calls).toHaveLength(0);
    }
  );

  it("a 400 elsewhere is still a rejection", async () => {
    const { fetch } = recorder(() => ({ status: 400, text: PERSONAL_BODY }));
    const error = await failureOf(() =>
      clientWith(fetch).getSubscription(SUBSCRIPTION_ID)
    );
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect((error as ProviderRejectedError).status).toBe(400);
  });
});

describe("updateCustomer", () => {
  it("sends a PATCH with only the name and the e-mail", async () => {
    const { calls, fetch } = recorder(() =>
      ok(JSON.stringify({ customer: { correlationID: "cust-1", name: "Ana" } }))
    );
    await clientWith(fetch).updateCustomer("cust-1", {
      email: "ana@example.com",
      name: "Ana",
    });
    const [call] = calls;
    expect(call?.init.method).toBe("PATCH");
    expect(call?.url).toBe(`${SANDBOX_URL}/api/v1/customer/cust-1`);
    expect(call?.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call?.init.body ?? "")).toEqual({
      email: "ana@example.com",
      name: "Ana",
    });
  });

  it("refuses a correlation ID that could change the path, before the network", async () => {
    const { calls, fetch } = recorder(() => ok());
    for (const id of ["../x", "a/b", "", "a?b"]) {
      // biome-ignore lint/performance/noAwaitInLoops: One call per ID.
      const error = await failureOf(() =>
        settled(() =>
          clientWith(fetch).updateCustomer(id, {
            email: "a@example.com",
            name: "A",
          })
        )
      );
      expect(error).toBeInstanceOf(ProviderResponseMalformedError);
    }
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

describe("listSubscriptions", () => {
  const page = (count: number) =>
    JSON.stringify({
      pageInfo: { hasNextPage: true, skip: 0 },
      subscriptions: Array.from({ length: count }, (_, index) => ({
        n: index,
      })),
    });

  it("a short page is the last one", async () => {
    const { calls, fetch } = recorder(() => ok(page(3)));
    expect(await clientWith(fetch).listSubscriptions()).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      `${SANDBOX_URL}/api/v1/subscriptions?skip=0&limit=100`
    );
  });

  it("reads 100 by 100 until a short page", async () => {
    const { calls, fetch } = recorder((_call, index) =>
      ok(page(index < 2 ? 100 : 5))
    );
    expect(await clientWith(fetch).listSubscriptions()).toHaveLength(205);
    expect(calls.map((call) => call.url.slice(SANDBOX_URL.length))).toEqual([
      "/api/v1/subscriptions?skip=0&limit=100",
      "/api/v1/subscriptions?skip=100&limit=100",
      "/api/v1/subscriptions?skip=200&limit=100",
    ]);
  });

  it("more than ten full pages are not an answer to trust", async () => {
    const { calls, fetch } = recorder(() => ok(page(100)));
    const error = await failureOf(() => clientWith(fetch).listSubscriptions());
    expect(error).toBeInstanceOf(ProviderResponseMalformedError);
    expect(calls).toHaveLength(10);
  });

  it("refuses a page without the list", async () => {
    const { fetch } = recorder(() => ok('{"pageInfo":{}}'));
    const error = await failureOf(() => clientWith(fetch).listSubscriptions());
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
