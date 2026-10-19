import { describe, expect, it, vi } from "vitest";
import type { FetchInit, FetchLike } from "../http";
import {
  ProviderNotConfiguredError,
  ProviderNotFoundError,
  ProviderRejectedError,
  ProviderResponseMalformedError,
  ProviderUnavailableError,
} from "../provider-port";
import { createAsaasClient } from "./client";

const SANDBOX_KEY = "$aact_hmlg_FAKE_TEST_KEY";
const PRODUCTION_KEY = "$aact_prod_FAKE_TEST_KEY";
const SANDBOX_URL = "https://api-sandbox.asaas.com/v3";
const PRODUCTION_URL = "https://api.asaas.com/v3";
const PERSONAL_BODY =
  '{"errors":[{"description":"Cliente maria@example.com CPF 529.982.247-25 recusado"}]}';
const CHECKOUT = "7a1d5c20-3b4e-4f60-9a8b-0c1d2e3f4a5b";

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
  overrides: { apiKey?: string; baseUrl?: string; timeoutMs?: number } = {}
) {
  return createAsaasClient({
    apiKey: overrides.apiKey ?? SANDBOX_KEY,
    baseUrl: overrides.baseUrl ?? SANDBOX_URL,
    fetch,
    timeoutMs: overrides.timeoutMs ?? 5000,
  });
}

