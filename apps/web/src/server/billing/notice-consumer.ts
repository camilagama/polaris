import type {
  BillingCycleMonths,
  BillingFact,
  BillingRecord,
} from "@polaris/domain/billing/facts";
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
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { localDate } from "@polaris/domain/organization/closure-deadlines";
import { logger, opaqueId } from "@polaris/observability/logger";
import {
  type ClosureNoticeSender,
  createResendClosureNoticeSender,
} from "../privacy/closure-notice-email";
import { PermanentHandlerError } from "../queue/consumer";
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

/** Notices the handover sends in one hourly run, at most (one at a time, under the provider's rate limit). */
const BILLING_NOTICE_HANDOVER_BATCH = 20;

/** A notice as the billing role reads it again, with the record of its store and what its rule needs. */
export interface BillingNoticeDelivery {
  /** The cycle of the current link: the record's while Pro, else the one the method was set up with. */
  cycleMonths: BillingCycleMonths | null;
  dedupeKey: string;
  /** Not to go out before this instant (E4 and E7 wait for the fact that would suppress them). */
  dueAt: Date;
  /** The ledger row the notice names (E4, E7, E-R), read again; null for the others. */
  event: { fact: BillingFact; id: string; providerRef: string | null } | null;
  firstChargeAmount: string | null;
  firstChargeAt: Date | null;
  firstChargeEventId: string | null;
  firstChargeOn: string | null;
  kind: BillingNoticeKind;
  noticeId: string;
  organizationId: string;
  /** When the store went over the Free limit (the 7 days to choose the variants count from it). */
  overLimitSince: Date | null;
  /** A charge was applied to the store after the notice was recorded. */
  paidSinceNotice: boolean;
  priceAmount: string | null;
  provider: string | null;
  providerRef: string | null;
  record: BillingRecord;
  recordedAt: Date;
  refundRequestedAt: Date | null;
  /** When the other E-C2 of the same paid period went out (or, for a d0 still owed, when it was recorded). */
  renewalFailedSentAt: readonly Date[];
  /** When the E-A of the current link went out. */
  trialStartedSentAt: Date | null;
}

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

/** What the e-mail says of the store the notice is of, read for a notice still owed. */
export interface BillingNoticeStoreFacts {
  /** The store is in closure, closed or waiting for the purge (EM-7). */
  closed: boolean;
  name: string;
  /** The owner the notice is for is still an active owner (E1). */
  ownerActive: boolean;
  timeZone: string;
  /** The Free limit of active variants (the live catalog) and how many the store has active. */
  variantLimit: number;
  variants: number;
}

export interface BillingNoticeStores {
  /** Null when there is no such store any more (purged): the notice has no one to go to. */
  storeOf: (
    noticeId: string,
    organizationId: string
  ) => Promise<BillingNoticeStoreFacts | null>;
}

export type BillingNoticeRecipient =
  | { email: string; verified: true }
  | { verified: false };

export interface BillingNoticeRecipients {
  /** Null when the notice is not owed any more or has nobody to go to (the store purged, the person gone). */
  recipient: (
    noticeId: string,
    organizationId: string
  ) => Promise<BillingNoticeRecipient | null>;
}

/** Why the consumer itself did not send: nobody to send to, or an address nobody proved. */
export type BillingNoticeDeliverySkip = "email_not_verified" | "no_recipient";

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
  if (!(apiKey && from && supportEmail && appOrigin)) {
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
): Promise<BillingNoticeOutcome> {
  const now = dependencies.now?.() ?? new Date();
  const fields = {
    noticeId: opaqueId(noticeId),
    organizationId: opaqueId(organizationId),
  };
  const delivery = await dependencies.notices.claim(noticeId, organizationId);
  if (!delivery) {
    logger.info("billing_notice_not_due", { ...fields, outcome: "skipped" });
    return "not_due";
  }
  const { kind } = delivery;
  if (delivery.dueAt.getTime() > now.getTime()) {
    logger.info("billing_notice_not_yet_due", { ...fields, kind });
    return "not_yet_due";
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
    return await skip(checked.reason);
  }
  const { config, store } = checked;
  const email = billingNoticeEmailOf(delivery, store, config.appOrigin);
  if (!email) {
    return await skip("state_changed");
  }
  const recipient = await dependencies.recipients.recipient(
    noticeId,
    organizationId
  );
  if (!recipient) {
    return await skip("no_recipient");
  }
  if (!recipient.verified) {
    return await skip("email_not_verified");
  }
  return await sendBillingNotice(dependencies, {
    config,
    email,
    fields,
    kind,
    noticeId,
    organizationId,
    to: recipient.email,
  });
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
  return await deliverBillingNotice(
    dependencies,
    noticeId,
    envelope.organizationId
  );
}

export interface BillingNoticeHandoverReport {
  failed: number;
  handedOver: number;
  retry: number;
  sent: number;
  skipped: number;
}

/**
 * The hourly handover of the notices left owed and now due: a receipt or a cancellation that waited, a delivery the
 * queue gave up on. One at a time; the failure of one never stops the others.
 */
export async function handOverOwedBillingNotices(
  dependencies: BillingNoticeDependencies,
  limit = BILLING_NOTICE_HANDOVER_BATCH
): Promise<BillingNoticeHandoverReport> {
  const report: BillingNoticeHandoverReport = {
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
      const outcome = await deliverBillingNotice(
        dependencies,
        notice.noticeId,
        notice.organizationId
      );
      if (outcome === "sent" || outcome === "failed" || outcome === "skipped") {
        report[outcome] += 1;
      }
    } catch (error: unknown) {
      if (!(error instanceof BillingNoticeRetryError)) {
        throw error;
      }
      report.retry += 1;
    }
  }
  return report;
}
