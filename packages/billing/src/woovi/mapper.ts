import {
  type BillingCycleMonths,
  type BillingFact,
  isBillingCycleMonths,
} from "@polaris/domain/billing/facts";
import { paidPeriodEndsAt } from "@polaris/domain/billing/provider-period";
import { Money } from "@polaris/domain/money/money";
import { JsonNumber } from "../json";
import {
  type ProviderBillingEvent,
  ProviderResponseMalformedError,
} from "../provider-port";
import { isWooviGlobalId } from "./ids";

/**
 * Woovi resource → Polaris fact (ADR 0101, emenda Woovi). Pure: no clock (the
 * caller passes its `now`), no network, no logging.
 *
 * Every fact is built from a resource read back from the API with Polaris's own
 * AppID, never from the webhook body: the body is signed by Woovi, but a
 * delivery of another Woovi account is signed too, and only the read back ties
 * the event to this account. The organization is tied by the subscription's
 * `globalID` read back (the `providerRef`), never by an ID of the body. Of a
 * resource only an allowlist of keys is kept (`pickWooviSubscription`,
 * `pickWooviInstallment`): the customer (name, CPF or CNPJ, e-mail, phone,
 * address), the Pix payload (`emv`), the payment link and anything Woovi adds
 * later never leave this file.
 */

/** A subscription (`GET /api/v1/subscriptions/{id}`), with only what the facts need. */
export interface WooviSubscription {
  /**
   * The state of the Pix authorization (`pixRecurring.status`: `CREATED`,
   * `APPROVED`, `REJECTED` by the payer, `CANCELED` by Polaris). Null before
   * the payer acts: the sandbox shows none then.
   */
  authorization: string | null;
  /** 1, 6 or 12; null for a frequency Polaris does not sell. */
  cycleMonths: BillingCycleMonths | null;
  /** The `globalID`: the `providerRef` of every fact. */
  id: string;
  /** `ONLY_RECURRENCY` (journey 2, with the trial) or `PAYMENT_ON_APPROVAL` (journey 3, without). */
  journey: string | null;
  /** `ACTIVE`, `INACTIVE` (cancelled), `COMPLETED` or `EXPIRED`. */
  status: string;
  type: string;
}

/** An installment (`GET /api/v1/installments/{id}`), with only what the facts need. */
export interface WooviInstallment {
  /** The amount in reais, as `money.md` writes it (`"24.90"`), from the integer cents Woovi writes. */
  amount: string;
  /**
   * The day the installment is charged (`dateGenerateCharge`), in São Paulo.
   * Fixed when the installment is created; the period it pays starts there.
   */
  chargeOn: string;
  /** The state of its recurring charge (`cobr.status`), or null when there is none yet. */
  charge: string | null;
  id: string;
  /** `SCHEDULED`, `ACTIVE`, `COMPLETED` (paid), `EXPIRED` or `CANCELED`. */
  status: string;
  subscriptionId: string;
}

const WOOVI_CYCLE_MONTHS: Readonly<Record<string, number>> = {
  ANNUALLY: 12,
  MONTHLY: 1,
  SEMIANNUALLY: 6,
};

/** São Paulo is UTC−3 all year (no daylight saving time since 2019). */
const SAO_PAULO_OFFSET_MS = 3 * 3_600_000;
const providerCodePattern = /^[A-Z_]{1,64}$/;
const isoInstantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const centsPattern = /^\d{1,15}$/;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderResponseMalformedError();
  }
  return value as Record<string, unknown>;
}

function code(value: unknown): string {
  if (typeof value !== "string" || !providerCodePattern.test(value)) {
    throw new ProviderResponseMalformedError();
  }
  return value;
}

function optionalCode(value: unknown): string | null {
  return value === undefined || value === null ? null : code(value);
}

/** The São Paulo day of an instant Woovi writes in UTC (`2026-10-27T12:00:00.000Z`). */
function saoPauloDay(value: unknown): string {
  if (typeof value !== "string" || !isoInstantPattern.test(value)) {
    throw new ProviderResponseMalformedError();
  }
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    throw new ProviderResponseMalformedError();
  }
  return new Date(time - SAO_PAULO_OFFSET_MS).toISOString().slice(0, 10);
}

/** Integer cents as written in the JSON text → `"24.90"`; never through `number`. */
function amountFromCents(value: unknown): string {
  if (!(value instanceof JsonNumber && centsPattern.test(value.source))) {
    throw new ProviderResponseMalformedError();
  }
  return Money.fromMinorUnits(BigInt(value.source)).toString();
}

