import {
  type ActivationEmailEventKind,
  type ActivationEmailEventRecorder,
  createActivationEmailEventRecorder,
} from "@polaris/db/activation-email-events";
import { normalizeActivationAddress } from "@polaris/domain/activation/notices";
import { logger, opaqueId } from "@polaris/observability/logger";
import { type Context, Hono } from "hono";
import { svixKeyOf, verifySvixSignature } from "../activation/resend-signature";
import {
  activationSuppressionHmac,
  activationSuppressionKeyId,
  activationSuppressionSecretsOf,
} from "../activation/suppression";
import type { ServerEnv } from "../environment";
import {
  logServerErrorFromContext,
  logServerEvent,
} from "../observability/server-log";

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
/** The database function takes at most this many HMACs in one event. */
const MAX_ADDRESSES_PER_EVENT = 50;

export interface ResendWebhookDependencies {
  createRecorder: (connectionString: string) => ActivationEmailEventRecorder;
  now: () => Date;
}

type WebhookContext = Context<ServerEnv>;

function reply(
  context: WebhookContext,
  status: 200 | 401 | 413 | 503,
  body: Record<string, unknown>
): Response {
  return context.json({ ...body, requestId: context.get("requestId") }, status);
}

/**
 * The body as received (the signature covers those bytes), or the 413 for one over the limit. The stream is counted as
 * it is read and abandoned at the limit. Copied from the billing webhooks, not imported: the two endpoints stay apart.
 */
