import {
  type BillingNoticeKind,
  type BillingNoticeSkipReason,
  noticeStillTrue,
  renewalFailedOf,
} from "@polaris/domain/billing/notices";
import { ADAPTATION_DAYS } from "@polaris/domain/billing/operational-selection";
import {
  type PlanMethod,
  planMethodOf,
  refundWindowClosesAt,
} from "@polaris/domain/billing/plan-view";
import type { BillingNoticeRecipientClient } from "@polaris/db/billing-notice-recipient";
import type {
  BillingStore,
  BillingNoticeStoreFacts as StoredNoticeStoreFacts,
  StoredBillingNotice,
} from "@polaris/db/billing-store";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { localDate } from "@polaris/domain/organization/closure-deadlines";
import { logger, opaqueId } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import {
  type ClosureNoticeSender,
  createResendClosureNoticeSender,
} from "../privacy/closure-notice-email";
import { DeferredHandlerError, PermanentHandlerError } from "../queue/consumer";
import {
  type BillingNoticeEmail,
  renderBillingNoticeEmail,
} from "./emails/billing-notice-email";
import type { BillingEmailStore } from "./emails/content";

/**
 * The consumer of `billing.notice` (ADR 0104, decision 7; design t268 v2, §9): reads the notice and the billing record
 * again (the billing role), checks it is still true (`noticeStillTrue`), reads the store it speaks of and the address of
 * its owner (the authentication role's `billing_notice_recipient`, never the payer of the Pix), renders the e-mail and
 * sends it under the notice's ID as the provider's idempotency key, then marks it sent, failed or skipped. The address,
 * the store's name and the amounts never reach a log, an error or an event: the log carries the kind, the outcome, the
 * reason and the opaque IDs.
 */

const DAY_MS = 86_400_000;

const NOTICE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The provider refused this message for good (the address, most likely): failed, with no retry. */
const EMAIL_REJECTED = "email_rejected";

/**
 * Resend's 409 for a key already used by another body in its 24 hours: a message under this notice's key was taken.
 * The other 409 (`concurrent_idempotent_requests`, the same key still in flight) is tried again.
 */
const RESEND_KEY_TAKEN = "invalid_idempotent_request";

/** A notice due within this long goes back to the queue with a delay; a later one waits for the hourly handover. */
const BILLING_NOTICE_QUEUE_WAIT_MS = 3_600_000;
/**
 * A notice first tried longer ago than this is not sent again: Resend keeps an idempotency key for 24 hours, and past
 * them a send whose marking failed would go out twice. One hour of margin under the 24. It counts from the first
 * attempt, not from when the notice was due: one never tried has no key at the provider and can still go out.
 */
const BILLING_NOTICE_DELIVERY_WINDOW_MS = 23 * 3_600_000;
/** The queue brings a deferred notice back a little after it is due. */
const DEFER_MARGIN_SECONDS = 5;

/**
 * Notices the handover sends in one hourly run, at most (one at a time, under the provider's rate limit). Each one
 * is a render and a send inside the cron's 10 ms of CPU on the Free plan, so the batch is small: what is left goes out
 * in the next hour.
 */
const BILLING_NOTICE_HANDOVER_BATCH = 5;

/** A notice as the billing role reads it again, with the record of its store and what its rule needs. */
export type BillingNoticeDelivery = StoredBillingNotice;

/** The billing role: reads a notice still owed, lists the owed ones that are due, and marks the outcome once. */
export interface BillingNoticeReader {
  /** Null when the notice is not owed any more (sent, failed, skipped) or is not of this store. */
  claim: (
    noticeId: string,
    organizationId: string
  ) => Promise<BillingNoticeDelivery | null>;
  listOwed: (
    now: Date,
    limit: number
  ) => Promise<{ noticeId: string; organizationId: string }[]>;
  /** Writes the first attempt (once, in a statement of its own) before the send, so it stays if the send throws. */
  markAttempted: (noticeId: string, organizationId: string) => Promise<boolean>;
  markFailed: (
    noticeId: string,
    organizationId: string,
    code: string
  ) => Promise<boolean>;
  markSent: (noticeId: string, organizationId: string) => Promise<boolean>;
  markSkipped: (
    noticeId: string,
    organizationId: string,
    reason: BillingNoticeSkipReason | BillingNoticeDeliverySkip
  ) => Promise<boolean>;
}