/** The allowed keys of a subscription. */
export function pickWooviSubscription(raw: unknown): WooviSubscription {
  const source = record(raw);
  if (!isWooviGlobalId("subscription", source.globalID)) {
    throw new ProviderResponseMalformedError();
  }
  const pix =
    source.pixRecurring === undefined || source.pixRecurring === null
      ? {}
      : record(source.pixRecurring);
  const months = WOOVI_CYCLE_MONTHS[code(source.frequency)];
  return {
    authorization: optionalCode(pix.status),
    cycleMonths:
      months !== undefined && isBillingCycleMonths(months) ? months : null,
    id: source.globalID,
    journey: optionalCode(pix.journey),
    status: code(source.status),
    type: code(source.type),
  };
}

/** The allowed keys of an installment. */
export function pickWooviInstallment(raw: unknown): WooviInstallment {
  const source = record(raw);
  if (
    !(
      isWooviGlobalId("installment", source.globalID) &&
      isWooviGlobalId("subscription", source.paymentSubscriptionGlobalID)
    )
  ) {
    throw new ProviderResponseMalformedError();
  }
  const cobr =
    source.cobr === undefined || source.cobr === null
      ? null
      : record(source.cobr);
  return {
    amount: amountFromCents(source.value),
    charge: cobr === null ? null : optionalCode(cobr.status),
    chargeOn: saoPauloDay(source.dateGenerateCharge),
    id: source.globalID,
    status: code(source.status),
    subscriptionId: source.paymentSubscriptionGlobalID,
  };
}

/** What a webhook event needs read back; `ignored` needs nothing and gives no fact. */
export type WooviEventKind = "ignored" | "installment" | "subscription";

const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  "PIX_AUTOMATIC_APPROVED",
  "PIX_AUTOMATIC_REJECTED",
]);
const INSTALLMENT_EVENTS: ReadonlySet<string> = new Set([
  "PIX_AUTOMATIC_COBR_COMPLETED",
  "PIX_AUTOMATIC_COBR_REJECTED",
]);

export function wooviEventKind(eventType: string): WooviEventKind {
  if (SUBSCRIPTION_EVENTS.has(eventType)) {
    return "subscription";
  }
  return INSTALLMENT_EVENTS.has(eventType) ? "installment" : "ignored";
}

/**
 * The event's ID. Woovi gives none, so it is the event's name and the
 * `globalID` of the resource (AC-2, exception registered): only IDs of the
 * provider, never a hash of the body. Each of the four events happens at most
 * once per resource (`COBR_REJECTED` only after the last try), so a redelivery
 * and the reconciliation give the same ID and store once, and two events about
 * the same resource never collide.
 */
export function wooviEventId(eventType: string, resourceId: string): string {
  return `${eventType}:${resourceId}`;
}

/** A subscription Polaris created and sells: Pix Automático of a known cycle. */
function isPolarisSubscription(subscription: WooviSubscription): boolean {
  return (
    subscription.type === "PIX_RECURRING" && subscription.cycleMonths !== null
  );
}

function cycleOf(subscription: WooviSubscription): BillingCycleMonths {
  if (subscription.cycleMonths === null) {
    throw new ProviderResponseMalformedError();
  }
  return subscription.cycleMonths;
}

/** The authorization was taken away: refused or revoked by the payer, or cancelled by Polaris. */
function isCancelled(subscription: WooviSubscription): boolean {
  return (
    subscription.status === "INACTIVE" ||
    subscription.authorization === "REJECTED" ||
    subscription.authorization === "CANCELED"
  );
}

/**
 * One row of a list of installments read line by line: the installment, or
 * only the mark that a row was out of shape and the subscription it names
 * when that much is legible. Nothing else of a row out of shape is kept.
 */
export type WooviInstallmentRow =
  | { ok: WooviInstallment }
  | { malformed: true; subscriptionId: string | null };

/**
 * Reads a list of installments row by row: a row out of shape becomes
 * `{ malformed }` instead of throwing. Only for the question "was it approved",
 * where a row out of shape never proves an approval; a reading that gives
 * money facts (`readState`, the refund) stays strict with `pickWooviInstallment`.
 */
