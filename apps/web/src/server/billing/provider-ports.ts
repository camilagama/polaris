import {
  checkoutReturnUrls,
  createAsaasPort,
} from "@polaris/billing/asaas/port";
import type { FetchLike } from "@polaris/billing/http";
import {
  type BillingProviderPort,
  ProviderNotConfiguredError,
} from "@polaris/billing/provider-port";
import { createWooviPort } from "@polaris/billing/woovi/port";
import { billingProviderHandled } from "@polaris/domain/billing/renewal-cancellation";
import type { WorkerBindings } from "../environment";

/** A command to the provider gives up after this long (ADR 0101): the caller sees `provider_unavailable`. */
const BILLING_COMMAND_TIMEOUT_MS = 8000;

export interface BillingPortOptions {
  fetch?: FetchLike;
  randomUuid?: () => string;
  /**
   * Aborts every request of the port to the provider (ADR 0104: one call of an owner's command waits at most 15 s),
   * on top of the client's own timeout per request. The owner's commands always pass one (their `portFor` requires
   * it); the operator's commands rely on the client's timeout alone.
   */
  signal?: AbortSignal;
}

/** The fetch of the port: the injected one or the Worker's, with the caller's signal added to each request's own. */
function fetchOf(options: BillingPortOptions): FetchLike {
  const base: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const { signal } = options;
  return signal
    ? (url, init) =>
        base(url, { ...init, signal: AbortSignal.any([init.signal, signal]) })
    : base;
}

export type BillingPortBindings = Pick<
  WorkerBindings,
  | "ASAAS_API_KEY"
  | "ASAAS_BASE_URL"
  | "BETTER_AUTH_BASE_URL"
  | "WOOVI_APP_ID"
  | "WOOVI_BASE_URL"
  | "WOOVI_REFUND_ENABLED"
>;

function asaasPortOf(
  bindings: BillingPortBindings,
  options: BillingPortOptions
): BillingProviderPort {
  const apiKey = bindings.ASAAS_API_KEY ?? "";
  const baseUrl = bindings.ASAAS_BASE_URL ?? "";
  const appBaseUrl = bindings.BETTER_AUTH_BASE_URL ?? "";
  if (!(apiKey && baseUrl && appBaseUrl)) {
    throw new ProviderNotConfiguredError();
  }
  try {
    // an origin that is not https (or local http) would send the payer anywhere
    checkoutReturnUrls(appBaseUrl);
    return createAsaasPort({
      apiKey,
      appBaseUrl,
      baseUrl,
      fetch: fetchOf(options),
      randomUuid: options.randomUuid ?? (() => crypto.randomUUID()),
      timeoutMs: BILLING_COMMAND_TIMEOUT_MS,
    });
  } catch {
    // the key and the host of different environments, a host that is not Asaas's, or a bad app origin
    // biome-ignore lint/style/useErrorCause: Only the code travels; the settings stay out of every log.
    throw new ProviderNotConfiguredError();
  }
}

function wooviPortOf(
  bindings: BillingPortBindings,
  options: BillingPortOptions
): BillingProviderPort {
  const appId = bindings.WOOVI_APP_ID ?? "";
  const baseUrl = bindings.WOOVI_BASE_URL ?? "";
  if (!(appId && baseUrl)) {
    throw new ProviderNotConfiguredError();
  }
  try {
    return createWooviPort({
      appId,
      baseUrl,
      fetch: fetchOf(options),
      randomUuid: options.randomUuid ?? (() => crypto.randomUUID()),
      // off until the refund of an installment is proven in the sandbox (S3.2, Gate 7)
      refundEnabled: bindings.WOOVI_REFUND_ENABLED === "true",
      timeoutMs: BILLING_COMMAND_TIMEOUT_MS,
    });
  } catch {
    // a host that is not one of Woovi's two (the AppID has no mark of its environment)
    // biome-ignore lint/style/useErrorCause: Only the code travels; the settings stay out of every log.
    throw new ProviderNotConfiguredError();
  }
}

/**
 * The outbound port of a provider, built from the Worker's settings, or
 * `ProviderNotConfiguredError` when a secret or a setting is missing. The
 * Asaas client refuses a key of another environment (a sandbox key against
 * production, or the other way round); the Woovi client only talks to one of
 * Woovi's two hosts. The return URLs of the card checkout are built on
 * `BETTER_AUTH_BASE_URL`, never on anything the client sends.
 */
export function billingProviderPortOf(
  bindings: BillingPortBindings,
  provider: string,
  options: BillingPortOptions = {}
): BillingProviderPort {
  if (!billingProviderHandled(provider)) {
    throw new ProviderNotConfiguredError();
  }
  return provider === "woovi"
    ? wooviPortOf(bindings, options)
    : asaasPortOf(bindings, options);
}