async function readBody(context: WebhookContext): Promise<Response | string> {
  const tooLarge = () =>
    reply(context, 413, { error: { code: "payload_too_large" } });
  const declared = Number(context.req.header("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_WEBHOOK_BODY_BYTES) {
    return tooLarge();
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
      return tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The recipients of the event: a text or a list of texts. Anything else (a list of objects, no field) is null. */
function recipientsOf(payload: Record<string, unknown>): string[] | null {
  const to = recordOf(payload.data)?.to;
  if (typeof to === "string") {
    return [to];
  }
  if (
    Array.isArray(to) &&
    to.length > 0 &&
    to.every((entry) => typeof entry === "string")
  ) {
    return to as string[];
  }
  return null;
}

/** Only an explicit `Transient` is left alone: a missing or unknown type is suppressed (the cost is one e-mail). */
function isTransientBounce(payload: Record<string, unknown>): boolean {
  const type = recordOf(recordOf(payload.data)?.bounce)?.type;
  return typeof type === "string" && type.toLowerCase() === "transient";
}

function parseJson(body: string): { error: string } | { value: unknown } {
  try {
    return { value: JSON.parse(body) as unknown };
  } catch (error: unknown) {
    // the name only: the message of a JSON error quotes a piece of the body
    return { error: error instanceof Error ? error.name : "UnknownError" };
  }
}

async function hmacsOf(
  addresses: readonly string[],
  secret: string
): Promise<{ hmacs: Uint8Array[]; unusable: number }> {
  const readable = addresses
    .map((address) => normalizeActivationAddress(address))
    .filter((address): address is string => address !== null);
  const normalized = [...new Set(readable)];
  const hmacs = await Promise.all(
    normalized
      .slice(0, MAX_ADDRESSES_PER_EVENT)
      .map((address) => activationSuppressionHmac(secret, address))
  );
  return { hmacs, unusable: addresses.length - readable.length };
}

interface RecordPlan {
  hmacs: Uint8Array[];
  kind: ActivationEmailEventKind;
  unusable: number;
}

type Verdict = "complained" | "bounced" | "ignored";

function verdictOf(payload: Record<string, unknown>): Verdict {
  if (payload.type === "email.complained") {
    return "complained";
  }
  if (payload.type === "email.bounced" && !isTransientBounce(payload)) {
    return "bounced";
  }
  return "ignored";
}

/**
 * What to write for a verified delivery, or null when nothing is to be written. A complaint is always written: when
 * its addressee cannot be read, or there are too many, the stop of the series still happens, with fewer HMACs or none.
 * A bounce needs at least one address to be of any use, so one that cannot be read is only logged.
 */
async function planOf(
  context: WebhookContext,
  payload: Record<string, unknown>,
  secret: string
): Promise<RecordPlan | null> {
  const verdict = verdictOf(payload);
  if (verdict === "ignored") {
    return null;
  }
  const kind = verdict === "complained" ? "complaint" : "bounce";
  const eventId = opaqueId(context.req.header("svix-id"));
  const recipients = recipientsOf(payload);
  if (recipients === null) {
    logServerEvent(`resend_${kind}_unparseable`, context, { eventId });
  } else if (recipients.length > MAX_ADDRESSES_PER_EVENT) {
    logServerEvent("resend_webhook_too_many_addresses", context, {
      eventId,
      kind,
    });
  }
  if (
    kind === "bounce" &&
    (recipients === null || recipients.length > MAX_ADDRESSES_PER_EVENT)
  ) {
    return null;
  }
  const { hmacs, unusable } = await hmacsOf(recipients ?? [], secret);
  if (hmacs.length === 0 && recipients !== null) {
    logServerEvent(`resend_${kind}_unparseable`, context, {
      eventId,
      unusable,
    });
    if (kind === "bounce") {
      return null;
    }
  }
  return { hmacs, kind, unusable };
}

interface Configuration {
  connectionString: string;
  key: Uint8Array<ArrayBuffer>;
  suppressionSecret: string;
}

function configurationOf(context: WebhookContext): Configuration | Response {
  const notConfigured = (reason: string) => {
    logServerEvent("resend_webhook_not_configured", context, { reason });
    return reply(context, 503, {
      error: { code: "resend_webhook_not_configured" },
    });
  };
  const key = svixKeyOf(context.env.RESEND_WEBHOOK_SECRET);
  if (!key) {
    return notConfigured("webhook_secret");
  }
  const connectionString = context.env.BILLING_HYPERDRIVE?.connectionString;
  if (!connectionString) {
    return notConfigured("database");
  }
  const suppression = activationSuppressionSecretsOf(context.env);
  if (!suppression) {
    return notConfigured("suppression_secret");
  }
  return { connectionString, key, suppressionSecret: suppression.current };
}

async function recordPlan(
  context: WebhookContext,
  recorder: ActivationEmailEventRecorder,
  plan: RecordPlan,
  suppressionSecret: string
): Promise<Response> {
  const eventId = context.req.header("svix-id") as string;
  const logId = opaqueId(eventId);
  try {
    const outcome = await recorder.record({
      eventId,
      hmacs: plan.hmacs,
      keyId: await activationSuppressionKeyId(suppressionSecret),
      kind: plan.kind,
    });
    if (outcome.duplicate) {
      logServerEvent("resend_webhook_recorded", context, {
        duplicate: true,
        eventId: logId,
        kind: plan.kind,
      });
      return reply(context, 200, { duplicate: true, received: 1 });
    }
    logServerEvent("resend_webhook_recorded", context, {
      duplicate: false,
      eventId: logId,
      kind: plan.kind,
      stopped: outcome.stopped,
      suppressed: outcome.suppressed,
      unusable: plan.unusable,
    });
    if (outcome.stopped) {
      logger.warn("activation_series_stopped", {
        eventId: logId,
        requestId: context.get("requestId"),
        stopped: true,
      });
    }
    return reply(context, 200, { duplicate: false, received: 1 });
  } catch (error: unknown) {
    logServerErrorFromContext(context, error, 503);
    // not recorded: the provider sends it again, and the inbox keeps the effect to one
    return reply(context, 503, {
      error: { code: "resend_webhook_unavailable" },
    });
  }
}

export function createResendWebhookRoutes(
  overrides: Partial<ResendWebhookDependencies> = {}
): Hono<ServerEnv> {
  const createRecorder =
    overrides.createRecorder ?? createActivationEmailEventRecorder;
  const now = overrides.now ?? (() => new Date());
  const app = new Hono<ServerEnv>();

  app.post("/webhooks/email/resend", async (context) => {
    const configuration = configurationOf(context);
    if (configuration instanceof Response) {
      return configuration;
    }
    const body = await readBody(context);
    if (typeof body !== "string") {
      return body;
    }
    const verified = await verifySvixSignature({
      body,
      headers: {
        id: context.req.header("svix-id"),
        signature: context.req.header("svix-signature"),
        timestamp: context.req.header("svix-timestamp"),
      },
      key: configuration.key,
      nowMs: now().getTime(),
    });
    if (!verified) {
      logServerEvent("resend_webhook_rejected", context);
      return reply(context, 401, { error: { code: "unauthorized" } });
    }

    const parsed = parseJson(body);
    const payload = "value" in parsed ? recordOf(parsed.value) : null;
    if (!payload) {
      logServerEvent("resend_webhook_unreadable", context, {
        error: "error" in parsed ? parsed.error : "NotAnObject",
      });
      return reply(context, 200, { received: 1 });
    }
    const plan = await planOf(
      context,
      payload,
      configuration.suppressionSecret
    );
    if (!plan) {
      return reply(context, 200, { ignored: true, received: 1 });
    }
    const recorder = createRecorder(configuration.connectionString);
    try {
      return await recordPlan(
        context,
        recorder,
        plan,
        configuration.suppressionSecret
      );
    } finally {
      await recorder.close().catch(() => undefined);
    }
  });

  return app;
}
