import type { ClosureNoticeRecipientClient } from "@polaris/db/closure-notice-recipient";
import type { PrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { logger, opaqueId } from "@polaris/observability/logger";
import { PermanentHandlerError } from "../queue/consumer";
import {
  type ClosureNoticeEmailConfig,
  type ClosureNoticeSender,
  createResendClosureNoticeSender,
  renderClosureNoticeEmail,
} from "./closure-notice-email";

/** Why a notice did not go out and stays owed: no e-mail is configured here (the switch off, or a secret missing). */
const CLOSURE_NOTICE_EMAIL_NOT_CONFIGURED = "email_not_configured";
/** The owner's e-mail is not verified: nothing goes to an address nobody proved, and the notice stays owed. */
const CLOSURE_NOTICE_EMAIL_NOT_VERIFIED = "email_not_verified";
/** The provider refused this message for good (the address, most likely): the notice is failed, with no retry. */
const CLOSURE_NOTICE_EMAIL_REJECTED = "email_rejected";

/** Notices the handover sends in one run of the privacy job, at most (one at a time). */
const CLOSURE_NOTICE_HANDOVER_BATCH = 20;

const NOTICE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type NoticeClient = Pick<
  PrivacyMaintenanceClient,
  | "claimClosureNoticeDelivery"
  | "markClosureNoticeFailed"
  | "markClosureNoticeSent"
>;

/** The e-mail, when it is on: its configuration, where the address is read and how the message goes. */
export interface ClosureNoticeEmail {
  config: ClosureNoticeEmailConfig;
  recipients: Pick<ClosureNoticeRecipientClient, "recipient">;
  send?: ClosureNoticeSender;
}

export interface ClosureNoticeDependencies {
  /** Null while the e-mail is off: every notice is left owed, neither sent nor failed. */
  email: ClosureNoticeEmail | null;
  notices: NoticeClient;
}

/** A failure of the provider or the network: the queue tries again, and the handover after it. */
export class ClosureNoticeRetryError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super("closure_notice_email_retry");
    this.name = "ClosureNoticeRetryError";
    this.status = status;
  }
}

type ClosureNoticeOutcome =
  | "failed"
  | "not_configured"
  | "not_due"
  | "not_verified"
  | "sent";

/** Whether the switch of the e-mail of the notices is on: only the exact text `true` turns it on. */
function closureNoticeEmailEnabled(value: string | undefined): boolean {
  return value === "true";
}

/**
 * The configuration of the e-mail of the notices, or null when it is off: `CLOSURE_NOTICE_EMAIL_ENABLED` must be
 * `true` and the provider's key, the sender and the app's origin (an `https` URL, or `http` on localhost) must be
 * there. Nothing of it is logged.
 */
export function closureNoticeEmailConfig(bindings: {
  AUTH_EMAIL_FROM?: string;
  AUTH_EMAIL_REPLY_TO?: string;
  BETTER_AUTH_BASE_URL?: string;
  CLOSURE_NOTICE_EMAIL_ENABLED?: string;
  RESEND_API_KEY?: string;
}): ClosureNoticeEmailConfig | null {
  if (!closureNoticeEmailEnabled(bindings.CLOSURE_NOTICE_EMAIL_ENABLED)) {
    return null;
  }
  const apiKey = bindings.RESEND_API_KEY?.trim();
  const from = bindings.AUTH_EMAIL_FROM?.trim();
  const origin = appOrigin(bindings.BETTER_AUTH_BASE_URL);
  if (!(apiKey && from && origin)) {
    return null;
  }
  const replyTo = bindings.AUTH_EMAIL_REPLY_TO?.trim();
  return { apiKey, appOrigin: origin, from, ...(replyTo ? { replyTo } : {}) };
}

function appOrigin(value: string | undefined): string | null {
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
    // not a URL: the e-mail stays off
  }
  return null;
}

/**
 * Sends one closure notice (ADR 0102, amended), for its consumer and for the handover alike. The notice is read by ID
 * and organization through the privacy role's own function, so a notice already settled, of a closure the owner undid
 * or of a store no longer in closure finds nothing to do. With the e-mail off it is left owed, neither sent nor failed
 * (decision of 20/10/2026). With it on, the address comes from the one function of the authentication role that
 * answers it, only for a notice still owed and only when verified (an e-mail not verified leaves the notice owed, not
 * failed); the message goes under the notice's ID as the provider's idempotency key, and the notice is marked sent,
 * or failed when the provider refuses the message for good. A failure of the provider or the network throws
 * `ClosureNoticeRetryError`, with the notice still owed. The address and the owner's name never reach a log, an error
 * or an event.
 */
