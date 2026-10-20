import type { FetchLike } from "@polaris/billing/http";
import {
  ProviderNotConfiguredError,
  ProviderRejectedError,
  ProviderResponseMalformedError,
} from "@polaris/billing/provider-port";
import {
  createWooviClient,
  type WooviClient,
} from "@polaris/billing/woovi/client";
import {
  wooviPublicKeys,
  wooviSignatureMatches,
} from "@polaris/billing/woovi/signature";
import {
  inspectWooviWebhook,
  resolveWooviWebhook,
  type WooviWebhookEnvelope,
} from "@polaris/billing/woovi/webhook";
import { logger } from "@polaris/observability/logger";
import type { WorkerBindings } from "../environment";
import {
  type BillingProviderAdapter,
  WebhookMalformedError,
  WebhookRejectedError,
} from "./provider-adapter";

/** The read back of a webhook's resource gives up after this long; Woovi sends the event again. */
const WOOVI_WEBHOOK_READ_TIMEOUT_MS = 5000;

/** The API settings, checked only once the delivery is proven to come from Woovi. */
function apiSettingsOf(bindings: WorkerBindings): {
  appId: string;
  baseUrl: string;
} {
  const appId = bindings.WOOVI_APP_ID ?? "";
  const baseUrl = bindings.WOOVI_BASE_URL ?? "";
  if (!(appId && baseUrl)) {
    throw new ProviderNotConfiguredError();
  }
  return { appId, baseUrl };
}

/** The envelope of an authentic body, or `WebhookMalformedError` (with the event's name logged when it would give a fact). */
function envelopeOf(rawBody: string): WooviWebhookEnvelope {
  const { envelope, refusedFactEvent: eventType } =
    inspectWooviWebhook(rawBody);
  if (envelope) {
    return envelope;
  }
  if (eventType !== null) {
    // an event that would give a fact, without a resource ID in the documented
    // place: a charge may be lost until the reconciliation reads it
    logger.error("billing_webhook_fact_event_malformed", {
      eventType,
      provider: "woovi",
    });
  }
  throw new WebhookMalformedError();
}

/** Reads the resource back; only codes and IDs ever reach the log. */
async function readBack(client: WooviClient, envelope: WooviWebhookEnvelope) {
  const ids = {
    eventType: envelope.eventType,
    provider: "woovi",
    // decoded: the base64 `globalID` would be masked by the log's redaction
    ...(envelope.logId === null ? {} : { resourceId: envelope.logId }),
  };
  try {
    const resolved = await resolveWooviWebhook(
      client,
      envelope,
      new Date(),
      (shown) => {
        // an event that names a payment or a cancellation, answered 200 because
        // the read back does not show it (yet): never a 503, a forged body would
        // become a loop of redeliveries; the reconciliation reads the state
        logger.error("billing_webhook_state_not_shown", { ...ids, ...shown });
      }
    );
    return Array.isArray(resolved) ? resolved : [resolved];
  } catch (error: unknown) {
    if (error instanceof ProviderResponseMalformedError) {
      // Woovi's body has no time of the event to bound a retry window by:
      // acknowledged and logged, and the reconciliation reads the state
      logger.error("billing_provider_response_malformed", ids);
      // biome-ignore lint/style/useErrorCause: Only the code travels; the resource stays out of every log.
      throw new WebhookMalformedError();
    }
    if (
      error instanceof ProviderRejectedError &&
      (error.status === 401 || error.status === 403)
    ) {
      // the AppID was refused (rotated, revoked or of another account)
      logger.error("billing_provider_rejected", {
        ...ids,
        httpStatus: error.status,
      });
    }
    throw error;
  }
}

/**
 * The inbound adapter of Woovi (Pix Automático, ADR 0101, emenda Woovi). It
 * checks `x-webhook-signature` (RSA-SHA256 over the raw bytes, with the keys
 * pinned in `WOOVI_WEBHOOK_PUBLIC_KEYS`) before anything parses the body, reads
 * only the event's name and the resource's `globalID`, reads the resource back
 * from the Woovi API and maps what the resource shows. Nothing of the body or
 * of the resource is logged, only IDs and codes.
 */
export function createWooviAdapter(
  options: { fetch?: FetchLike } = {}
): BillingProviderAdapter {
  return {
    async parse({ bindings, headers, rawBody }) {
      const keys = await wooviPublicKeys(bindings.WOOVI_WEBHOOK_PUBLIC_KEYS);
      const signature = headers.get("x-webhook-signature");
      if (!(await wooviSignatureMatches(rawBody, signature, keys))) {
        throw new WebhookRejectedError();
      }
      const settings = apiSettingsOf(bindings);
      const envelope = envelopeOf(rawBody);
      const client = createWooviClient({
        appId: settings.appId,
        baseUrl: settings.baseUrl,
        fetch: options.fetch ?? ((url, init) => fetch(url, init)),
        timeoutMs: WOOVI_WEBHOOK_READ_TIMEOUT_MS,
      });
      return await readBack(client, envelope);
    },
    provider: "woovi",
  };
}