export function pickWooviInstallmentRows(
  raw: readonly unknown[]
): WooviInstallmentRow[] {
  return raw.map((entry) => {
    try {
      return { ok: pickWooviInstallment(entry) };
    } catch (error: unknown) {
      if (!(error instanceof ProviderResponseMalformedError)) {
        throw error;
      }
      const subscriptionId =
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).paymentSubscriptionGlobalID
          : undefined;
      return {
        malformed: true as const,
        subscriptionId: isWooviGlobalId("subscription", subscriptionId)
          ? subscriptionId
          : null,
      };
    }
  });
}

/** Installments already read strictly, as rows. */
export function installmentRows(
  installments: readonly WooviInstallment[]
): WooviInstallmentRow[] {
  return installments.map((installment) => ({ ok: installment }));
}

/**
 * What the reading of a subscription says of the payer's authorization:
 * - `pending`: not approved (yet);
 * - `approved`: approved and in force now;
 * - `made`: approved at some point, its state now not shown;
 * - `revoked`: refused or revoked by the payer, or cancelled.
 */
export type WooviAuthorization = "approved" | "made" | "pending" | "revoked";

/**
 * A row that belongs to this subscription. A row out of shape that names no
 * subscription legibly counts as this one's: on the side that never cancels as
 * an abandoned checkout something that may be approved.
 */
function isRowOf(
  subscription: WooviSubscription,
  row: WooviInstallmentRow
): boolean {
  return "ok" in row
    ? row.ok.subscriptionId === subscription.id
    : row.subscriptionId === null || row.subscriptionId === subscription.id;
}

/**
 * The installment Woovi creates once the payer approves the authorization:
 * it and its recurring charge are `ACTIVE` (sandbox). An installment that is
 * only scheduled, paid, expired or cancelled proves no approval, and a row out
 * of shape never does.
 */
function isLiveRowOf(
  subscription: WooviSubscription,
  row: WooviInstallmentRow
): boolean {
  return (
    "ok" in row &&
    row.ok.subscriptionId === subscription.id &&
    row.ok.status === "ACTIVE" &&
    row.ok.charge === "ACTIVE"
  );
}

/**
 * The single rule of the authorization (ADR 0101, emenda da regra única). The
 * first that holds:
 * 1. `INACTIVE`, or `pixRecurring.status` `REJECTED`/`CANCELED`: revoked.
 * 2. A `pixRecurring.status` the read back shows (the documented shape) decides
 *    alone, and the installments do not count: the documentation creates
 *    `SCHEDULED` installments with the subscription, before any approval.
 * 3. None (the sandbox shape): a live installment of this subscription is
 *    approved; any other row of it (paid, scheduled, expired, cancelled, out
 *    of shape) is made; none is pending.
 */
export function wooviAuthorizationOf(
  subscription: WooviSubscription,
  rows: readonly WooviInstallmentRow[]
): WooviAuthorization {
  if (isCancelled(subscription)) {
    return "revoked";
  }
  if (subscription.authorization !== null) {
    return subscription.authorization === "APPROVED" ? "approved" : "pending";
  }
  if (rows.some((row) => isLiveRowOf(subscription, row))) {
    return "approved";
  }
  return rows.some((row) => isRowOf(subscription, row)) ? "made" : "pending";
}

/**
 * Whether the checkout became a subscription (the payer approved it at some
 * point), so it is no longer a checkout to give up. A revoked one counts when
 * its status says it was approved, never when it says it was only created, and
 * otherwise by an installment of its own.
 */
export function isWooviSubscriptionMade(
  subscription: WooviSubscription,
  rows: readonly WooviInstallmentRow[]
): boolean {
  const authorization = wooviAuthorizationOf(subscription, rows);
  if (authorization !== "revoked") {
    return authorization !== "pending";
  }
  if (subscription.authorization === "APPROVED") {
    return true;
  }
  return (
    subscription.authorization !== "CREATED" &&
    rows.some((row) => isRowOf(subscription, row))
  );
}

/**
 * The read back shows no `pixRecurring.status` (sandbox): the installments are
 * read to answer the rule. Never for one already `INACTIVE` (revoked, nothing
 * to read) or with a status (it decides alone).
 */
export function needsInstallmentsForAuthorization(
  subscription: WooviSubscription
): boolean {
  return (
    subscription.authorization === null && subscription.status !== "INACTIVE"
  );
}

/**
 * The approval was proven by a live installment of this very subscription,
 * because the read back shows no `pixRecurring.status` (sandbox).
 */
export function isApprovalInferredFromInstallments(
  subscription: WooviSubscription,
  rows: readonly WooviInstallmentRow[]
): boolean {
  return (
    subscription.authorization === null &&
    wooviAuthorizationOf(subscription, rows) === "approved"
  );
}

