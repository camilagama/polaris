import type { FetchInit, FetchLike } from "../http";
import { parseProviderJson } from "../json";
import {
  ProviderNotConfiguredError,
  ProviderNotFoundError,
  ProviderRejectedError,
  ProviderResponseMalformedError,
  ProviderUnavailableError,
} from "../provider-port";
import {
  isTaxIdDigits,
  isWooviGlobalId,
  isWooviPayerCorrelationId,
  type WooviGlobalIdKind,
} from "./ids";

/**
 * The HTTP client of the Woovi API v1 (ADR 0101, emenda Woovi). It answers raw
 * resources (numbers kept as text, see `json.ts`); the mapper keeps only the
 * allowed keys. Errors never carry the provider's answer: a Woovi resource
 * carries the payer's name, CPF or CNPJ and e-mail, and the Pix payload
 * (`emv`), and a resource read back is never logged. A 2xx whose body is not
 * JSON (a gateway page) is an outage, not a malformed resource: Woovi is asked
 * to send the event again.
 */

const SANDBOX_HOST = "api.woovi-sandbox.com";
const PRODUCTION_HOST = "api.woovi.com";
/** Pages read of one list, at most; a subscription has one installment per cycle. */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const trailingSlashes = /\/+$/;

export interface WooviClientConfig {
  /** The AppID (secret), sent as `Authorization`. */
  appId: string;
  /** `https://api.woovi-sandbox.com` or `https://api.woovi.com`. */
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs: number;
}

export interface WooviClient {
  cancelSubscription: (subscriptionId: string) => Promise<unknown>;
  /**
   * `POST /api/v1/customer`: creates the payer's customer under Polaris's own
   * `correlationID` (an HMAC of the document, never the document). Woovi keeps
   * one customer per CPF or CNPJ and refuses (400) a second one with another
   * key (sandbox, 20/10/2026).
   */
  createCustomer: (customer: {
    correlationId: string;
    email: string;
    name: string;
    taxId: string;
  }) => Promise<unknown>;
  createSubscription: (body: string) => Promise<unknown>;
  /**
   * `GET /api/v1/customer/{correlationID}`: the customer Polaris created under
   * this key, or null when there is none. One read, never a list: the key is
   * an HMAC of the document, so the URL carries no CPF (ADR 0101, emenda do
   * PR 6). Woovi answers an unknown key with 400 `Cliente não encontrado`
   * (sandbox, 20/10/2026), the only answer read as "none": any other 400 is a
   * rejection and a 404 (a wrong route) is `ProviderNotFoundError`.
   */
  getCustomer: (correlationId: string) => Promise<unknown>;
  getInstallment: (installmentId: string) => Promise<unknown>;
  getSubscription: (subscriptionId: string) => Promise<unknown>;
  listSubscriptionInstallments: (subscriptionId: string) => Promise<unknown[]>;
  /**
   * `POST /api/v1/refund`: gives back a Pix received, named by its
   * `endToEndId`, in full. The `correlationID` is Polaris's and makes a repeat
   * the same refund at Woovi.
   */
  refundPix: (body: string) => Promise<unknown>;
}

/**
 * The base URL, refused unless it is one of the two Woovi hosts over HTTPS with
 * no path, credential, query or fragment. The AppID carries no mark of its
 * environment (unlike Asaas's key prefix), so the host is the only lock in
 * code: that the sandbox AppID only ever goes with the sandbox host is a
 * matter of configuration, checked by hand (runbook `billing-providers.md`).
 */
function checkedBaseUrl(baseUrl: string, appId: string): string {
  const url = URL.parse(baseUrl);
  if (
    !url ||
    appId.length === 0 ||
    url.protocol !== "https:" ||
    !(url.hostname === SANDBOX_HOST || url.hostname === PRODUCTION_HOST) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname.replace(trailingSlashes, "") !== ""
  ) {
    throw new ProviderNotConfiguredError();
  }
  return url.origin;
}

function globalIdPath(kind: WooviGlobalIdKind, id: string): string {
  if (!isWooviGlobalId(kind, id)) {
    throw new ProviderResponseMalformedError();
  }
  return encodeURIComponent(id);
}

/**
 * The key of a customer Polaris created, refused unless it has the shape of
 * one (`isWooviPayerCorrelationId`): a key of any other shape, a CPF among
 * them, never reaches the URL.
 */
function customerPath(correlationId: string): string {
  if (!isWooviPayerCorrelationId(correlationId)) {
    throw new TypeError("invalid_customer_key");
  }
  return encodeURIComponent(correlationId);
}

/** Woovi's answer to a customer key it does not know: 400 with this exact error. */
function customerNotFound({
  status,
  text,
}: {
  status: number;
  text: string;
}): boolean {
  if (status !== 400) {
    return false;
  }
  try {
    const answer: unknown = JSON.parse(text);
    return (
      typeof answer === "object" &&
      answer !== null &&
      (answer as Record<string, unknown>).error === "Cliente não encontrado"
    );
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderResponseMalformedError();
  }
  return value as Record<string, unknown>;
}