async function deliverClosureNotice(
  dependencies: ClosureNoticeDependencies,
  noticeId: string,
  organizationId: string
): Promise<ClosureNoticeOutcome> {
  const fields = {
    noticeId: opaqueId(noticeId),
    organizationId: opaqueId(organizationId),
  };
  const delivery = await dependencies.notices.claimClosureNoticeDelivery(
    noticeId,
    organizationId
  );
  if (!delivery) {
    logger.info("closure_notice_not_due", { ...fields, outcome: "skipped" });
    return "not_due";
  }
  const { email } = dependencies;
  if (!email) {
    logger.warn("closure_notice_not_sent", {
      ...fields,
      milestone: delivery.milestone,
      outcome: "skipped",
      reason: CLOSURE_NOTICE_EMAIL_NOT_CONFIGURED,
    });
    return "not_configured";
  }
  const recipient = await email.recipients.recipient(noticeId, organizationId);
  if (!recipient) {
    // settled between the two reads (sent by the other path, skipped by the handover, dismissed)
    logger.info("closure_notice_not_due", { ...fields, outcome: "skipped" });
    return "not_due";
  }
  if (!recipient.verified) {
    logger.warn("closure_notice_not_sent", {
      ...fields,
      milestone: delivery.milestone,
      outcome: "skipped",
      reason: CLOSURE_NOTICE_EMAIL_NOT_VERIFIED,
    });
    return "not_verified";
  }
  const message = await renderClosureNoticeEmail(
    delivery,
    email.config.appOrigin
  );
  const send = email.send ?? createResendClosureNoticeSender(email.config);
  const result = await send({
    ...message,
    idempotencyKey: noticeId,
    to: recipient.email,
  });
  if (result.outcome === "retry") {
    logger.error("closure_notice_email_failed", {
      ...fields,
      httpStatus: result.status ?? undefined,
      milestone: delivery.milestone,
      outcome: "failure",
      reason: "email_provider_unavailable",
    });
    throw new ClosureNoticeRetryError(result.status);
  }
  if (result.outcome === "rejected") {
    const marked = await dependencies.notices.markClosureNoticeFailed(
      noticeId,
      organizationId,
      CLOSURE_NOTICE_EMAIL_REJECTED
    );
    logger.error("closure_notice_email_failed", {
      ...fields,
      httpStatus: result.status,
      marked,
      milestone: delivery.milestone,
      outcome: "rejected",
      reason: CLOSURE_NOTICE_EMAIL_REJECTED,
    });
    return "failed";
  }
  const marked = await dependencies.notices.markClosureNoticeSent(
    noticeId,
    organizationId
  );
  logger.info("closure_notice_email_sent", {
    ...fields,
    // false: the provider took it, and the notice was settled meanwhile (the handover replaced it, or it is no longer
    // of the cycle in course); the provider's key keeps it from going twice
    marked,
    milestone: delivery.milestone,
    outcome: "success",
  });
  return "sent";
}

/**
 * The handler of `organization.closure_notice` (ADR 0102, amended). The event names a notice: the handler checks that
 * the body and the outbox key name the same one, and sends it (`deliverClosureNotice`). A failure of the provider is
 * tried again by the queue (and, after the dead-letter queue, by the handover of the privacy job).
 */
export async function handleClosureNotice(
  dependencies: ClosureNoticeDependencies,
  envelope: QueueEnvelope
): Promise<ClosureNoticeOutcome> {
  const { noticeId } = envelope.event;
  // the notice the body names must be the one the outbox key (checked against the outbox) names
  if (
    typeof noticeId !== "string" ||
    !NOTICE_ID.test(noticeId) ||
    envelope.idempotencyKey !== outboxIdempotencyKey(envelope.type, noticeId)
  ) {
    throw new PermanentHandlerError("closure_notice_event_invalid");
  }
  return await deliverClosureNotice(
    dependencies,
    noticeId,
    envelope.organizationId
  );
}

export interface ClosureNoticeHandoverReport {
  failed: number;
  handedOver: number;
  notVerified: number;
  retry: number;
  sent: number;
}

/**
 * The handover of the notices left owed (ADR 0102, amended), in the privacy job, only with the e-mail on: while it was
 * off, or when a delivery did not settle, a notice stays owed. The database answers the latest owed notice of each
 * cycle (and settles the earlier ones `skipped`), and each is sent here one at a time; a failure of one never stops
 * the others.
 */
export async function handOverOwedClosureNotices(
  dependencies: ClosureNoticeDependencies & {
    notices: NoticeClient &
      Pick<PrivacyMaintenanceClient, "listOwedClosureNotices">;
  },
  limit = CLOSURE_NOTICE_HANDOVER_BATCH
): Promise<ClosureNoticeHandoverReport> {
  const report: ClosureNoticeHandoverReport = {
    failed: 0,
    handedOver: 0,
    notVerified: 0,
    retry: 0,
    sent: 0,
  };
  if (!dependencies.email) {
    return report;
  }
  const owed = await dependencies.notices.listOwedClosureNotices(limit);
  report.handedOver = owed.length;
  for (const notice of owed) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one message at a time, under the provider's rate limit
      const outcome = await deliverClosureNotice(
        dependencies,
        notice.noticeId,
        notice.organizationId
      );
      if (outcome === "sent") {
        report.sent += 1;
      } else if (outcome === "failed") {
        report.failed += 1;
      } else if (outcome === "not_verified") {
        report.notVerified += 1;
      }
    } catch (error: unknown) {
      if (!(error instanceof ClosureNoticeRetryError)) {
        throw error;
      }
      report.retry += 1;
    }
  }
  return report;
}