function listPage(count: number, hasMore: boolean): string {
  const data = Array.from({ length: count }, (_, index) => ({ n: index }));
  return JSON.stringify({ data, hasMore, object: "list" });
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

describe("createAsaasClient environment lock", () => {
  const never = recorder(() => ok()).fetch;

  it("accepts the sandbox host with a sandbox key", () => {
    expect(() => clientWith(never)).not.toThrow();
  });

  it("accepts the production host with a production key", () => {
    expect(() =>
      clientWith(never, { apiKey: PRODUCTION_KEY, baseUrl: PRODUCTION_URL })
    ).not.toThrow();
  });

  it("refuses a production key on the sandbox host", () => {
    expect(() => clientWith(never, { apiKey: PRODUCTION_KEY })).toThrow(
      ProviderNotConfiguredError
    );
  });

  it("refuses a sandbox key on the production host", () => {
    expect(() => clientWith(never, { baseUrl: PRODUCTION_URL })).toThrow(
      ProviderNotConfiguredError
    );
  });

  it.each([
    ["http", "http://api-sandbox.asaas.com/v3"],
    ["another host", "https://api.example.com/v3"],
    ["a look-alike host", "https://api-sandbox.asaas.com.evil.test/v3"],
    ["credentials in the URL", "https://user:pass@api-sandbox.asaas.com/v3"],
    ["a user without password", "https://user@api-sandbox.asaas.com/v3"],
    ["a query string", "https://api-sandbox.asaas.com/v3?x=1"],
    ["a fragment", "https://api-sandbox.asaas.com/v3#x"],
    ["not a URL", "api-sandbox.asaas.com"],
    ["empty", ""],
  ])("refuses %s", (_name, baseUrl) => {
    expect(() => clientWith(never, { baseUrl })).toThrow(
      ProviderNotConfiguredError
    );
  });

  it("refuses an empty key", () => {
    expect(() => clientWith(never, { apiKey: "" })).toThrow(
      ProviderNotConfiguredError
    );
    expect(() =>
      clientWith(never, { apiKey: "", baseUrl: PRODUCTION_URL })
    ).toThrow(ProviderNotConfiguredError);
  });

  it("never reaches the network when the configuration is refused", () => {
    const { calls, fetch } = recorder(() => ok());
    expect(() => clientWith(fetch, { apiKey: PRODUCTION_KEY })).toThrow();
    expect(calls).toHaveLength(0);
  });

  it("drops a trailing slash of the base URL", async () => {
    const { calls, fetch } = recorder(() => ok());
    await clientWith(fetch, { baseUrl: `${SANDBOX_URL}/` }).getPayment(
      "pay_abc123"
    );
    expect(calls[0]?.url).toBe(`${SANDBOX_URL}/payments/pay_abc123`);
  });
});

describe("createAsaasClient errors", () => {
  it("maps 404 to ProviderNotFoundError", async () => {
    const { fetch } = recorder(() => ({ status: 404, text: PERSONAL_BODY }));
    const error = await failureOf(() =>
      clientWith(fetch).getPayment("pay_abc123")
    );
    expect(error).toBeInstanceOf(ProviderNotFoundError);
    expect((error as ProviderNotFoundError).status).toBe(404);
    expect((error as ProviderNotFoundError).code).toBe("provider_not_found");
  });

  it.each([500, 502, 503, 429])(
    "maps %i to ProviderUnavailableError",
    async (status) => {
      const { fetch } = recorder(() => ({ status, text: PERSONAL_BODY }));
      const error = await failureOf(() =>
        clientWith(fetch).getPayment("pay_abc123")
      );
      expect(error).toBeInstanceOf(ProviderUnavailableError);
    }
  );

  it.each([400, 401, 403, 422])(
    "maps %i to ProviderRejectedError with the status",
    async (status) => {
      const { fetch } = recorder(() => ({ status, text: PERSONAL_BODY }));
      const error = await failureOf(() =>
        clientWith(fetch).getPayment("pay_abc123")
      );
      expect(error).toBeInstanceOf(ProviderRejectedError);
      expect(error).not.toBeInstanceOf(ProviderNotFoundError);
      expect((error as ProviderRejectedError).status).toBe(status);
    }
  );

  it("maps a network failure to ProviderUnavailableError", async () => {
    const fetch: FetchLike = () =>
      Promise.reject(new Error("connect ECONNREFUSED api-sandbox.asaas.com"));
    const error = await failureOf(() =>
      clientWith(fetch).getPayment("pay_abc123")
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.message).not.toContain("ECONNREFUSED");
  });

  it("maps a body that cannot be read to ProviderUnavailableError", async () => {
    const fetch: FetchLike = () =>
      Promise.resolve({
        status: 200,
        text: () => Promise.reject(new Error("stream reset")),
      });
    const error = await failureOf(() =>
      clientWith(fetch).getPayment("pay_abc123")
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  });

  it("aborts through the timeout signal and maps it to ProviderUnavailableError", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "TimeoutError"))
        );
      });
    const error = await failureOf(() =>
      clientWith(fetch, { timeoutMs: 20 }).getPayment("pay_abc123")
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  });

  it("maps a 200 that is not JSON to ProviderResponseMalformedError", async () => {
    const { fetch } = recorder(() => ok("<html>oops</html>"));
    const error = await failureOf(() =>
      clientWith(fetch).getPayment("pay_abc123")
    );
    expect(error).toBeInstanceOf(ProviderResponseMalformedError);
  });

  it.each([404, 429, 500, 400, 401])(
    "never carries the response body (status %i)",
    async (status) => {
      const { fetch } = recorder(() => ({ status, text: PERSONAL_BODY }));
      const error = await failureOf(() =>
        clientWith(fetch).getPayment("pay_abc123")
      );
      for (const shown of [
        error.message,
        JSON.stringify(error),
        String(error),
        error.stack?.split("\n")[0] ?? "",
      ]) {
        expect(shown).not.toContain("maria@example.com");
        expect(shown).not.toContain("529.982.247-25");
        expect(shown).not.toContain("Cliente");
      }
      expect(Object.values(error)).not.toContain(PERSONAL_BODY);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }
  );

  it("never carries the API key in an error", async () => {
    const { fetch } = recorder(() => ({ status: 401, text: PERSONAL_BODY }));
    const error = await failureOf(() =>
      clientWith(fetch).getPayment("pay_abc123")
    );
    expect(JSON.stringify(error) + String(error)).not.toContain("FAKE_TEST");
  });
});