/** The object under `key` (`{ subscription: {...} }`), or the answer itself when it is not wrapped. */
function unwrap(answer: unknown, key: string, required: boolean): unknown {
  const source = record(answer);
  if (Object.hasOwn(source, key)) {
    return record(source[key]);
  }
  if (required) {
    throw new ProviderResponseMalformedError();
  }
  return source;
}

export function createWooviClient(config: WooviClientConfig): WooviClient {
  const base = checkedBaseUrl(config.baseUrl, config.appId);

  /** The status and the text of a request; a failure to reach Woovi is an outage. */
  async function request(
    method: FetchInit["method"],
    path: string,
    body?: string
  ): Promise<{ status: number; text: string }> {
    const init: FetchInit = {
      headers: {
        accept: "application/json",
        authorization: config.appId,
        "user-agent": "polaris-billing",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
      // a redirect would carry the AppID to wherever it points: it is refused (a 3xx is a rejection)
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs),
    };
    if (body !== undefined) {
      init.body = body;
    }
    try {
      const response = await config.fetch(`${base}${path}`, init);
      return { status: response.status, text: await response.text() };
    } catch {
      // timeout, abort or network: nothing of the cause is kept (it may echo the URL)
      // biome-ignore lint/style/useErrorCause: The cause stays out on purpose.
      throw new ProviderUnavailableError();
    }
  }

  /** The parsed answer of a 2xx; any other status is the error of its kind. */
  function answerOf({ status, text }: { status: number; text: string }) {
    if (status === 404) {
      throw new ProviderNotFoundError();
    }
    if (status === 429 || status >= 500) {
      throw new ProviderUnavailableError();
    }
    if (status < 200 || status >= 300) {
      throw new ProviderRejectedError(status);
    }
    try {
      return parseProviderJson(text);
    } catch {
      // a 2xx that is not JSON is a gateway page or a cut answer: brief, worth a retry
      // biome-ignore lint/style/useErrorCause: The cause would carry the provider's text.
      throw new ProviderUnavailableError();
    }
  }

  async function call(
    method: FetchInit["method"],
    path: string,
    body?: string
  ): Promise<unknown> {
    return answerOf(await request(method, path, body));
  }

  /** Reads a list page by page; a short page is the last one, whatever `pageInfo` says. */
  async function listAll(path: string, key: string): Promise<unknown[]> {
    const items: unknown[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = record(
        // biome-ignore lint/performance/noAwaitInLoops: Pages are read one after the other.
        await call(
          "GET",
          `${path}${separator}skip=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`
        )
      );
      const list = answer[key];
      if (!Array.isArray(list)) {
        throw new ProviderResponseMalformedError();
      }
      items.push(...list);
      // (the documented example of an empty list says `hasNextPage: true`)
      if (list.length < PAGE_SIZE) {
        return items;
      }
    }
    // more than a list Polaris reads can have: not an answer to trust
    throw new ProviderResponseMalformedError();
  }

  return {
    cancelSubscription: async (subscriptionId) =>
      call(
        "PUT",
        `/api/v1/subscriptions/${globalIdPath("subscription", subscriptionId)}/cancel`
      ),
    createCustomer: async (customer) => {
      customerPath(customer.correlationId);
      if (!isTaxIdDigits(customer.taxId)) {
        throw new TypeError("invalid_tax_id");
      }
      return unwrap(
        await call(
          "POST",
          "/api/v1/customer",
          JSON.stringify({
            correlationID: customer.correlationId,
            email: customer.email,
            name: customer.name,
            taxID: customer.taxId,
          })
        ),
        "customer",
        true
      );
    },
    createSubscription: async (body) =>
      unwrap(
        await call("POST", "/api/v1/subscriptions", body),
        "subscription",
        true
      ),
    async getCustomer(correlationId) {
      const path = `/api/v1/customer/${customerPath(correlationId)}`;
      const answer = await request("GET", path);
      if (customerNotFound(answer)) {
        return null;
      }
      return unwrap(answerOf(answer), "customer", true);
    },
    getInstallment: async (installmentId) =>
      unwrap(
        await call(
          "GET",
          `/api/v1/installments/${globalIdPath("installment", installmentId)}`
        ),
        "installment",
        false
      ),
    getSubscription: async (subscriptionId) =>
      unwrap(
        await call(
          "GET",
          `/api/v1/subscriptions/${globalIdPath("subscription", subscriptionId)}`
        ),
        "subscription",
        true
      ),
    listSubscriptionInstallments: async (subscriptionId) =>
      listAll(
        `/api/v1/subscriptions/${globalIdPath("subscription", subscriptionId)}/installments`,
        "installments"
      ),
    refundPix: async (body) =>
      unwrap(await call("POST", "/api/v1/refund", body), "refund", false),
  };
}
