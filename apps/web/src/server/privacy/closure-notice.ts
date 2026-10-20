import type { PrivacyMaintenanceClient } from "@polaris/db/privacy-maintenance";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { logger, opaqueId } from "@polaris/observability/logger";
import { PermanentHandlerError } from "../queue/consumer";

/** Why a notice did not go out: no e-mail is sent from this Worker yet (the e-mail is the next change). */
const CLOSURE_NOTICE_EMAIL_NOT_CONFIGURED = "email_not_configured";

const NOTICE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type NoticeClient = Pick<
  PrivacyMaintenanceClient,
  "claimClosureNoticeDelivery" | "markClosureNoticeFailed"
>;

/**
 * The handler of `organization.closure_notice` (ADR 0102, amended). The event names a notice: the handler reads it by
 * ID and organization through the privacy role's own function (never by the envelope alone), so a duplicate, a
 * notice already settled, one of a closure the owner undid or one of an organization no longer in closure finds
 * nothing to do. No e-mail goes out yet: the notice fails closed, once and with no retry, as `email_not_configured`
 * (the design's rule for an environment without the e-mail settings), and the panel still shows the dates. Nothing
 * of the owner (address, name) is read or logged here.
 */
export async function handleClosureNotice(
  client: NoticeClient,
  envelope: QueueEnvelope
): Promise<void> {
  const { noticeId } = envelope.event;
  // the notice the body names must be the one the outbox key (checked against the outbox) names
  if (
    typeof noticeId !== "string" ||
    !NOTICE_ID.test(noticeId) ||
    envelope.idempotencyKey !== outboxIdempotencyKey(envelope.type, noticeId)
  ) {
    throw new PermanentHandlerError("closure_notice_event_invalid");
  }
  const delivery = await client.claimClosureNoticeDelivery(
    noticeId,
    envelope.organizationId
  );
  if (!delivery) {
    logger.info("closure_notice_not_due", {
      noticeId: opaqueId(noticeId),
      organizationId: opaqueId(envelope.organizationId),
      outcome: "skipped",
    });
    return;
  }
  await client.markClosureNoticeFailed(
    noticeId,
    envelope.organizationId,
    CLOSURE_NOTICE_EMAIL_NOT_CONFIGURED
  );
  logger.warn("closure_notice_not_sent", {
    milestone: delivery.milestone,
    noticeId: opaqueId(noticeId),
    organizationId: opaqueId(envelope.organizationId),
    outcome: "rejected",
    reason: CLOSURE_NOTICE_EMAIL_NOT_CONFIGURED,
  });
}
