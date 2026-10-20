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
  "claimClosureNoticeDelivery"
>;

/**
 * The handler of `organization.closure_notice` (ADR 0102, amended). The event names a notice: the handler reads it by
 * ID and organization through the privacy role's own function (never by the envelope alone), so a duplicate, a
 * notice already settled, one of a closure the owner undid or one of an organization no longer in closure finds
 * nothing to do. No e-mail goes out yet: with no e-mail configured the notice is left unresolved, neither sent nor
 * failed (decision of 20/10/2026), so the change that sends the e-mail can still send the ones owed, and a notice
 * unresolved for more than `CLOSURE_NOTICE_OVERDUE_DAYS` days enters the alert of a store left behind. The deletion
 * waits for a delivered notice, so nothing is deleted meanwhile. The panel still shows the dates. Nothing of the
 * owner (address, name) is read or logged here.
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
  logger.warn("closure_notice_not_sent", {
    milestone: delivery.milestone,
    noticeId: opaqueId(noticeId),
    organizationId: opaqueId(envelope.organizationId),
    outcome: "skipped",
    reason: CLOSURE_NOTICE_EMAIL_NOT_CONFIGURED,
  });
}
