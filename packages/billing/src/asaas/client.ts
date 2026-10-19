import type { FetchInit, FetchLike } from "../http";
import { parseProviderJson } from "../json";
import {
  ProviderNotConfiguredError,
  ProviderNotFoundError,
  ProviderRejectedError,
  ProviderResponseMalformedError,
  ProviderUnavailableError,
} from "../provider-port";
import { isAsaasId, normalizeCheckoutId } from "./ids";

/**
 * The HTTP client of the Asaas API v3 (ADR 0101). It answers raw resources
 * (numbers kept as text, see `json.ts`); the mapper keeps only the allowed keys.
 * Errors never carry the provider's answer: an error body can hold personal
 * data, and a resource read back is never logged.
 */

const SANDBOX_HOST = "api-sandbox.asaas.com";
const PRODUCTION_HOST = "api.asaas.com";
/** Asaas sandbox keys start with this prefix; production keys never do. */
const SANDBOX_KEY_PREFIX = "$aact_hmlg_";
/** Pages read of one list, at most; a subscription has one charge per cycle. */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

export interface AsaasClientConfig {
  apiKey: string;
  /** `https://api-sandbox.asaas.com/v3` or `https://api.asaas.com/v3`. */
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs: number;
}

export interface AsaasClient {
  cancelCheckout: (checkoutId: string) => Promise<unknown>;
  createCheckout: (body: string) => Promise<unknown>;
  deleteSubscription: (subscriptionId: string) => Promise<unknown>;
  getPayment: (paymentId: string) => Promise<unknown>;
  getSubscription: (subscriptionId: string) => Promise<unknown>;
  listSubscriptionPayments: (subscriptionId: string) => Promise<unknown[]>;
  /**
   * The subscription(s) a checkout created, deleted ones included. The API has
   * no `checkoutSession` filter (it ignores the parameter: sandbox, 19/10/2026),
   * so the list is read newest first and filtered here, stopping at the page
   * where the checkout is found. A checkout makes one subscription. A checkout
   * not found within the pages read is an error, never an empty answer.
   */
  listSubscriptionsByCheckout: (checkoutId: string) => Promise<unknown[]>;
  refundPayment: (paymentId: string) => Promise<unknown>;
}

/**
 * The base URL, refused unless it is one of the two Asaas hosts and the key is
 * of that environment: a production key never runs against the sandbox, and a
 * sandbox key never against production.
 */
function checkedBaseUrl(baseUrl: string, apiKey: string): string {
  const url = URL.parse(baseUrl);
  if (!url) {
    throw new ProviderNotConfiguredError();
  }
  const sandboxKey = apiKey.startsWith(SANDBOX_KEY_PREFIX);
  const hostMatchesKey =
    (url.hostname === SANDBOX_HOST && sandboxKey) ||
    (url.hostname === PRODUCTION_HOST && !sandboxKey);
  if (
    apiKey.length === 0 ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !hostMatchesKey
  ) {
    throw new ProviderNotConfiguredError();
  }
  return `${url.origin}${url.pathname.replace(trailingSlashes, "")}`;
}

function pathId(id: string, valid: (value: string) => boolean): string {
  if (!valid(id)) {
    throw new ProviderResponseMalformedError();
  }
  return encodeURIComponent(id);
}

const uuidPattern =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const trailingSlashes = /\/+$/;

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

export function createAsaasClient(config: AsaasClientConfig): AsaasClient {
  const base = checkedBaseUrl(config.baseUrl, config.apiKey);

  async function call(
    method: FetchInit["method"],
    path: string,
    body?: string
  ): Promise<unknown> {
    const init: FetchInit = {
      headers: {
        accept: "application/json",
        access_token: config.apiKey,
        "user-agent": "polaris-billing",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
      // a redirect would carry the key to wherever it points: it is refused (a 3xx is a rejection)
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs),
    };
    if (body !== undefined) {
      init.body = body;
    }
    let status: number;
    let text: string;
    try {
      const response = await config.fetch(`${base}${path}`, init);
      ({ status } = response);
      text = await response.text();
    } catch {
      // timeout, abort or network: nothing of the cause is kept (it may echo the URL)
      // biome-ignore lint/style/useErrorCause: The cause stays out on purpose.
      throw new ProviderUnavailableError();
    }
    if (status === 404) {
      throw new ProviderNotFoundError();
    }
    if (status === 429 || status >= 500) {
      throw new ProviderUnavailableError();
    }
    if (status < 200 || status >= 300) {
      throw new ProviderRejectedError(status);
    }
    return parseProviderJson(text);
  }

  async function list(
    path: string,
    keep: (item: unknown) => boolean = () => true,
    stopAfterKept = false
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      // biome-ignore lint/performance/noAwaitInLoops: Pages are read one after the other.
      const answer = await call(
        "GET",
        `${path}${separator}limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`
      );
      if (typeof answer !== "object" || answer === null) {
        throw new ProviderResponseMalformedError();
      }
      const { data, hasMore } = answer as { data?: unknown; hasMore?: unknown };
      if (!Array.isArray(data) || typeof hasMore !== "boolean") {
        throw new ProviderResponseMalformedError();
      }
      const kept = data.filter(keep);
      items.push(...kept);
      if (!hasMore || (stopAfterKept && kept.length > 0)) {
        return items;
      }
    }
    // more than the pages read and nothing found (a checkout older than the 1000
    // newest subscriptions, or more charges than a subscription can have): an
    // empty answer would read as "nothing to cancel", so it is not an answer to trust
    throw new ProviderResponseMalformedError();
  }

  return {
    cancelCheckout: async (checkoutId) =>
      call("POST", `/checkouts/${pathId(checkoutId, isUuid)}/cancel`),
    createCheckout: async (body) => call("POST", "/checkouts", body),
    deleteSubscription: async (subscriptionId) =>
      call(
        "DELETE",
        `/subscriptions/${pathId(subscriptionId, (id) => isAsaasId("sub", id))}`
      ),
    getPayment: async (paymentId) =>
      call(
        "GET",
        `/payments/${pathId(paymentId, (id) => isAsaasId("pay", id))}`
      ),
    getSubscription: async (subscriptionId) =>
      call(
        "GET",
        `/subscriptions/${pathId(subscriptionId, (id) => isAsaasId("sub", id))}`
      ),
    listSubscriptionPayments: async (subscriptionId) =>
      list(
        `/subscriptions/${pathId(subscriptionId, (id) => isAsaasId("sub", id))}/payments`
      ),
    listSubscriptionsByCheckout: async (checkoutId) => {
      const wanted = normalizeCheckoutId(checkoutId);
      if (wanted === null) {
        throw new ProviderResponseMalformedError();
      }
      return await list(
        "/subscriptions?includeDeleted=true&sort=dateCreated&order=desc",
        (item) =>
          typeof item === "object" &&
          item !== null &&
          normalizeCheckoutId(
            (item as Record<string, unknown>).checkoutSession
          ) === wanted,
        true
      );
    },
    refundPayment: async (paymentId) =>
      call(
        "POST",
        `/payments/${pathId(paymentId, (id) => isAsaasId("pay", id))}/refund`,
        "{}"
      ),
  };
}
