import { ProviderNotConfiguredError } from "@polaris/billing/provider-port";
import {
  type BillingStore,
  createBillingStore,
} from "@polaris/db/billing-store";
import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import { type Context, Hono } from "hono";
import { billingProviderAdapters } from "../billing/adapters";
import {
  type BillingProviderAdapter,
  type ParsedBillingEvent,
  type UnresolvedBillingEvent,
  WebhookMalformedError,
  WebhookRejectedError,
  withinRetryWindow,
} from "../billing/provider-adapter";
import type { ServerEnv } from "../environment";
import {
  logServerErrorFromContext,
  logServerEvent,
} from "../observability/server-log";

/** A webhook body is small; anything larger is refused before it is read. */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
/** More events than this in one delivery is not a provider's notification. */
const MAX_EVENTS_PER_DELIVERY = 50;
const providerNamePattern = /^[a-z][a-z0-9_]{1,31}$/;

export interface BillingWebhookDependencies {
  adapters: Readonly<Record<string, BillingProviderAdapter>>;
  createStore: (connectionString: string) => BillingStore;
  /** Runs the processing after the response; defaults to the Worker's `waitUntil`. */
  runInBackground?: (promise: Promise<unknown>) => void;
}

type WebhookContext = Context<ServerEnv>;
interface StoredEvent {
  duplicate: boolean;
  id: string;
}

function backgroundRunner(context: WebhookContext) {
  return (promise: Promise<unknown>): void => {
    try {
      context.executionCtx.waitUntil(promise);
    } catch {
      // No ExecutionContext (unit tests): detach the task without an unhandled rejection.
      promise.catch(() => undefined);
    }
  };
}

function reply(
  context: WebhookContext,
  status: 200 | 401 | 404 | 413 | 503,
  body: Record<string, unknown>
): Response {
  return context.json({ ...body, requestId: context.get("requestId") }, status);
}

const tooLarge = (context: WebhookContext) =>
  reply(context, 413, { error: { code: "payload_too_large" } });
const unavailable = (context: WebhookContext) =>
  reply(context, 503, { error: { code: "billing_unavailable" } });

/**
 * The body as received (a signature covers those bytes), or the refusal for one
 * that is too large. The stream is counted as it is read and abandoned at the
 * limit, so a chunked body with no declared length costs no more than a declared one.
 */
