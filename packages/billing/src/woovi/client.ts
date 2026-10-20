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
  isWooviCustomerCorrelationId,
  isWooviGlobalId,
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
  createSubscription: (body: string) => Promise<unknown>;
  /**
   * The customer with this CPF or CNPJ, or null when Woovi has none. Read from
   * the whole list of customers (`GET /api/v1/customer`, at most 1000), never
   * from a URL that carries the document: `?taxID=` and `/customer/{taxID}`
   * would put the CPF in the request's URL, which the platform's traces of
   * outbound requests may keep (ADR 0101, emenda do PR 6). Only an entry with
   * this exact tax ID counts, and more than one is not an answer to trust.
   */
  findCustomerByTaxId: (taxId: string) => Promise<unknown>;
  getInstallment: (installmentId: string) => Promise<unknown>;
  getSubscription: (subscriptionId: string) => Promise<unknown>;
  listSubscriptionInstallments: (subscriptionId: string) => Promise<unknown[]>;
  /**
   * Every subscription of the account, newest first, at most 1000 (ten pages):
   * Woovi's list takes no filter by customer (sandbox, 20/10/2026: `customer`,
   * `taxID` and `status` are ignored), so whoever needs one customer's filters
   * here. More than that is not an answer to trust, and throws.
   */
  listSubscriptions: () => Promise<unknown[]>;
  /**
   * `POST /api/v1/refund`: gives back a Pix received, named by its
   * `endToEndId`, in full. The `correlationID` is Polaris's and makes a repeat
   * the same refund at Woovi.
   */
  refundPix: (body: string) => Promise<unknown>;
  /** `PATCH /api/v1/customer/{correlationID}` with the name and the e-mail; the tax ID never changes. */
  updateCustomer: (
    correlationId: string,
    fields: { email: string; name: string }
  ) => Promise<unknown>;
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

  async function call(
    method: FetchInit["method"],
    path: string,
    body?: string
  ): Promise<unknown> {
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
    try {
      return parseProviderJson(text);
    } catch {
      // a 2xx that is not JSON is a gateway page or a cut answer: brief, worth a retry
      // biome-ignore lint/style/useErrorCause: The cause would carry the provider's text.
      throw new ProviderUnavailableError();
    }
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
    createSubscription: async (body) =>
      unwrap(
        await call("POST", "/api/v1/subscriptions", body),
        "subscription",
        true
      ),
    async findCustomerByTaxId(taxId) {
      if (!isTaxIdDigits(taxId)) {
        throw new TypeError("invalid_tax_id");
      }
      const same = (await listAll("/api/v1/customer", "customers")).filter(
        (entry) => {
          const { taxID } = record(entry);
          return (
            typeof taxID === "object" &&
            taxID !== null &&
            (taxID as Record<string, unknown>).taxID === taxId
          );
        }
      );
      if (same.length > 1) {
        throw new ProviderResponseMalformedError();
      }
      return same[0] ?? null;
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
    listSubscriptions: async () =>
      listAll("/api/v1/subscriptions", "subscriptions"),
    refundPix: async (body) =>
      unwrap(await call("POST", "/api/v1/refund", body), "refund", false),
    async updateCustomer(correlationId, fields) {
      if (!isWooviCustomerCorrelationId(correlationId)) {
        throw new ProviderResponseMalformedError();
      }
      return unwrap(
        await call(
          "PATCH",
          `/api/v1/customer/${encodeURIComponent(correlationId)}`,
          JSON.stringify({ email: fields.email, name: fields.name })
        ),
        "customer",
        true
      );
    },
  };
}