/** What the e-mail says of the store the notice is of, read for a notice still owed (`billing_notice_store`). */
export type BillingNoticeStoreFacts = StoredNoticeStoreFacts;

interface BillingNoticeStores {
  /** Null when there is no such store any more (purged): the notice has no one to go to. */
  storeOf: (
    noticeId: string,
    organizationId: string
  ) => Promise<BillingNoticeStoreFacts | null>;
}

export type BillingNoticeRecipient =
  | { email: string; verified: true }
  | { verified: false };

interface BillingNoticeRecipients {
  /** Null when the notice is not owed any more or has nobody to go to (the store purged, the person gone). */
  recipient: (
    noticeId: string,
    organizationId: string
  ) => Promise<BillingNoticeRecipient | null>;
}

/**
 * Why the consumer itself did not send: nobody to send to, an address nobody proved, or a notice first tried so long
 * ago that a new send would escape the provider's idempotency window.
 */
type BillingNoticeDeliverySkip =
  | "delivery_window_passed"
  | "email_not_verified"
  | "no_recipient";

/** The provider's configuration (secrets): never logged. */
export interface BillingNoticeEmailConfig {
  apiKey: string;
  appOrigin: string;
  from: string;
  /** The support box of the footer and the reply-to (`BILLING_SUPPORT_EMAIL`). */
  supportEmail: string;
}

export interface BillingNoticeDependencies {
  /** The e-mails of the billing cycle (`BILLING_SELF_SERVICE_ENABLED`); null while off. */
  billingEmail: BillingNoticeEmailConfig | null;
  notices: BillingNoticeReader;
  now?: () => Date;
  recipients: BillingNoticeRecipients;
  send?: ClosureNoticeSender;
  stores: BillingNoticeStores;
  /** The welcome (`WELCOME_EMAIL_ENABLED`); null while off. */
  welcomeEmail: BillingNoticeEmailConfig | null;
}

/** A failure of the provider or the network: the queue tries again, and the hourly handover after it. */
export class BillingNoticeRetryError extends Error {
  readonly status: number | null;

  constructor(status: number | null) {
    super("billing_notice_email_retry");
    this.name = "BillingNoticeRetryError";
    this.status = status;
  }
}

export type BillingNoticeOutcome =
  | "failed"
  | "not_due"
  | "not_yet_due"
  | "sent"
  | "skipped";

const BILLING_SELF_SERVICE_ON = "true";
const SUPPORT_EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/**
 * The configuration of the e-mails, or null when off: the switch (only the exact text `true`), the provider's key, the
 * sender, the support box and the app's origin (an `https` URL, or `http` on localhost). Nothing of it is logged.
 */
export function billingNoticeEmailConfig(
  bindings: {
    AUTH_EMAIL_FROM?: string;
    BETTER_AUTH_BASE_URL?: string;
    BILLING_SUPPORT_EMAIL?: string;
    RESEND_API_KEY?: string;
  },
  switchValue: string | undefined
): BillingNoticeEmailConfig | null {
  if (switchValue !== BILLING_SELF_SERVICE_ON) {
    return null;
  }
  const apiKey = bindings.RESEND_API_KEY?.trim();
  const from = bindings.AUTH_EMAIL_FROM?.trim();
  const supportEmail = bindings.BILLING_SUPPORT_EMAIL?.trim();
  const appOrigin = originOf(bindings.BETTER_AUTH_BASE_URL);
  // one address, never a list: it is the reply-to and the footer
  if (
    !(
      apiKey &&
      from &&
      supportEmail &&
      appOrigin &&
      SUPPORT_EMAIL.test(supportEmail)
    )
  ) {
    return null;
  }
  return { apiKey, appOrigin, from, supportEmail };
}

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
    // not a URL: the e-mail stays off
  }
  return null;
}

/** What the consumer and the handover use of the billing store (the billing role). */
export type BillingNoticeStore = Pick<
  BillingStore,
  | "claimNotice"
  | "listOwedNotices"
  | "markNoticeAttempted"
  | "markNoticeFailed"
  | "markNoticeSent"
  | "markNoticeSkipped"
  | "readNoticeStore"