async function readBody(context: WebhookContext): Promise<Response | string> {
  const declared = Number(context.req.header("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_WEBHOOK_BODY_BYTES) {
    return tooLarge(context);
  }
  const stream = context.req.raw.body;
  if (!stream) {
    return "";
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: A stream is read one chunk after the other.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return tooLarge(context);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // the byte order mark is kept: the adapter sees what the signature covered
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/**
 * A delivery that names a resource the provider did not find when it was read
 * back (AC-48) is not dropped silently: only its IDs are logged and, while the
 * event is recent, the answer is a 503 so the provider sends it again. An
 * older one is acknowledged with an error log of its IDs, so a resource that
 * never appears cannot pause the provider's webhook; the reconciliation
 * recovers it. Storing it as an `unresolved` row of the billing inbox,
 * reprocessed by the hourly pass and the reconciliation, needs a migration and
 * comes with the next database change of billing (ADR 0101).
 */
function answerUnresolved(
  context: WebhookContext,
  provider: string,
  unresolved: readonly UnresolvedBillingEvent[]
): Response {
  const retry = unresolved.some((entry) => withinRetryWindow(entry.occurredAt));
  for (const entry of unresolved) {
    const ids = {
      eventType: entry.eventType,
      provider,
      providerEventId: entry.providerEventId,
      resourceId: entry.resourceId,
    };
    if (retry) {
      logServerEvent("billing_webhook_unresolved", context, ids);
    } else {
      logger.error("billing_webhook_unresolved_given_up", {
        ...ids,
        requestId: context.get("requestId"),
      });
    }
  }
  return retry
    ? reply(context, 503, { error: { code: "billing_resource_unresolved" } })
    : reply(context, 200, { duplicates: 0, received: 0 });
}

/** The events of a delivery, or the answer to give when the request is not acceptable. */
async function parseDelivery(
  context: WebhookContext,
  adapter: BillingProviderAdapter,
  rawBody: string
): Promise<ParsedBillingEvent[] | Response> {
  try {
    const events = await adapter.parse({
      bindings: context.env,
      headers: context.req.raw.headers,
      rawBody,
    });
    if (events.length > MAX_EVENTS_PER_DELIVERY) {
      // authentic, but not something a retry can change: acknowledged and logged to be looked at
      logServerEvent("billing_webhook_too_many_events", context, {
        provider: adapter.provider,
      });
      return reply(context, 200, { duplicates: 0, received: 0 });
    }
    const unresolved = events.filter(
      (entry): entry is UnresolvedBillingEvent => "kind" in entry
    );
    if (unresolved.length > 0) {
      return answerUnresolved(context, adapter.provider, unresolved);
    }
    return events as ParsedBillingEvent[];
  } catch (error: unknown) {
    const { provider } = adapter;
    if (error instanceof ProviderNotConfiguredError) {
      // without its secrets the adapter cannot prove or read anything: never a 200
      logServerEvent("billing_provider_not_configured", context, { provider });
      return reply(context, 503, {
        error: { code: "billing_provider_not_configured" },
      });
    }
    if (error instanceof WebhookRejectedError) {
      // nothing about why: an attacker learns nothing from the answer
      logServerEvent("billing_webhook_rejected", context, { provider });
      return reply(context, 401, { error: { code: "unauthorized" } });
    }
    if (error instanceof WebhookMalformedError) {
      // authentic but unreadable: a retry sends the same bytes, and a provider that
      // keeps getting errors pauses its queue, so it is acknowledged and logged to be looked at
      logServerEvent("billing_webhook_malformed", context, { provider });
      return reply(context, 200, { duplicates: 0, received: 0 });
    }
    logServerErrorFromContext(context, error, 503);
    return unavailable(context);
  }
}

/** Stores the events in order, each once; a redelivery comes back as a duplicate. */
async function storeEvents(
  store: BillingStore,
  adapter: BillingProviderAdapter,
  events: readonly ParsedBillingEvent[]
): Promise<StoredEvent[]> {
  // one after the other: the events of a delivery are stored in the order they came
  return await events.reduce<Promise<StoredEvent[]>>(
    async (previous, event) => {
      const stored = await previous;
      stored.push(
        await store.recordEvent({
          fact: event.fact,
          provider: adapter.provider,
          providerEventId: event.providerEventId,
          providerRef: event.providerRef,
        })
      );
      return stored;
    },
    Promise.resolve([])
  );
}

/**
 * Applies the events of a delivery, in order, and closes the store; a failure is
 * left to the retry pass. A redelivered event is processed too: applying one that
 * is already applied is a no-op, and one that was stored but never applied (the
 * isolate died, or a later event of its delivery could not be stored) is applied now
 * instead of waiting for the hourly pass.
 */
async function processStored(
  store: BillingStore,
  provider: string,
  toProcess: readonly StoredEvent[]
): Promise<void> {
  try {
    for (const entry of toProcess) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Events of one delivery are applied in order.
        const result = await store.processEvent(entry.id);
        if (result.status === "failed") {
          // stored and marked failed (for example the organization is not attached yet): the retry pass takes it
          logger.warn("billing_webhook_processing_deferred", {
            eventId: entry.id,
            outcomeCode: result.outcomeCode,
            provider,
          });
        }
      } catch (error: unknown) {
        // stored and marked failed: the retry pass takes it from here
        logger.error("billing_webhook_processing_failed", {
          ...describeError(error),
          eventId: entry.id,
          provider,
        });
      }
    }
  } finally {
    await store.close().catch(() => undefined);
  }
}

/**
 * Where payment providers deliver their webhooks (plan PR79). It is mounted
 * outside `/api` and `/rpc`: those paths guard against cross-site browser
 * requests, and a provider is not a browser; it proves itself by the signature
 * or token its adapter checks. The route does the least that is durable and then
 * answers: it stores each event once (a redelivery is a no-op) and replies, and
 * the processing runs after the response. If the event cannot be stored the
 * answer is a 503, so the provider sends it again; if it is stored but the
 * processing fails, the hourly retry pass picks it up. Only a failed proof of
 * authenticity (401), an oversized body (413) and an unknown provider (404) are
 * refusals: an authentic delivery the lifecycle cannot use is acknowledged and
 * logged, because a retry would change nothing and providers pause a webhook
 * that keeps being refused.
 */
export function createBillingWebhookRoutes(
  overrides: Partial<BillingWebhookDependencies> = {}
): Hono<ServerEnv> {
  const adapters = overrides.adapters ?? billingProviderAdapters;
  const createStore = overrides.createStore ?? createBillingStore;
  const app = new Hono<ServerEnv>();

  app.post("/webhooks/billing/:provider", async (context) => {
    const provider = context.req.param("provider");
    // an own property only: `constructor` or `valueof` must never resolve to something inherited
    const adapter =
      providerNamePattern.test(provider) && Object.hasOwn(adapters, provider)
        ? adapters[provider]
        : undefined;
    if (!adapter) {
      return reply(context, 404, { error: { code: "not_found" } });
    }
    const connectionString = context.env.BILLING_HYPERDRIVE?.connectionString;
    if (!connectionString) {
      // not provisioned here: the provider is told to try again later
      logServerEvent("billing_webhook_unavailable", context, { provider });
      return unavailable(context);
    }

    const body = await readBody(context);
    if (typeof body !== "string") {
      return body;
    }
    const events = await parseDelivery(context, adapter, body);
    if (!Array.isArray(events)) {
      return events as Response;
    }
    if (events.length === 0) {
      return reply(context, 200, { duplicates: 0, received: 0 });
    }

    const store = createStore(connectionString);
    let stored: StoredEvent[];
    try {
      stored = await storeEvents(store, adapter, events);
    } catch (error: unknown) {
      await store.close().catch(() => undefined);
      logServerErrorFromContext(context, error, 503);
      // not stored: the provider must send it again
      return unavailable(context);
    }

    (overrides.runInBackground ?? backgroundRunner(context))(
      processStored(store, adapter.provider, stored)
    );
    return reply(context, 200, {
      duplicates: stored.filter((entry) => entry.duplicate).length,
      received: stored.length,
    });
  });

  return app;
}
