import type { ActivationNoticeRecipientClient } from "@polaris/db/activation-notice-recipient";
import type {
  ActivationNoticeStep,
  ActivationNoticeStore,
} from "@polaris/db/activation-notice-store";
import {
  type ActivationNoticeSkipReason,
  normalizeActivationAddress,
  STOP_ENFORCED,
  withinActivationSendHours,
} from "@polaris/domain/activation/notices";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { logger, opaqueId } from "@polaris/observability/logger";
import { activationEmailsEnabled } from "../billing/activation-sweep";
import type { WorkerBindings } from "../environment";
import {
  type ClosureNoticeSender,
  createResendClosureNoticeSender,
} from "../privacy/closure-notice-email";
import { PermanentHandlerError } from "../queue/consumer";
import {
  createUnsubscribeToken,
  type UnsubscribeSecrets,
  unsubscribeSecretsOf,
} from "../tips-stop/unsubscribe-token";
import {
  activationNoticeVariant,
  renderActivationNoticeEmail,
} from "./emails/activation-notice-email";

/**
 * The consumer of `activation.notice` (ADR 0106): one tip of the series "Dicas para começar". The switch comes first
 * and reads nothing; then the notice still owed and the database's re-read of every rule (the billing role), the
 * configuration, the provider's 23 hours and the hours of São Paulo; then the address (the authentication role's
 * `activation_notice_recipient`, never another source), checked against the suppressed ones by its HMAC; and only then
 * the render and the send, under `activation-notice/<id>` as the provider's key. The first reason that holds is
 * recorded as the skip. The address and the store's name never reach a log, an error or an event: the log carries the
 * step, the outcome, the reason and the opaque IDs.
 *
 * The envelope check, the 23 hours and the reading of the provider's answer are copied from the billing consumer
 * (`billing/notice-consumer.ts`), not imported: the two series stay apart.
 */

const NOTICE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The provider refused this message for good (the address): failed, with no retry. */
const EMAIL_REJECTED = "email_rejected";

/**
 * Resend's 409 for a key already used by another body in its 24 hours: a message under this notice's key was taken.
 * The other 409 (`concurrent_idempotent_requests`, the same key still in flight) is tried again.
 */
const RESEND_KEY_TAKEN = "invalid_idempotent_request";

/**
 * A notice first tried longer ago than this is not sent again: Resend keeps an idempotency key for 24 hours, and past
 * them a send whose marking failed would go out twice. Counted from the first attempt.
 */
const ACTIVATION_NOTICE_DELIVERY_WINDOW_MS = 23 * 3_600_000;

/** The provider's key of a tip: apart from the billing notices', whose key is the bare ID. */
export function activationNoticeIdempotencyKey(noticeId: string): string {
  return `activation-notice/${noticeId}`;
}

const SUPPRESSION_HMAC_PREFIX = "activation-suppression:v1:";
const MIN_SECRET_LENGTH = 32;

export interface ActivationSuppressionSecrets {
  current: string;
  previous?: string | undefined;
}

/** The other secrets of the Worker the suppression's must never equal: one list, every secret binding of the Worker. */
const OTHER_SECRETS = [
  "ASAAS_API_KEY",
  "ASAAS_WEBHOOK_TOKEN",
  "ASAAS_WEBHOOK_TOKEN_NEXT",
  "AUTH_PASSWORD_PEPPER",
  "BETTER_AUTH_SECRET",
  "BILLING_PAYER_KEY",
  "GOOGLE_CLIENT_SECRET",
  "OFFLINE_LEASE_PREVIOUS_SECRET",
  "OFFLINE_LEASE_SECRET",
  "RESEND_API_KEY",
  "SYNC_PAYLOAD_HASH_PREVIOUS_SECRET",
  "SYNC_PAYLOAD_HASH_SECRET",
  "TURNSTILE_SECRET_KEY",
  "UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET",
  "UNSUBSCRIBE_TOKEN_SECRET",
  "WOOVI_APP_ID",
] as const;

type SecretBindings = Pick<
  WorkerBindings,
  | "ACTIVATION_SUPPRESSION_HMAC_SECRET"
  | "ACTIVATION_SUPPRESSION_HMAC_SECRET_PREVIOUS"
  | (typeof OTHER_SECRETS)[number]
>;