>;

interface BillingNoticeBindings {
  AUTH_EMAIL_FROM?: string;
  AUTH_HYPERDRIVE?: { connectionString?: string };
  BETTER_AUTH_BASE_URL?: string;
  BILLING_SELF_SERVICE_ENABLED?: string;
  BILLING_SUPPORT_EMAIL?: string;
  RESEND_API_KEY?: string;
  WELCOME_EMAIL_ENABLED?: string;
}

/**
 * The consumer's dependencies in the Worker: the notice and its store through the billing store (the billing role),
 * and the address through `billing_notice_recipient` (the authentication role), opened only when an e-mail is on. The
 * billing e-mails follow `BILLING_SELF_SERVICE_ENABLED`, the welcome `WELCOME_EMAIL_ENABLED`; either one needs the
 * provider's key, the sender, the support box, the app's origin and the authentication role, or it stays off and its
 * notices are skipped `email_not_configured`.
 */
export function billingNoticeDependenciesOf(
  bindings: BillingNoticeBindings,
  store: BillingNoticeStore,
  openRecipients: (connectionString: string) => BillingNoticeRecipientClient
): { close: () => Promise<void>; dependencies: BillingNoticeDependencies } {
  const authConnection = bindings.AUTH_HYPERDRIVE?.connectionString;
  const billingEmail = billingNoticeEmailConfig(
    bindings,
    bindings.BILLING_SELF_SERVICE_ENABLED
  );
  const welcomeEmail = billingNoticeEmailConfig(
    bindings,
    bindings.WELCOME_EMAIL_ENABLED
  );
  const recipients =
    authConnection && (billingEmail || welcomeEmail)
      ? openRecipients(authConnection)
      : null;
  // a switch on whose e-mail cannot go out: its notices are skipped email_not_configured, so a person must see it
  for (const [email, on, config] of [
    ["billing", bindings.BILLING_SELF_SERVICE_ENABLED, billingEmail],
    ["welcome", bindings.WELCOME_EMAIL_ENABLED, welcomeEmail],
  ] as const) {
    if (on === BILLING_SELF_SERVICE_ON && !(config && recipients)) {
      logger.warn("billing_notice_email_misconfigured", { email });
    }
  }
  return {
    close: async () => {
      await recipients?.close();
    },
    dependencies: {
      billingEmail: recipients ? billingEmail : null,
      notices: {
        claim: (noticeId, organizationId) =>
          store.claimNotice(noticeId, organizationId),
        listOwed: (now, limit) => store.listOwedNotices(now, limit),
        markAttempted: (noticeId, organizationId) =>
          store.markNoticeAttempted(noticeId, organizationId),
        markFailed: (noticeId, organizationId, code) =>
          store.markNoticeFailed(noticeId, organizationId, code),
        markSent: (noticeId, organizationId) =>
          store.markNoticeSent(noticeId, organizationId),
        markSkipped: (noticeId, organizationId, reason) =>
          store.markNoticeSkipped(noticeId, organizationId, reason),
      },
      // never called with both e-mails off: the notice is skipped before the address is read
      recipients: recipients ?? { recipient: () => Promise.resolve(null) },
      stores: {
        storeOf: (noticeId, organizationId) =>
          store.readNoticeStore(noticeId, organizationId),
      },
      welcomeEmail: recipients ? welcomeEmail : null,
    },
  };
}

/** The provider's link the notice was recorded under, when it can be told: the key of E-A, E-B, E-C1, or its ledger row. */
function noticeProviderRefOf(delivery: BillingNoticeDelivery): string | null {
  if (
    delivery.kind === "trial_started" ||
    delivery.kind === "trial_charge_eve" ||
    delivery.kind === "first_charge_failed"
  ) {
    return delivery.dedupeKey;
  }
  return delivery.event?.providerRef ?? null;
}

/** The amount a notice writes: what the provider reported of the charge, or what the checkout recorded; never the catalog's. */
function amountOf(delivery: BillingNoticeDelivery): string | null {
  const { event } = delivery;
  if (delivery.kind === "charge_receipt") {
    if (event?.fact.type === "charge_succeeded" && event.fact.amount) {
      return event.fact.amount.value;
    }
    return event?.id === delivery.firstChargeEventId
      ? delivery.firstChargeAmount
      : delivery.priceAmount;
  }
  if (delivery.kind === "refund_confirmed") {
    if (event?.fact.type === "charge_refunded" && event.fact.amount) {
      return event.fact.amount.value;
    }
    return delivery.firstChargeAmount;
  }
  return delivery.priceAmount;
}