/** The payer approved the authorization of a subscription that starts later: the trial may start. */
function isTrialMethodReady(
  subscription: WooviSubscription,
  rows: readonly WooviInstallmentRow[]
): boolean {
  return (
    subscription.status === "ACTIVE" &&
    wooviAuthorizationOf(subscription, rows) === "approved" &&
    subscription.journey === "ONLY_RECURRENCY"
  );
}

/**
 * The shape of the authorization the provider gave, for the log
 * `billing_woovi_authorization_form`: only codes and counts. Whether the read
 * back shows `pixRecurring.status`, the installments of this subscription by
 * status, the rows out of shape and the verdict of the rule; never an ID or a
 * person's data.
 */
export interface WooviAuthorizationForm {
  authorizationShown: boolean;
  installmentsByStatus: Record<string, number>;
  malformedInstallments: number;
  verdict: WooviAuthorization;
}

export function wooviAuthorizationForm(
  subscription: WooviSubscription,
  rows: readonly WooviInstallmentRow[]
): WooviAuthorizationForm {
  const installmentsByStatus: Record<string, number> = {};
  let malformedInstallments = 0;
  for (const row of rows) {
    if (!isRowOf(subscription, row)) {
      continue;
    }
    if ("ok" in row) {
      installmentsByStatus[row.ok.status] =
        (installmentsByStatus[row.ok.status] ?? 0) + 1;
    } else {
      malformedInstallments += 1;
    }
  }
  return {
    authorizationShown: subscription.authorization !== null,
    installmentsByStatus,
    malformedInstallments,
    verdict: wooviAuthorizationOf(subscription, rows),
  };
}

function isPaid(installment: WooviInstallment): boolean {
  return installment.status === "COMPLETED";
}

/**
 * A charge that failed for good: never paid, and its recurring charge was
 * rejected after the last try, or the installment expired unpaid. A cancelled
 * installment is not a failure: cancelling the subscription cancels the ones
 * still scheduled, and a failure would give the grace days to whoever cancelled.
 */
function hasFailed(installment: WooviInstallment): boolean {
  return (
    !isPaid(installment) &&
    installment.status !== "CANCELED" &&
    (installment.charge === "REJECTED" || installment.status === "EXPIRED")
  );
}

function event(
  fact: BillingFact,
  providerEventId: string,
  subscription: WooviSubscription
): ProviderBillingEvent {
  // the subscription is the reference itself: stored on the record by the first
  // fact that matches, so the commands treat it as a subscription made (ADR 0101)
  return {
    fact,
    providerEventId,
    providerRef: subscription.id,
    providerSubscriptionId: subscription.id,
  };
}

/**
 * The period the installment pays: its charge day plus the subscription's cycle (AC-5). The same instant its
 * `charge_succeeded` fact carries, so the owner's refund tells the first charge by it (`assertFirstCharge`).
 */
export function installmentPeriodEndsAt(
  installment: WooviInstallment,
  subscription: WooviSubscription
): Date {
  return paidPeriodEndsAt(installment.chargeOn, cycleOf(subscription));
}

function chargeSucceeded(
  installment: WooviInstallment,
  subscription: WooviSubscription,
  occurredAt: Date
): BillingFact {
  const cycleMonths = cycleOf(subscription);
  const amount = Money.from(installment.amount).minorUnits > 0n;
  return {
    ...(amount
      ? { amount: { currency: "BRL" as const, value: installment.amount } }
      : {}),
    cycleMonths,
    occurredAt,
    periodEndsAt: installmentPeriodEndsAt(installment, subscription),
    type: "charge_succeeded",
  };
}

/** The fact of a subscription event, if the subscription read back shows it. */
export function mapWooviSubscriptionEvent(input: {
  eventType: string;
  installments?: readonly WooviInstallmentRow[];
  occurredAt: Date;
  subscription: WooviSubscription;
}): ProviderBillingEvent[] {
  const { eventType, installments = [], occurredAt, subscription } = input;
  if (!isPolarisSubscription(subscription)) {
    return [];
  }
  const id = wooviEventId(eventType, subscription.id);
  if (eventType === "PIX_AUTOMATIC_APPROVED") {
    // journey 3 (no trial) is paid on approval: its fact is the charge (`COBR_COMPLETED`)
    return isTrialMethodReady(subscription, installments)
      ? [
          event(
            {
              cycleMonths: cycleOf(subscription),
              occurredAt,
              type: "trial_method_ready",
            },
            id,
            subscription
          ),
        ]
      : [];
  }
  if (eventType === "PIX_AUTOMATIC_REJECTED" && isCancelled(subscription)) {
    return [
      event({ occurredAt, type: "subscription_cancelled" }, id, subscription),
    ];
  }
  return [];
}