describe("createAsaasClient requests", () => {
  it("sends the key, the user agent and the abort signal on a GET without a content type", async () => {
    const { calls, fetch } = recorder(() => ok());
    await clientWith(fetch).getPayment("pay_abc123");
    const [call] = calls;
    expect(call?.init.method).toBe("GET");
    expect(call?.init.headers.access_token).toBe(SANDBOX_KEY);
    expect(call?.init.headers["user-agent"]).toBe("polaris-billing");
    expect(call?.init.headers["content-type"]).toBeUndefined();
    expect(call?.init.body).toBeUndefined();
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the content type only with a body", async () => {
    const { calls, fetch } = recorder(() => ok());
    await clientWith(fetch).createCheckout('{"a":1}');
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect(calls[0]?.url).toBe(`${SANDBOX_URL}/checkouts`);
  });

  it("passes a signal that has not aborted yet and aborts after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { calls, fetch } = recorder(() => ok());
      await clientWith(fetch, { timeoutMs: 1000 }).getPayment("pay_abc123");
      const signal = calls[0]?.init.signal;
      expect(signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a payment from /v3/payments/<id>", async () => {
    const { calls, fetch } = recorder(() => ok());
    await clientWith(fetch).getPayment("pay_abc123");
    expect(calls[0]?.url).toBe(
      "https://api-sandbox.asaas.com/v3/payments/pay_abc123"
    );
  });

  it("reads a subscription from /v3/subscriptions/<id>", async () => {
    const { calls, fetch } = recorder(() => ok());
    await clientWith(fetch).getSubscription("sub_xyz789");
    expect(calls[0]?.url).toBe(`${SANDBOX_URL}/subscriptions/sub_xyz789`);
  });

  it("deletes a subscription with DELETE", async () => {
    const { calls, fetch } = recorder(() => ok());
    await clientWith(fetch).deleteSubscription("sub_xyz789");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${SANDBOX_URL}/subscriptions/sub_xyz789`);
  });

  it("refunds a payment with POST and an empty JSON body", async () => {
    const { calls, fetch } = recorder(() => ok());
    await clientWith(fetch).refundPayment("pay_abc123");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe("{}");
    expect(calls[0]?.url).toBe(`${SANDBOX_URL}/payments/pay_abc123/refund`);
  });

  it("cancels a checkout by its UUID", async () => {
    const { calls, fetch } = recorder(() => ok());
    const id = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
    await clientWith(fetch).cancelCheckout(id);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${SANDBOX_URL}/checkouts/${id}/cancel`);
  });
});