interface EmailInput {
  amount: string | null;
  delivery: BillingNoticeDelivery;
  method: PlanMethod | null;
  store: BillingNoticeStoreFacts;
  today: string;
  where: BillingEmailStore;
}

type EmailBuilder = (input: EmailInput) => BillingNoticeEmail | null;

function trialStartedEmail(input: EmailInput): BillingNoticeEmail | null {
  const { amount, delivery, method, today, where } = input;
  const { cycleMonths, firstChargeOn } = delivery;
  // a first charge already past (the method approved after it) has no day to announce
  return method &&
    amount &&
    cycleMonths &&
    firstChargeOn &&
    firstChargeOn >= today
    ? {
        amount,
        cycleMonths,
        firstChargeOn,
        kind: "trial_started",
        method,
        store: where,
        today,
      }
    : null;
}

function trialChargeEveEmail(input: EmailInput): BillingNoticeEmail | null {
  const { amount, delivery, method, where } = input;
  const { cycleMonths, firstChargeOn } = delivery;
  return method && amount && cycleMonths && firstChargeOn
    ? {
        amount,
        cycleMonths,
        firstChargeOn,
        kind: "trial_charge_eve",
        method,
        store: where,
      }
    : null;
}

function renewalFailedEmail(input: EmailInput): BillingNoticeEmail | null {
  const { amount, delivery, method, today, where } = input;
  const key = renewalFailedOf(delivery.dedupeKey);
  const { accessEndsAt } = delivery.record;
  if (!(key && accessEndsAt)) {
    return null;
  }
  if (key.milestone !== "d0") {
    return {
      accessEndsAt,
      kind: "renewal_failed",
      milestone: key.milestone,
      store: where,
      today,
    };
  }
  return method && amount
    ? {
        accessEndsAt,
        amount,
        kind: "renewal_failed",
        method,
        milestone: "d0",
        store: where,
      }
    : null;
}

function accessEndedEmail(input: EmailInput): BillingNoticeEmail | null {
  const { delivery, store, where } = input;
  const endedAt = new Date(delivery.dedupeKey);
  if (Number.isNaN(endedAt.getTime())) {
    return null;
  }
  const overLimit =
    delivery.record.state === "free_over_limit" && delivery.overLimitSince
      ? {
          chooseUntil: new Date(
            delivery.overLimitSince.getTime() + ADAPTATION_DAYS * DAY_MS
          ),
          limit: store.variantLimit,
          variants: store.variants,
        }
      : null;
  return { endedAt, kind: "access_ended", overLimit, store: where };
}

function chargeReceiptEmail(input: EmailInput): BillingNoticeEmail | null {
  const { amount, delivery, method, where } = input;
  const { event, firstChargeAt } = delivery;
  if (!(method && amount && event?.fact.type === "charge_succeeded")) {
    return null;
  }
  const first = event.id === delivery.firstChargeEventId && firstChargeAt;
  return {
    amount,
    kind: "charge_receipt",
    method,
    paidAt: event.fact.occurredAt,
    periodEndsAt: event.fact.periodEndsAt,
    refundUntil: first
      ? new Date(refundWindowClosesAt(firstChargeAt).getTime() - 1000)
      : null,
    store: where,
  };
}

function renewalCancelledEmail(input: EmailInput): BillingNoticeEmail | null {
  const { accessEndsAt, state } = input.delivery.record;
  return accessEndsAt
    ? {
        accessEndsAt,
        kind: "renewal_cancelled",
        phase: state === "trialing" ? "trial" : "pro",
        store: input.where,
      }
    : null;
}

function annualRenewalReminderEmail(
  input: EmailInput
): BillingNoticeEmail | null {
  const { amount, delivery, method, store, where } = input;
  const { accessEndsAt } = delivery.record;
  return method && amount && accessEndsAt
    ? {
        amount,
        chargeOn: localDate(
          new Date(accessEndsAt.getTime() - 1),
          store.timeZone
        ),
        kind: "annual_renewal_reminder",
        method,
        store: where,
      }
    : null;
}