/** The fact of an installment event, if the installment read back shows it. */
export function mapWooviInstallmentEvent(input: {
  eventType: string;
  installment: WooviInstallment;
  occurredAt: Date;
  subscription: WooviSubscription;
}): ProviderBillingEvent[] {
  const { eventType, installment, occurredAt, subscription } = input;
  if (
    !isPolarisSubscription(subscription) ||
    installment.subscriptionId !== subscription.id
  ) {
    return [];
  }
  const id = wooviEventId(eventType, installment.id);
  if (eventType === "PIX_AUTOMATIC_COBR_COMPLETED" && isPaid(installment)) {
    return [
      event(
        chargeSucceeded(installment, subscription, occurredAt),
        id,
        subscription
      ),
    ];
  }
  if (eventType === "PIX_AUTOMATIC_COBR_REJECTED" && hasFailed(installment)) {
    return [event({ occurredAt, type: "charge_failed" }, id, subscription)];
  }
  return [];
}

/** The codes of a resource that should have given a fact and did not; only codes, never a person's data. */
export interface WooviStateNotShown {
  /**
   * `pixRecurring.status` as read back; `"absent"` on a rejection whose read
   * back shows none (a revocation the sandbox shape cannot show).
   */
  authorization?: string;
  charge?: string;
  /** `"unread"`: the list of installments went past its ceiling or its time, so the approval was not read. */
  installmentList?: "unread";
  installmentStatus?: string;
  journey?: string;
  /** How many rows of the list were out of shape: only the count, never a row. */
  malformedInstallments?: number;
  subscriptionStatus: string;
}

function authorizationCode(
  eventType: string,
  subscription: WooviSubscription
): { authorization?: string } {
  if (subscription.authorization !== null) {
    return { authorization: subscription.authorization };
  }
  // a rejection of a subscription still active whose read back shows no status:
  // a revocation the sandbox shape does not show, told apart for its alert
  return eventType === "PIX_AUTOMATIC_REJECTED"
    ? { authorization: "absent" }
    : {};
}

/**
 * Whether an event of Polaris's subscription that mapped to no fact should
 * have: the resource read back does not show the state its name announces (a
 * paid installment, a rejected charge, a cancelled authorization). Consistent
 * reading may only be late, so the caller logs it and answers 200, and the
 * reconciliation reads the state; a forged body is never refused in a loop.
 * Not a loss, so null: a subscription that is not Polaris's, a journey 3
 * approval (its fact is `COBR_COMPLETED`) and a cancelled installment's
 * rejection (cancelling is not a failure).
 */
export function wooviStateNotShown(input: {
  eventType: string;
  installment?: WooviInstallment;
  subscription: WooviSubscription;
}): WooviStateNotShown | null {
  const { eventType, installment, subscription } = input;
  if (!isPolarisSubscription(subscription)) {
    return null;
  }
  if (
    eventType === "PIX_AUTOMATIC_APPROVED" &&
    subscription.journey === "PAYMENT_ON_APPROVAL"
  ) {
    return null;
  }
  if (
    eventType === "PIX_AUTOMATIC_COBR_REJECTED" &&
    installment?.status === "CANCELED"
  ) {
    return null;
  }
  return {
    ...authorizationCode(eventType, subscription),
    ...(installment?.charge ? { charge: installment.charge } : {}),
    ...(installment === undefined
      ? {}
      : { installmentStatus: installment.status }),
    ...(subscription.journey === null ? {} : { journey: subscription.journey }),
    subscriptionStatus: subscription.status,
  };
}

/**
 * The facts the provider's state implies, for the reconciliation (Q8): the same
 * reading as the webhook's, with the same IDs (`<event>:<globalID>`), so a fact
 * that came by webhook and by the reconciliation is stored once (AC-2). Only
 * installments whose period has not ended yet are read: an older one can no
 * longer change access.
 */