describe("createAsaasClient ID checks", () => {
  const badIds = [
    "pay_../x",
    "pay_a?b",
    "sub_x",
    "../",
    "pay_",
    `pay_${"a".repeat(65)}`,
    "pay_a/b",
    "pay_a#b",
    "pay_a b",
    "",
  ];

  it.each(badIds)(
    "refuses the payment ID %j without calling fetch",
    async (id) => {
      const { calls, fetch } = recorder(() => ok());
      const client = clientWith(fetch);
      await expect(settled(() => client.getPayment(id))).rejects.toBeInstanceOf(
        ProviderResponseMalformedError
      );
      await expect(
        settled(() => client.refundPayment(id))
      ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
      expect(calls).toHaveLength(0);
    }
  );

  it("accepts the longest payment ID of 64 characters", async () => {
    const { calls, fetch } = recorder(() => ok());
    await clientWith(fetch).getPayment(`pay_${"a".repeat(64)}`);
    expect(calls).toHaveLength(1);
  });

  it.each(["pay_abc123", "sub_../x", "sub_a?b", "sub_"])(
    "refuses the subscription ID %j without calling fetch",
    async (id) => {
      const { calls, fetch } = recorder(() => ok());
      const client = clientWith(fetch);
      const runs = [
        () => client.getSubscription(id),
        () => client.deleteSubscription(id),
        () => client.listSubscriptionPayments(id),
      ];
      const errors = await Promise.all(
        runs.map((run) => failureOf(() => settled(run)))
      );
      for (const error of errors) {
        expect(error).toBeInstanceOf(ProviderResponseMalformedError);
      }
      expect(calls).toHaveLength(0);
    }
  );

  it.each(["../x", "abc", "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b/x"])(
    "refuses the checkout ID %j without calling fetch",
    async (id) => {
      const { calls, fetch } = recorder(() => ok());
      await expect(
        settled(() => clientWith(fetch).cancelCheckout(id))
      ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
      expect(calls).toHaveLength(0);
    }
  );

  it.each([
    "../",
    "pol_x",
    `${CHECKOUT}&includeDeleted=false`,
    "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b/x",
    "",
  ])("refuses the checkout ID %j without calling fetch", async (checkoutId) => {
    const { calls, fetch } = recorder(() => ok());
    await expect(
      settled(() => clientWith(fetch).listSubscriptionsByCheckout(checkoutId))
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
    expect(calls).toHaveLength(0);
  });
});

describe("createAsaasClient lists", () => {
  const subscriptionsPage = (
    sessions: (string | null)[],
    hasMore: boolean
  ): string =>
    JSON.stringify({
      data: sessions.map((checkoutSession, id) => ({
        checkoutSession,
        id: `s${id}`,
      })),
      hasMore,
      object: "list",
    });

  it("lists subscriptions newest first, deleted ones included, and keeps only those of the checkout", async () => {
    const { calls, fetch } = recorder(() =>
      ok(subscriptionsPage([null, CHECKOUT.toUpperCase(), "other"], false))
    );
    const items = await clientWith(fetch).listSubscriptionsByCheckout(CHECKOUT);
    expect(items).toEqual([
      { checkoutSession: CHECKOUT.toUpperCase(), id: "s1" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${SANDBOX_URL}/subscriptions?includeDeleted=true&sort=dateCreated&order=desc&limit=100&offset=0`
    );
  });

  it("stops at the page where the checkout is found", async () => {
    const { calls, fetch } = recorder((_call, index) =>
      ok(subscriptionsPage(index === 0 ? [CHECKOUT] : ["other"], true))
    );
    await clientWith(fetch).listSubscriptionsByCheckout(CHECKOUT);
    expect(calls).toHaveLength(1);
  });

  it("reads on while the checkout is not found, and gives nothing when it is not there", async () => {
    const { calls, fetch } = recorder((_call, index) =>
      ok(subscriptionsPage(["other"], index < 2))
    );
    expect(
      await clientWith(fetch).listSubscriptionsByCheckout(CHECKOUT)
    ).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.url).toContain("offset=200");
  });

  it("is an error, never an empty answer, when the pages run out before the checkout shows", async () => {
    const { calls, fetch } = recorder(() =>
      ok(subscriptionsPage(["other"], true))
    );
    await expect(
      settled(() => clientWith(fetch).listSubscriptionsByCheckout(CHECKOUT))
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
    expect(calls).toHaveLength(10);
  });

  it("lists the charges of a subscription", async () => {
    const { calls, fetch } = recorder(() => ok(listPage(2, false)));
    const items =
      await clientWith(fetch).listSubscriptionPayments("sub_xyz789");
    expect(items).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      `${SANDBOX_URL}/subscriptions/sub_xyz789/payments?limit=100&offset=0`
    );
  });

  it("reads the next page at offset 100 while hasMore is true", async () => {
    const { calls, fetch } = recorder((_call, index) =>
      ok(index === 0 ? listPage(100, true) : listPage(3, false))
    );
    const items =
      await clientWith(fetch).listSubscriptionPayments("sub_xyz789");
    expect(items).toHaveLength(103);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain("limit=100&offset=100");
  });

  it("reads up to 10 pages", async () => {
    const { calls, fetch } = recorder((_call, index) =>
      ok(listPage(1, index < 9))
    );
    const items =
      await clientWith(fetch).listSubscriptionPayments("sub_xyz789");
    expect(items).toHaveLength(10);
    expect(calls).toHaveLength(10);
    expect(calls[9]?.url).toContain("offset=900");
  });

  it("treats more than 10 pages as malformed", async () => {
    const { calls, fetch } = recorder(() => ok(listPage(1, true)));
    await expect(
      clientWith(fetch).listSubscriptionPayments("sub_xyz789")
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
    expect(calls).toHaveLength(10);
  });

  it.each([
    ["no data", '{"hasMore":false}'],
    ["no hasMore", '{"data":[]}'],
    ["hasMore as a string", '{"data":[],"hasMore":"false"}'],
    ["data that is not a list", '{"data":{},"hasMore":false}'],
    ["a JSON null", "null"],
    ["a JSON array", "[]"],
    ["a JSON string", '"x"'],
  ])("treats %s as malformed", async (_name, text) => {
    const { fetch } = recorder(() => ok(text));
    await expect(
      clientWith(fetch).listSubscriptionPayments("sub_xyz789")
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
  });

  it("keeps the source text of numbers inside the items", async () => {
    const { fetch } = recorder(() =>
      ok('{"data":[{"value":24.90}],"hasMore":false}')
    );
    const [item] = (await clientWith(fetch).listSubscriptionPayments(
      "sub_xyz789"
    )) as { value: { source: string } }[];
    expect(item?.value.source).toBe("24.90");
  });
});