const EMAIL_BUILDERS: Readonly<Record<BillingNoticeKind, EmailBuilder>> = {
  access_ended: accessEndedEmail,
  annual_renewal_reminder: annualRenewalReminderEmail,
  charge_receipt: chargeReceiptEmail,
  first_charge_failed: ({ amount, delivery, where }) =>
    amount && delivery.cycleMonths
      ? {
          amount,
          cycleMonths: delivery.cycleMonths,
          kind: "first_charge_failed",
          store: where,
        }
      : null,
  refund_confirmed: ({ amount, where }) =>
    amount ? { amount, kind: "refund_confirmed", store: where } : null,
  renewal_cancelled: renewalCancelledEmail,
  renewal_failed: renewalFailedEmail,
  trial_charge_eve: trialChargeEveEmail,
  trial_started: trialStartedEmail,
  welcome: ({ where }) => ({ kind: "welcome", store: where }),
};

/**
 * The e-mail of a notice still true, from the notice, the record and the store. Null when the record lacks what the
 * text needs (no method, cycle or date): nothing is invented, and the notice is skipped as no longer true.
 */
export function billingNoticeEmailOf(
  delivery: BillingNoticeDelivery,
  store: BillingNoticeStoreFacts,
  appOrigin: string
): BillingNoticeEmail | null {
  return EMAIL_BUILDERS[delivery.kind]({
    amount: amountOf(delivery),
    delivery,
    method: planMethodOf(delivery.provider),
    store,
    today: localDate(delivery.dueAt, store.timeZone),
    where: { appOrigin, name: store.name, timeZone: store.timeZone },
  });
}

/** Why a notice is not sent now, before the e-mail is rendered; null when it goes. */
async function skipReasonOf(
  dependencies: BillingNoticeDependencies,
  delivery: BillingNoticeDelivery,
  now: Date
): Promise<
  | { reason: BillingNoticeSkipReason | BillingNoticeDeliverySkip }
  | { config: BillingNoticeEmailConfig; store: BillingNoticeStoreFacts }
> {
  const { kind, noticeId, organizationId } = delivery;
  const config =
    kind === "welcome" ? dependencies.welcomeEmail : dependencies.billingEmail;
  const store = config
    ? await dependencies.stores.storeOf(noticeId, organizationId)
    : null;
  if (config && !store) {
    return { reason: "no_recipient" };
  }
  const stale = noticeStillTrue({
    amount: amountOf(delivery),
    emailEnabled: config !== null,
    event: delivery.event?.fact ?? null,
    firstChargeOn: delivery.firstChargeOn,
    notice: {
      dedupeKey: delivery.dedupeKey,
      kind,
      recordedAt: delivery.recordedAt,
    },
    noticeProviderRef: noticeProviderRefOf(delivery),
    now,
    organizationClosed: store?.closed ?? false,
    ownerActive: store?.ownerActive ?? false,
    paidSinceNotice: delivery.paidSinceNotice,
    providerRef: delivery.providerRef,
    record: delivery.record,
    refundRequestedAt: delivery.refundRequestedAt,
    renewalFailedSentAt: delivery.renewalFailedSentAt,
    timeZone: store?.timeZone ?? "America/Sao_Paulo",
    trialStartedSentAt: delivery.trialStartedSentAt,
  });
  if (stale) {
    return { reason: stale };
  }
  return config && store
    ? { config, store }
    : { reason: "email_not_configured" };
}

/**
 * Sends one billing notice, for the consumer and for the handover alike. A notice not owed any more finds nothing to
 * do; one not yet due is left owed for the hourly handover (a receipt and a cancellation wait 10 minutes, a
 * cancellation with a refund request a day); one no longer true, with the e-mail off, with no store or no recipient
 * is marked skipped with its reason; the provider's refusal for good marks it failed; a failure of the provider or the
 * network throws `BillingNoticeRetryError` with the notice still owed.
 */
