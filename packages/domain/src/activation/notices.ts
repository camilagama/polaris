/**
 * Why a tip of the activation series (ADR 0106, D3) is recorded skipped instead of sent. The codes go to
 * `activation_notices.skipped_reason` and the measure (M1) reads them aggregated; none reaches the person. Their order is
 * the order the sender checks them: the first that holds is the one recorded.
 *
 * The rules the database re-reads for one notice, in the order `activation_notice_still_owed` answers them (migration
 * 0131): the PostgreSQL gate `activation-candidates` seeds a store for each and fails if the function answers a code
 * that is not here, or in another order.
 */
export const ACTIVATION_NOTICE_REREAD_REASONS = Object.freeze([
  "expired",
  "series_window_passed",
  "activated",
  "opted_out",
  "billing_relation",
  "store_not_active",
  "privacy_request_open",
  "internal_store",
  "not_first_owner",
  "email_not_verified",
  "state_changed",
] as const);

/** Every code, the Worker's around the database's: the switch first, before anything is read. */
export const ACTIVATION_NOTICE_SKIP_REASONS = Object.freeze([
  "switched_off",
  ...ACTIVATION_NOTICE_REREAD_REASONS,
  "email_not_configured",
  "delivery_window_passed",
  // a retry of the queue after 20:00 of São Paulo: a tip is dropped rather than sent at night or held for tomorrow
  "outside_send_hours",
  "no_recipient",
  "address_suppressed",
] as const);

export type ActivationNoticeSkipReason =
  (typeof ACTIVATION_NOTICE_SKIP_REASONS)[number];
