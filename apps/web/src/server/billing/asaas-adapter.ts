import {
  type AsaasClient,
  createAsaasClient,
} from "@polaris/billing/asaas/client";
import {
  type AsaasWebhookEnvelope,
  asaasTokenMatches,
  readAsaasWebhook,
  resolveAsaasWebhook,
} from "@polaris/billing/asaas/webhook";
import type { FetchLike } from "@polaris/billing/http";
import {
  ProviderNotConfiguredError,
  ProviderRejectedError,
  ProviderResponseMalformedError,
} from "@polaris/billing/provider-port";
import { logger } from "@polaris/observability/logger";
import type { WorkerBindings } from "../environment";
import {
  type BillingProviderAdapter,
  WebhookMalformedError,
  WebhookRejectedError,
  withinRetryWindow,
} from "./provider-adapter";

/** The read back of a webhook's resource gives up after this long; Asaas sends the event again. */
const ASAAS_WEBHOOK_READ_TIMEOUT_MS = 5000;

/** The shortest webhook token Asaas is set up with (the runbook asks for 32 to 255 characters). */
const MIN_WEBHOOK_TOKEN_LENGTH = 32;

/** The webhook tokens, or `ProviderNotConfiguredError`: without one the adapter never answers 200. */
function webhookTokensOf(bindings: WorkerBindings): [string, string] {
  const token = bindings.ASAAS_WEBHOOK_TOKEN ?? "";
  if (token.length < MIN_WEBHOOK_TOKEN_LENGTH) {
    throw new ProviderNotConfiguredError();
  }
  return [token, bindings.ASAAS_WEBHOOK_TOKEN_NEXT ?? ""];
}

/** The API settings, checked only once the delivery is proven to come from Asaas. */
function apiSettingsOf(bindings: WorkerBindings): {
  apiKey: string;
  baseUrl: string;
} {
  const apiKey = bindings.ASAAS_API_KEY ?? "";
  const baseUrl = bindings.ASAAS_BASE_URL ?? "";
  if (!(apiKey && baseUrl)) {
    throw new ProviderNotConfiguredError();
  }
  return { apiKey, baseUrl };
}

/** Reads the resource back; only codes and IDs ever reach the log. */
async function readBack(client: AsaasClient, envelope: AsaasWebhookEnvelope) {
  const ids = { provider: "asaas", providerEventId: envelope.eventId };
  try {
    const resolved = await resolveAsaasWebhook(client, envelope);
    return Array.isArray(resolved) ? resolved : [resolved];
  } catch (error: unknown) {
    if (error instanceof ProviderResponseMalformedError) {
      logger.error("billing_provider_response_malformed", ids);
      if (withinRetryWindow(envelope.occurredAt)) {
        // a gateway page or a half answer is usually brief: Asaas sends it again
        throw error;
      }
      // biome-ignore lint/style/useErrorCause: Only the code travels; the resource stays out of every log.
      throw new WebhookMalformedError();
    }
    if (
      error instanceof ProviderRejectedError &&
      (error.status === 401 || error.status === 403)
    ) {
      // the key was refused (rotated, revoked or of another account): every
      // delivery fails until it is fixed, and Asaas pauses the webhook after 15
      logger.error("billing_provider_rejected", {
        ...ids,
        httpStatus: error.status,
      });
    }
    throw error;
  }
}

/**
 * The inbound adapter of Asaas (cartão recorrente, ADR 0101). It checks the
 * `asaas-access-token` header in constant time against `ASAAS_WEBHOOK_TOKEN`
 * (and `ASAAS_WEBHOOK_TOKEN_NEXT` during a rotation), reads only IDs from the
 * body, reads the resource back from the Asaas API and maps what the resource
 * shows. Nothing of the body or of the resource is logged, only IDs and codes.
 */
export function createAsaasAdapter(
  options: { fetch?: FetchLike } = {}
): BillingProviderAdapter {
  return {
    async parse({ bindings, headers, rawBody }) {
      const token = headers.get("asaas-access-token");
      if (!(await asaasTokenMatches(token, webhookTokensOf(bindings)))) {
        throw new WebhookRejectedError();
      }
      const settings = apiSettingsOf(bindings);
      const envelope = readAsaasWebhook(rawBody);
      if (!envelope) {
        throw new WebhookMalformedError();
      }
      const client = createAsaasClient({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        fetch: options.fetch ?? ((url, init) => fetch(url, init)),
        timeoutMs: ASAAS_WEBHOOK_READ_TIMEOUT_MS,
      });
      return await readBack(client, envelope);
    },
    provider: "asaas",
  };
}