async function deliverBillingNotice(
  dependencies: BillingNoticeDependencies,
  noticeId: string,
  organizationId: string
): Promise<{ outcome: BillingNoticeOutcome; waitMs?: number }> {
  const now = dependencies.now?.() ?? new Date();
  const fields = {
    noticeId: opaqueId(noticeId),
    organizationId: opaqueId(organizationId),
  };
  const delivery = await dependencies.notices.claim(noticeId, organizationId);
  if (!delivery) {
    logger.info("billing_notice_not_due", { ...fields, outcome: "skipped" });
    return { outcome: "not_due" };
  }
  const { kind } = delivery;
  if (delivery.dueAt.getTime() > now.getTime()) {
    logger.info("billing_notice_not_yet_due", { ...fields, kind });
    return {
      outcome: "not_yet_due",
      waitMs: delivery.dueAt.getTime() - now.getTime(),
    };
  }
  const skip = async (
    reason: BillingNoticeSkipReason | BillingNoticeDeliverySkip
  ): Promise<BillingNoticeOutcome> => {
    const marked = await dependencies.notices.markSkipped(
      noticeId,
      organizationId,
      reason
    );
    logger.info("billing_notice_skipped", {
      ...fields,
      kind,
      marked,
      outcome: "skipped",
      reason,
    });
    return "skipped";
  };
  const checked = await skipReasonOf(dependencies, delivery, now);
  if ("reason" in checked) {
    return { outcome: await skip(checked.reason) };
  }
  // after the rules above, so an old notice keeps its real reason (closed store, e-mail off, state changed); only one
  // already tried can go out twice, so one never tried goes out at any age
  if (
    delivery.firstAttemptedAt &&
    now.getTime() - delivery.firstAttemptedAt.getTime() >
      BILLING_NOTICE_DELIVERY_WINDOW_MS
  ) {
    // a notice that was owed and never got out: an alert (Sentry), the same level as the failures of the cron
    logger.error("billing_notice_delivery_window_passed", {
      ...fields,
      kind,
      outcome: "failure",
      reason: "delivery_window_passed",
    });
    return { outcome: await skip("delivery_window_passed") };
  }
  const { config, store } = checked;
  const email = billingNoticeEmailOf(delivery, store, config.appOrigin);
  if (!email) {
    return { outcome: await skip("state_changed") };
  }
  const recipient = await dependencies.recipients.recipient(
    noticeId,
    organizationId
  );
  if (!recipient) {
    return { outcome: await skip("no_recipient") };
  }
  if (!recipient.verified) {
    return { outcome: await skip("email_not_verified") };
  }
  const outcome = await sendBillingNotice(dependencies, {
    config,
    email,
    fields,
    kind,
    noticeId,
    organizationId,
    to: recipient.email,
  });
  return { outcome };
}

async function sendBillingNotice(
  dependencies: BillingNoticeDependencies,
  input: {
    config: BillingNoticeEmailConfig;
    email: BillingNoticeEmail;
    fields: Record<"noticeId" | "organizationId", ReturnType<typeof opaqueId>>;
    kind: BillingNoticeKind;
    noticeId: string;
    organizationId: string;
    to: string;
  }
): Promise<BillingNoticeOutcome> {
  const { config, fields, kind, noticeId, organizationId } = input;
  const message = await renderBillingNoticeEmail(
    input.email,
    config.supportEmail
  );
  const send =
    dependencies.send ??
    createResendClosureNoticeSender({
      apiKey: config.apiKey,
      from: config.from,
      replyTo: config.supportEmail,
    });
  // the provider's key starts to count here: written first and on its own, so it stays if the send throws
  await dependencies.notices.markAttempted(noticeId, organizationId);
  const result = await send({
    ...message,
    idempotencyKey: noticeId,
    to: input.to,
  });
  if (
    result.outcome === "retry" &&
    result.status === 409 &&
    result.code === RESEND_KEY_TAKEN
  ) {
    // a message was already taken under this notice's key (the store renamed, or the count of variants changed,
    // between the first try and this one): it went out, so the notice is sent
    const marked = await dependencies.notices.markSent(
      noticeId,
      organizationId
    );
    logger.info("billing_notice_sent", {
      ...fields,
      kind,
      marked,
      outcome: "success",
      reason: RESEND_KEY_TAKEN,
    });
    return "sent";
  }
  if (result.outcome === "retry") {
    logger.error("billing_notice_failed", {
      ...fields,
      errorCode: result.code ?? undefined,
      httpStatus: result.status ?? undefined,
      kind,
      outcome: "failure",
      reason: "email_provider_unavailable",
    });
    throw new BillingNoticeRetryError(result.status);
  }
  if (result.outcome === "rejected") {
    const marked = await dependencies.notices.markFailed(
      noticeId,
      organizationId,
      EMAIL_REJECTED
    );
    logger.error("billing_notice_failed", {
      ...fields,
      errorCode: result.code ?? undefined,
      httpStatus: result.status,
      kind,
      marked,
      outcome: "rejected",
      reason: EMAIL_REJECTED,
    });
    return "failed";
  }
  const marked = await dependencies.notices.markSent(noticeId, organizationId);
  logger.info("billing_notice_sent", {
    ...fields,
    kind,
    // false: the provider took it and the notice was settled meanwhile; the provider's key keeps it from going twice
    marked,
    outcome: "success",
  });
  return "sent";
}