/**
 * The secrets of the suppression's HMAC, or undefined when the current one is missing, shorter than 32 characters or
 * equal to another secret of the Worker, or when a previous one is set and is not usable: a suppression under a key
 * the Worker cannot use would go unseen, so the tips fail closed instead.
 */
export function activationSuppressionSecretsOf(
  bindings: SecretBindings
): ActivationSuppressionSecrets | undefined {
  const others = new Set(
    OTHER_SECRETS.map((name) => bindings[name]).filter(
      (value): value is string => typeof value === "string" && value !== ""
    )
  );
  const usable = (secret: string | undefined) =>
    secret !== undefined &&
    secret.length >= MIN_SECRET_LENGTH &&
    !others.has(secret);
  const current = bindings.ACTIVATION_SUPPRESSION_HMAC_SECRET;
  const previous = bindings.ACTIVATION_SUPPRESSION_HMAC_SECRET_PREVIOUS;
  if (!(current && usable(current))) {
    return undefined;
  }
  if (previous === undefined || previous === "") {
    return { current };
  }
  if (!usable(previous)) {
    return undefined;
  }
  return previous === current ? { current } : { current, previous };
}

const encoder = new TextEncoder();

/** The HMAC-SHA-256 of one normalized address under one secret, with the purpose in the signed text. */
export async function activationSuppressionHmac(
  secret: string,
  normalizedAddress: string
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${SUPPRESSION_HMAC_PREFIX}${normalizedAddress}`)
    )
  );
}

/** The provider's configuration (secrets): never logged. */
export interface ActivationNoticeEmailConfig {
  apiKey: string;
  appBaseUrl: string;
  from: string;
  /** The reply-to and the footer's box (`BILLING_SUPPORT_EMAIL`): without it no tip goes out. */
  supportEmail: string;
  suppression: ActivationSuppressionSecrets;
  unsubscribe: UnsubscribeSecrets;
}

const SUPPORT_EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function originOf(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) {
      return url.origin;
    }
  } catch {
    // not a URL: the tips stay off
  }
  return null;
}

type EmailBindings = SecretBindings &
  Pick<
    WorkerBindings,
    | "ACTIVATION_EMAIL_FROM"
    | "BETTER_AUTH_BASE_URL"
    | "BILLING_SUPPORT_EMAIL"
    | "RESEND_API_KEY"
  >;

/**
 * The configuration of the tips, or null when anything is missing: the provider's key, the sender of the series, the
 * support box (one address, the reply-to), the app's origin, the secret of the stop link and the suppression's. Also
 * null while the stop on a complaint is not in force in the code (`STOP_ENFORCED`): with it off, no tip goes out even
 * with everything set.
 */
export function activationNoticeEmailConfig(
  bindings: EmailBindings,
  stopEnforced: boolean = STOP_ENFORCED
): ActivationNoticeEmailConfig | null {
  if (!stopEnforced) {
    return null;
  }
  const apiKey = bindings.RESEND_API_KEY?.trim();
  const from = bindings.ACTIVATION_EMAIL_FROM?.trim();
  const supportEmail = bindings.BILLING_SUPPORT_EMAIL?.trim();
  const appBaseUrl = originOf(bindings.BETTER_AUTH_BASE_URL);
  const unsubscribe = unsubscribeSecretsOf(bindings);
  const suppression = activationSuppressionSecretsOf(bindings);
  if (
    !(
      apiKey &&
      from &&
      supportEmail &&
      SUPPORT_EMAIL.test(supportEmail) &&
      appBaseUrl &&
      unsubscribe &&
      suppression
    )
  ) {
    return null;
  }
  return { apiKey, appBaseUrl, from, supportEmail, suppression, unsubscribe };
}

export type ActivationNoticeReader = Pick<
  ActivationNoticeStore,
  | "claim"
  | "isSuppressed"
  | "markAttempted"
  | "markFailed"
  | "markSent"
  | "markSkipped"
  | "stillOwed"
>;

export interface ActivationNoticeDependencies {
  /** Null while the configuration is incomplete (or the stop is not in force): the notice is skipped. */
  email: ActivationNoticeEmailConfig | null;
  notices: ActivationNoticeReader;
  now?: () => Date;
  recipients: Pick<ActivationNoticeRecipientClient, "recipient">;
  send?: ClosureNoticeSender;
  /** `ACTIVATION_EMAILS_ENABLED`, read once: off, the notice is skipped before anything is read. */
  switchedOn: boolean;
}

type ActivationNoticeBindings = EmailBindings &
  Pick<WorkerBindings, "ACTIVATION_EMAILS_ENABLED" | "AUTH_HYPERDRIVE">;

/**
 * The consumer's dependencies in the Worker: the notices through the billing connection, and the address through the
 * authentication role, opened only with the switch on and the configuration complete. The switch on with a sending
 * that cannot happen is an incident (an error, so Sentry sees it).
 */
export function activationNoticeDependenciesOf(
  bindings: ActivationNoticeBindings,
  store: ActivationNoticeReader,
  openRecipients: (connectionString: string) => ActivationNoticeRecipientClient
): {
  close: () => Promise<void>;
  dependencies: ActivationNoticeDependencies;
} {
  const switchedOn = activationEmailsEnabled(bindings);
  const config = switchedOn ? activationNoticeEmailConfig(bindings) : null;
  const authConnection = bindings.AUTH_HYPERDRIVE?.connectionString;
  const recipients =
    config && authConnection ? openRecipients(authConnection) : null;
  return {
    close: async () => {
      await recipients?.close();
    },
    dependencies: {
      email: recipients ? config : null,
      notices: store,
      // never called without them: the notice is skipped before the address is read
      recipients: recipients ?? { recipient: () => Promise.resolve(null) },
      switchedOn,
    },
  };
}

/** A failure of the provider or the network: the queue tries again, then the dead-letter queue (an incident). */
export class ActivationNoticeRetryError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super("activation_notice_email_retry");
    this.name = "ActivationNoticeRetryError";
    this.status = status;
  }
}

export type ActivationNoticeOutcome = "failed" | "not_due" | "sent" | "skipped";

interface NoticeFields {
  noticeId: ReturnType<typeof opaqueId>;
  organizationId: ReturnType<typeof opaqueId>;
}

/**
 * The handler of `activation.notice`. The event names a notice: the body and the outbox key must name the same one.
 * A failure of the provider or the network throws `ActivationNoticeRetryError` with the notice still owed.
 */
export async function handleActivationNotice(
  dependencies: ActivationNoticeDependencies,
  envelope: QueueEnvelope
): Promise<ActivationNoticeOutcome> {
  const { noticeId } = envelope.event;
  if (
    typeof noticeId !== "string" ||
    !NOTICE_ID.test(noticeId) ||
    envelope.idempotencyKey !== outboxIdempotencyKey(envelope.type, noticeId)
  ) {
    throw new PermanentHandlerError("activation_notice_event_invalid");
  }
  const { organizationId } = envelope;
  const fields: NoticeFields = {
    noticeId: opaqueId(noticeId),
    organizationId: opaqueId(organizationId),
  };
  const { notices } = dependencies;
  const skip = async (
    reason: ActivationNoticeSkipReason,
    noticeStep?: ActivationNoticeStep
  ): Promise<ActivationNoticeOutcome> => {
    const marked = await notices.markSkipped(noticeId, organizationId, reason);
    logger.info("activation_notice_skipped", {
      ...fields,
      marked,
      outcome: "skipped",
      reason,
      step: noticeStep,
    });
    return marked ? "skipped" : "not_due";
  };
  if (!dependencies.switchedOn) {
    // nothing else is read: the notice is closed only if still owed, so nothing piled up goes out on a later switch
    return await skip("switched_off");
  }
  const now = dependencies.now?.() ?? new Date();
  const claimed = await notices.claim(noticeId, organizationId);
  const reread = claimed
    ? await notices.stillOwed(noticeId, organizationId, now)
    : null;
  if (!(claimed && reread)) {
    logger.info("activation_notice_not_due", {
      ...fields,
      outcome: "skipped",
    });
    return "not_due";
  }
  if ("skip" in reread) {
    return await skip(reread.skip);
  }
  const { step } = reread;
  // the re-read already answers state_changed for an a1 of a store with a product; this keeps the Worker from rendering
  // a model that does not exist if it ever did not
  const variant = activationNoticeVariant(step, reread.hasProduct);
  if (!variant) {
    return await skip("state_changed", step);
  }
  const config = dependencies.email;
  if (!config) {
    // the switch on with a sending that cannot happen (or before the stop on a complaint exists): an incident
    logger.error("activation_notice_email_misconfigured", {
      ...fields,
      outcome: "failure",
      reason: "email_not_configured",
      step,
    });
    return await skip("email_not_configured", step);
  }
  if (
    claimed.firstAttemptedAt &&
    now.getTime() - claimed.firstAttemptedAt.getTime() >
      ACTIVATION_NOTICE_DELIVERY_WINDOW_MS
  ) {
    logger.error("activation_notice_delivery_window_passed", {
      ...fields,
      outcome: "failure",
      reason: "delivery_window_passed",
      step,
    });
    return await skip("delivery_window_passed", step);
  }
  if (!withinActivationSendHours(now)) {
    if (claimed.firstAttemptedAt) {
      // a retry of a send that failed close to 20:00: the tip is dropped, and a failure of the provider should be seen
      logger.warn("activation_notice_retry_outside_send_hours", {
        ...fields,
        outcome: "skipped",
        reason: "outside_send_hours",
        step,
      });
    }
    return await skip("outside_send_hours", step);
  }
  const address = await dependencies.recipients.recipient(
    noticeId,
    organizationId
  );
  const normalized = address ? normalizeActivationAddress(address) : null;
  if (!(address && normalized)) {
    return await skip("no_recipient", step);
  }
  const secrets = [config.suppression.current, config.suppression.previous]
    .filter((secret): secret is string => secret !== undefined)
    .map((secret) => activationSuppressionHmac(secret, normalized));
  if (await notices.isSuppressed(await Promise.all(secrets))) {
    return await skip("address_suppressed", step);
  }
  return await sendActivationNotice(dependencies, config, {
    fields,
    noticeId,
    organizationId,
    step,
    store: reread.store,
    // the address the suppression was checked for, never another text the provider could read differently
    to: normalized,
    userId: claimed.userId,
    variant,
  });
}

async function sendActivationNotice(
  dependencies: ActivationNoticeDependencies,
  config: ActivationNoticeEmailConfig,
  input: {
    fields: NoticeFields;
    noticeId: string;
    organizationId: string;
    step: ActivationNoticeStep;
    store: string;
    to: string;
    userId: string;
    variant: NonNullable<ReturnType<typeof activationNoticeVariant>>;
  }
): Promise<ActivationNoticeOutcome> {
  const { fields, noticeId, organizationId, step } = input;
  const { notices } = dependencies;
  // before the render and the send, on its own: it stays when either throws, and starts the 23 hours
  await notices.markAttempted(noticeId, organizationId);
  const message = await renderActivationNoticeEmail({
    appBaseUrl: config.appBaseUrl,
    store: input.store,
    supportEmail: config.supportEmail,
    unsubscribeToken: await createUnsubscribeToken(
      config.unsubscribe,
      input.userId
    ),
    variant: input.variant,
  });
  const send =
    dependencies.send ??
    createResendClosureNoticeSender({
      apiKey: config.apiKey,
      from: config.from,
      replyTo: config.supportEmail,
    });
  const result = await send({
    headers: message.headers,
    html: message.html,
    idempotencyKey: activationNoticeIdempotencyKey(noticeId),
    subject: message.subject,
    text: message.text,
    to: input.to,
  });
  if (
    result.outcome === "retry" &&
    result.status === 409 &&
    result.code === RESEND_KEY_TAKEN
  ) {
    // a message was already taken under this notice's key (the store renamed between two tries): it went out
    const marked = await notices.markSent(noticeId, organizationId);
    logger.info("activation_notice_sent", {
      ...fields,
      marked,
      outcome: "success",
      reason: RESEND_KEY_TAKEN,
      step,
    });
    return "sent";
  }
  if (result.outcome === "retry") {
    logger.error("activation_notice_failed", {
      ...fields,
      errorCode: result.code ?? undefined,
      httpStatus: result.status ?? undefined,
      outcome: "failure",
      reason: "email_provider_unavailable",
      step,
    });
    throw new ActivationNoticeRetryError(result.status);
  }
  if (result.outcome === "rejected") {
    const marked = await notices.markFailed(
      noticeId,
      organizationId,
      EMAIL_REJECTED
    );
    logger.error("activation_notice_failed", {
      ...fields,
      errorCode: result.code ?? undefined,
      httpStatus: result.status,
      marked,
      outcome: "rejected",
      reason: EMAIL_REJECTED,
      step,
    });
    return "failed";
  }
  const marked = await notices.markSent(noticeId, organizationId);
  logger.info("activation_notice_sent", {
    ...fields,
    // false: the provider took it and the notice was settled meanwhile; the provider's key keeps it from going twice
    marked,
    outcome: "success",
    step,
  });
  return "sent";
}
