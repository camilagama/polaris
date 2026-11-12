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

/**
 * Whether the stop of the series on a complaint (ADR 0106, D7) is in force in the code. Until it is, no tip may go out
 * even with the switch on and everything configured: the consumer counts the sending as not configured
 * (`email_not_configured`), because one complaint of a hostile sign-up could suspend the provider's account that the
 * sign-in and the billing e-mails share. The change that brings the stop turns this to `true`.
 */
export const STOP_ENFORCED: boolean = false;

/** The hours of São Paulo a tip may go out in, a retry of the queue included: from 08:00 to before 20:00. */
export const ACTIVATION_SEND_HOURS = Object.freeze({
  from: 8,
  timeZone: "America/Sao_Paulo",
  until: 20,
});

const hourFormat = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  hourCycle: "h23",
  timeZone: ACTIVATION_SEND_HOURS.timeZone,
});

export function withinActivationSendHours(now: Date): boolean {
  const hour = Number(
    hourFormat.formatToParts(now).find((part) => part.type === "hour")?.value
  );
  return (
    hour >= ACTIVATION_SEND_HOURS.from && hour < ACTIVATION_SEND_HOURS.until
  );
}

// what the provider writes around an address ("Nome <a@b.com>"): only what is inside the last angle brackets counts
const ANGLE_ADDRESS = /<([^<>]*)>\s*$/;
const PLAIN_ADDRESS = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

/**
 * The one form of an address for the HMAC of the suppression (ADR 0106, D8): the send and the provider's webhook must
 * reach the same bytes. The address alone (no display name), trimmed, in lower case; null for a text that is not one
 * address.
 */
export function normalizeActivationAddress(raw: string): string | null {
  const inner = ANGLE_ADDRESS.exec(raw)?.[1] ?? raw;
  const address = inner.trim().toLowerCase();
  return PLAIN_ADDRESS.test(address) ? address : null;
}