/**
 * The handler of `billing.notice`. The event names a notice: the handler checks that the body and the outbox key name
 * the same one, and sends it. A failure of the provider is tried again by the queue (and by the hourly handover).
 */
export async function handleBillingNotice(
  dependencies: BillingNoticeDependencies,
  envelope: QueueEnvelope
): Promise<BillingNoticeOutcome> {
  const { noticeId } = envelope.event;
  if (
    typeof noticeId !== "string" ||
    !NOTICE_ID.test(noticeId) ||
    envelope.idempotencyKey !== outboxIdempotencyKey(envelope.type, noticeId)
  ) {
    throw new PermanentHandlerError("billing_notice_event_invalid");
  }
  const delivered = await deliverBillingNotice(
    dependencies,
    noticeId,
    envelope.organizationId
  );
  if (
    delivered.waitMs !== undefined &&
    delivered.waitMs <= BILLING_NOTICE_QUEUE_WAIT_MS
  ) {
    // a receipt or a cancellation that waits its 10 minutes: the queue brings it back when it is due; a longer
    // wait (a cancellation with a refund request) is left to the hourly handover
    throw new DeferredHandlerError(
      Math.ceil(delivered.waitMs / 1000) + DEFER_MARGIN_SECONDS
    );
  }
  return delivered.outcome;
}

export interface BillingNoticeHandoverReport {
  /** Notices whose delivery threw something else than a failure of the provider: left owed, the run incomplete. */
  errors: number;
  failed: number;
  handedOver: number;
  retry: number;
  sent: number;
  skipped: number;
}

/**
 * The hourly handover of the notices the queue left owed: a cancellation that waited its day, a delivery the queue
 * gave up on. One at a time; the failure of one never stops the others. A notice that throws something else than a
 * failure of the provider is logged (its opaque IDs and the class of the error) and left owed, and the run ends with
 * `billing_notice_handover_incomplete` after the others were sent.
 */
export async function handOverOwedBillingNotices(
  dependencies: BillingNoticeDependencies,
  limit = BILLING_NOTICE_HANDOVER_BATCH
): Promise<BillingNoticeHandoverReport> {
  const report: BillingNoticeHandoverReport = {
    errors: 0,
    failed: 0,
    handedOver: 0,
    retry: 0,
    sent: 0,
    skipped: 0,
  };
  const now = dependencies.now?.() ?? new Date();
  const owed = await dependencies.notices.listOwed(now, limit);
  report.handedOver = owed.length;
  for (const notice of owed) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one message at a time, under the provider's rate limit
      const { outcome } = await deliverBillingNotice(
        dependencies,
        notice.noticeId,
        notice.organizationId
      );
      if (outcome === "sent" || outcome === "failed" || outcome === "skipped") {
        report[outcome] += 1;
      }
    } catch (error: unknown) {
      if (error instanceof BillingNoticeRetryError) {
        report.retry += 1;
        continue;
      }
      report.errors += 1;
      logger.error("billing_notice_handover_failed", {
        ...describeError(error),
        noticeId: opaqueId(notice.noticeId),
        organizationId: opaqueId(notice.organizationId),
      });
    }
  }
  if (report.errors > 0) {
    logger.info("billing_notice_handover_complete", { ...report });
    throw new Error("billing_notice_handover_incomplete");
  }
  return report;
}
