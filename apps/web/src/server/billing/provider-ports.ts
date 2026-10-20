import {
  checkoutReturnUrls,
  createAsaasPort,
} from "@polaris/billing/asaas/port";
import type { FetchLike } from "@polaris/billing/http";
import {
  type BillingProviderPort,
  ProviderNotConfiguredError,
} from "@polaris/billing/provider-port";
import type { WorkerBindings } from "../environment";

/** A command to the provider gives up after this long (ADR 0101): the caller sees `provider_unavailable`. */
const BILLING_COMMAND_TIMEOUT_MS = 8000;

export interface BillingPortOptions {
  fetch?: FetchLike;
  randomUuid?: () => string;
}

/** The providers Polaris acts through (cancels, refunds, reconciles): the ones with an outbound port. */
export const HANDLED_BILLING_PROVIDERS: readonly string[] = Object.freeze([
  "asaas",
]);
const HANDLED_PROVIDERS: ReadonlySet<string> = new Set(
  HANDLED_BILLING_PROVIDERS
);

/**
 * Whether Polaris acts through this provider at all, whatever the settings of
 * this environment: without its port, the renewal is the person's to cancel.
 */
export function billingProviderHandled(provider: string): boolean {
  return HANDLED_PROVIDERS.has(provider);
}

/**
 * The outbound port of a provider, built from the Worker's settings, or
 * `ProviderNotConfiguredError` when a secret or a setting is missing. The
 * client refuses a key of another environment (a sandbox key against
 * production, or the other way round). The return URLs of the checkout are
 * built on `BETTER_AUTH_BASE_URL`, never on anything the client sends.
 */
export function billingProviderPortOf(
  bindings: Pick<
    WorkerBindings,
    "ASAAS_API_KEY" | "ASAAS_BASE_URL" | "BETTER_AUTH_BASE_URL"
  >,
  provider: string,
  options: BillingPortOptions = {}
): BillingProviderPort {
  if (!billingProviderHandled(provider)) {
    // Woovi (Pix Automático) comes with its own port (plan PR78)
    throw new ProviderNotConfiguredError();
  }
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
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      randomUuid: options.randomUuid ?? (() => crypto.randomUUID()),
      timeoutMs: BILLING_COMMAND_TIMEOUT_MS,
    });
  } catch {
    // the key and the host of different environments, a host that is not Asaas's, or a bad app origin
    // biome-ignore lint/style/useErrorCause: Only the code travels; the settings stay out of every log.
    throw new ProviderNotConfiguredError();
  }
}