export function reconcileWooviSubscription(input: {
  installments: readonly WooviInstallment[];
  now: Date;
  subscription: WooviSubscription;
}): ProviderBillingEvent[] {
  const { now, subscription } = input;
  if (!isPolarisSubscription(subscription)) {
    return [];
  }
  const events: ProviderBillingEvent[] = [];
  const rows = installmentRows(input.installments);
  if (isTrialMethodReady(subscription, rows)) {
    events.push(
      ...mapWooviSubscriptionEvent({
        eventType: "PIX_AUTOMATIC_APPROVED",
        installments: rows,
        occurredAt: now,
        subscription,
      })
    );
  }
  const own = [...input.installments]
    .filter((installment) => installment.subscriptionId === subscription.id)
    .sort(
      (left, right) =>
        left.chargeOn.localeCompare(right.chargeOn) ||
        left.id.localeCompare(right.id)
    );
  for (const installment of own) {
    const cycleMonths = cycleOf(subscription);
    if (
      paidPeriodEndsAt(installment.chargeOn, cycleMonths).getTime() <=
      now.getTime()
    ) {
      continue;
    }
    for (const eventType of [
      "PIX_AUTOMATIC_COBR_COMPLETED",
      "PIX_AUTOMATIC_COBR_REJECTED",
    ]) {
      events.push(
        ...mapWooviInstallmentEvent({
          eventType,
          installment,
          occurredAt: now,
          subscription,
        })
      );
    }
  }
  if (isCancelled(subscription)) {
    events.push(
      ...mapWooviSubscriptionEvent({
        eventType: "PIX_AUTOMATIC_REJECTED",
        occurredAt: now,
        subscription,
      })
    );
  }
  return events;
}

/** São Paulo's calendar day at `now`. */
function saoPauloToday(now: Date): string {
  return new Date(now.getTime() - SAO_PAULO_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The installment that paid the period in force at `now`: the latest paid one
 * of this subscription charged by today, whose period has not ended. Null when
 * there is none (nothing to refund). Never an earlier one (ADR 0101, AC-46).
 */
export function refundableInstallment(
  installments: readonly WooviInstallment[],
  subscription: WooviSubscription,
  now: Date
): WooviInstallment | null {
  if (!isPolarisSubscription(subscription)) {
    return null;
  }
  const today = saoPauloToday(now);
  const latest = installments
    .filter(
      (installment) =>
        installment.subscriptionId === subscription.id &&
        installment.chargeOn <= today
    )
    .sort(
      (left, right) =>
        left.chargeOn.localeCompare(right.chargeOn) ||
        left.id.localeCompare(right.id)
    )
    .at(-1);
  if (
    !(latest && isPaid(latest)) ||
    paidPeriodEndsAt(latest.chargeOn, cycleOf(subscription)).getTime() <=
      now.getTime()
  ) {
    return null;
  }
  return latest;
}

/**
 * The `correlationID` of the refund Polaris asks for one installment: the subscription's and the installment's `globalID`. The same refund
 * asked twice carries the same one, and the fact the command writes uses it as
 * its event ID.
 */
export function wooviRefundCorrelationId(
  subscription: WooviSubscription,
  installment: WooviInstallment
): string {
  return `refund:${subscription.id}:${installment.id}`;
}

/** The fact of a refund Polaris asked for: the period the installment paid, and its amount. */
export function wooviRefundEvent(input: {
  installment: WooviInstallment;
  occurredAt: Date;
  subscription: WooviSubscription;
}): ProviderBillingEvent {
  const { installment, occurredAt, subscription } = input;
  const paid = chargeSucceeded(installment, subscription, occurredAt);
  if (paid.type !== "charge_succeeded") {
    throw new ProviderResponseMalformedError();
  }
  return event(
    {
      ...(paid.amount ? { amount: paid.amount } : {}),
      occurredAt,
      periodEndsAt: paid.periodEndsAt,
      type: "charge_refunded",
    },
    wooviRefundCorrelationId(subscription, installment),
    subscription
  );
}

const endToEndIdPattern = /^[A-Za-z\d]{32}$/;

/**
 * The Pix `endToEndId` of a paid installment, the key of its refund. Woovi's
 * documentation puts it in the recurring charge (`cobr.endToEndId`); it is not
 * on the allowlist of the facts and is read only for the refund. Not proven
 * on a real installment yet (S3.2): another shape throws.
 */
export function pickWooviEndToEndId(raw: unknown): string {
  const source = record(raw);
  const cobr =
    source.cobr === undefined || source.cobr === null
      ? {}
      : record(source.cobr);
  const value = cobr.endToEndId ?? source.endToEndId;
  if (typeof value !== "string" || !endToEndIdPattern.test(value)) {
    throw new ProviderResponseMalformedError();
  }
  return value;
}
