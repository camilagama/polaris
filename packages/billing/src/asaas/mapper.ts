import {
  type BillingCycleMonths,
  type BillingFact,
  isBillingCycleMonths,
} from "@polaris/domain/billing/facts";
import { paidPeriodEndsAt } from "@polaris/domain/billing/provider-period";
import { isValidCalendarDate } from "@polaris/domain/inventory/calendar-date";
import { Money } from "@polaris/domain/money/money";
import { moneyFromJsonNumber } from "../json";
import {
  type ProviderBillingEvent,
  ProviderResponseMalformedError,
} from "../provider-port";
import { isAsaasId, normalizeCheckoutId } from "./ids";

/**
 * Asaas resource → Polaris fact (ADR 0101). Pure: no clock (the reconciliation
 * passes its `now`), no network, no logging.
 *
 * Every fact is built from a resource read back from the API with Polaris's own
 * key, never from the webhook body: the body only says which event happened and
 * which resource to read. Of a resource only an allowlist of keys is kept
 * (`pickAsaasPayment`, `pickAsaasSubscription`): the card (`creditCard`, with
 * its reusable `creditCardToken`), the customer, the receipts and invoice URLs
 * and anything Asaas adds later never leave this file.
 */

/** A charge, with only what the facts need. */
export interface AsaasPayment {
  /** The amount, as `money.md` writes it, read from the JSON text (never a float). */
  amount: string;
  /**
   * The ID of the checkout the charge came from, or null (a charge made by the API, or a
   * later one that does not carry it). Read only to check it against the subscription's.
   */
  checkoutSession: string | null;
  /** The day the charge was confirmed (`AAAA-MM-DD`), or null when the resource shows none. */
  confirmedOn: string | null;
  /** The day the charge was created (`AAAA-MM-DD`). */
  createdOn: string;
  deleted: boolean;
  id: string;
  /**
   * The due date the charge was created with (`AAAA-MM-DD`). `dueDate` is not
   * used: Asaas rewrites it when a charge becomes overdue or is edited.
   */
  originalDueDate: string;
  status: string;
  subscriptionId: string | null;
}

/** A subscription, with only what the facts need. */
export interface AsaasSubscription {
  /**
   * The ID of the hosted checkout that created the subscription: the
   * `providerRef` of every fact (ADR 0101, S1.3). The `externalReference` sent
   * with the checkout does not reach the subscription, so nothing reads it.
   * Null when the resource shows none: the fact cannot be tied to an organization.
   */
  checkoutSession: string | null;
  /** 1, 6 or 12; null for a cycle Polaris does not sell. */
  cycleMonths: BillingCycleMonths | null;
  deleted: boolean;
  id: string;
  status: string;
}

const ASAAS_CYCLE_MONTHS: Readonly<Record<string, number>> = {
  MONTHLY: 1,
  SEMIANNUALLY: 6,
  YEARLY: 12,
};

/** Asaas's name of a Polaris cycle. */
export function asaasCycle(cycleMonths: BillingCycleMonths): string {
  const [name] = Object.entries(ASAAS_CYCLE_MONTHS).find(
    ([, months]) => months === cycleMonths
  ) ?? [""];
  return name;
}

/** São Paulo is UTC−3 all year (no daylight saving time since 2019). */
const SAO_PAULO_OFFSET_MS = 3 * 3_600_000;

/**
 * When a confirmation happened. The day comes from the charge read back
 * (`confirmedDate`), which a forged body cannot move: the time of the webhook
 * is kept when it falls on that day (it orders two facts of the same day) and
 * is held inside that day otherwise (a webhook just after midnight of a charge
 * confirmed just before it stays on the day's last instant, not its first).
 * Never later than `now`.
 */
export function confirmationTime(
  claimed: Date,
  confirmedOn: string | null,
  now: Date
): Date {
  const latest = Math.min(claimed.getTime(), now.getTime());
  if (confirmedOn === null) {
    return new Date(latest);
  }
  const startOfDay = new Date(`${confirmedOn}T00:00:00.000-03:00`).getTime();
  const endOfDay = startOfDay + 24 * 3_600_000 - 1;
  return new Date(
    Math.min(Math.max(latest, startOfDay), endOfDay, now.getTime())
  );
}

/** Statuses of a charge that was paid at some point (a later refund or chargeback keeps it so). */
const PAID_STATUSES: ReadonlySet<string> = new Set([
  "AWAITING_CHARGEBACK_REVERSAL",
  "CHARGEBACK_DISPUTE",
  "CHARGEBACK_REQUESTED",
  "CONFIRMED",
  "RECEIVED",
  "REFUND_IN_PROGRESS",
  "REFUND_REQUESTED",
  "REFUNDED",
]);
const CHARGEBACK_STATUSES: ReadonlySet<string> = new Set([
  "AWAITING_CHARGEBACK_REVERSAL",
  "CHARGEBACK_DISPUTE",
  "CHARGEBACK_REQUESTED",
]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderResponseMalformedError();
  }
  return value as Record<string, unknown>;
}

const providerCodePattern = /^[A-Z_]{1,64}$/;
const uuidPattern =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function text(value: unknown, pattern = providerCodePattern): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProviderResponseMalformedError();
  }
  return value;
}

function calendarDate(value: unknown): string {
  if (typeof value !== "string" || !isValidCalendarDate(value)) {
    throw new ProviderResponseMalformedError();
  }
  return value;
}

/** A calendar date the resource may or may not show; anything else counts as none, never as an error. */
function optionalCalendarDate(value: unknown): string | null {
  return typeof value === "string" && isValidCalendarDate(value) ? value : null;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new ProviderResponseMalformedError();
  }
  return value;
}

/** The allowed keys of a charge (`GET /v3/payments/{id}`). */
export function pickAsaasPayment(raw: unknown): AsaasPayment {
  const source = record(raw);
  const amount = moneyFromJsonNumber(source.value);
  if (!isAsaasId("pay", source.id) || amount === null) {
    throw new ProviderResponseMalformedError();
  }
  const subscription = source.subscription ?? null;
  if (subscription !== null && !isAsaasId("sub", subscription)) {
    throw new ProviderResponseMalformedError();
  }
  return {
    amount,
    checkoutSession: normalizeCheckoutId(source.checkoutSession),
    confirmedOn: optionalCalendarDate(source.confirmedDate),
    createdOn: calendarDate(source.dateCreated),
    deleted: flag(source.deleted),
    id: source.id as string,
    originalDueDate: calendarDate(source.originalDueDate),
    status: text(source.status),
    subscriptionId: subscription as string | null,
  };
}

/** The allowed keys of a subscription (`GET /v3/subscriptions/{id}`). */
export function pickAsaasSubscription(raw: unknown): AsaasSubscription {
  const source = record(raw);
  if (!isAsaasId("sub", source.id)) {
    throw new ProviderResponseMalformedError();
  }
  const months = ASAAS_CYCLE_MONTHS[text(source.cycle)];
  return {
    checkoutSession: normalizeCheckoutId(source.checkoutSession),
    cycleMonths:
      months !== undefined && isBillingCycleMonths(months) ? months : null,
    deleted: flag(source.deleted),
    id: source.id as string,
    status: text(source.status),
  };
}

/**
 * The subscriptions a checkout created, read back: only those whose own
 * `checkoutSession` is the checkout's (the list is never trusted to filter).
 */
export function subscriptionsOfCheckout(
  raw: readonly unknown[],
  checkoutId: string
): AsaasSubscription[] {
  const wanted = normalizeCheckoutId(checkoutId);
  return raw
    .map(pickAsaasSubscription)
    .filter((entry) => wanted !== null && entry.checkoutSession === wanted);
}

/** The allowed keys of a hosted checkout (`POST /v3/checkouts`): its ID and its link, nothing else. */
export function pickAsaasCheckout(raw: unknown): { id: string; link: string } {
  const source = record(raw);
  const { id, link } = source;
  if (
    typeof id !== "string" ||
    !uuidPattern.test(id) ||
    typeof link !== "string"
  ) {
    throw new ProviderResponseMalformedError();
  }
  const url = URL.parse(link);
  // the payer is sent only to an Asaas page over HTTPS
  const onAsaas =
    url?.protocol === "https:" &&
    (url.hostname === "asaas.com" || url.hostname.endsWith(".asaas.com"));
  if (!(url && onAsaas)) {
    throw new ProviderResponseMalformedError();
  }
  return { id: id.toLowerCase(), link: url.href };
}

/** What the webhook events become; any other event is acknowledged with no fact. */
const PAYMENT_EVENTS: Readonly<
  Record<
    string,
    | "charge_disputed"
    | "charge_failed"
    | "charge_refunded"
    | "charge_succeeded"
    | "dispute_reversed"
  >
> = {
  PAYMENT_AWAITING_CHARGEBACK_REVERSAL: "dispute_reversed",
  PAYMENT_CHARGEBACK_REQUESTED: "charge_disputed",
  PAYMENT_CONFIRMED: "charge_succeeded",
  PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: "charge_failed",
  PAYMENT_OVERDUE: "charge_failed",
  PAYMENT_RECEIVED: "charge_succeeded",
  PAYMENT_REFUNDED: "charge_refunded",
  PAYMENT_REPROVED_BY_RISK_ANALYSIS: "charge_failed",
};
const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  "SUBSCRIPTION_DELETED",
  "SUBSCRIPTION_INACTIVATED",
]);

export type AsaasEventKind =
  | "checkout"
  | "ignored"
  | "payment"
  | "subscription";

/** Which resource an event needs read back; `ignored` needs none and gives no fact. */
export function asaasEventKind(eventType: string): AsaasEventKind {
  if (Object.hasOwn(PAYMENT_EVENTS, eventType)) {
    return "payment";
  }
  if (SUBSCRIPTION_EVENTS.has(eventType)) {
    return "subscription";
  }
  return eventType === "CHECKOUT_PAID" ? "checkout" : "ignored";
}

function cycleOf(subscription: AsaasSubscription): BillingCycleMonths {
  if (subscription.cycleMonths === null) {
    // a subscription Polaris created always has one of its cycles
    throw new ProviderResponseMalformedError();
  }
  return subscription.cycleMonths;
}

/** The period the charge paid for: its original due date plus the subscription's cycle (AC-5). */
function chargePeriodEndsAt(
  payment: AsaasPayment,
  subscription: AsaasSubscription
): Date {
  return paidPeriodEndsAt(payment.originalDueDate, cycleOf(subscription));
}

function event(
  fact: BillingFact,
  providerEventId: string,
  subscription: AsaasSubscription
): ProviderBillingEvent {
  return {
    fact,
    providerEventId,
    // every caller has checked that the subscription carries its checkout ID
    providerRef: subscription.checkoutSession as string,
    providerSubscriptionId: subscription.id,
  };
}

/** A charge that is part of this checkout's subscription; anything else gives no fact. */
function ownsCharge(
  payment: AsaasPayment,
  subscription: AsaasSubscription
): boolean {
  return (
    subscription.checkoutSession !== null &&
    payment.subscriptionId === subscription.id &&
    !payment.deleted &&
    // a charge that names another checkout than its subscription's is not trusted
    (payment.checkoutSession === null ||
      payment.checkoutSession === subscription.checkoutSession)
  );
}

/** An amount above zero (`pickAsaasPayment` already normalized it as `money.md` writes it). */
function isPositiveAmount(amount: string): boolean {
  return Money.from(amount).minorUnits > 0n;
}

function chargeFact(
  type:
    | "charge_disputed"
    | "charge_failed"
    | "charge_refunded"
    | "charge_succeeded"
    | "dispute_reversed",
  payment: AsaasPayment,
  subscription: AsaasSubscription,
  occurredAt: Date
): BillingFact {
  if (type === "charge_failed") {
    return { occurredAt, type };
  }
  const periodEndsAt = chargePeriodEndsAt(payment, subscription);
  // the amount the charge moved, read from the JSON text (the fiscal record; Asaas
  // charges in BRL). A charge of no value keeps its fact without one: the fact is
  // what moves access, and the amount is optional
  const amount = isPositiveAmount(payment.amount)
    ? { amount: { currency: "BRL" as const, value: payment.amount } }
    : {};
  return type === "charge_succeeded"
    ? {
        ...amount,
        cycleMonths: cycleOf(subscription),
        occurredAt,
        periodEndsAt,
        type,
      }
    : { ...amount, occurredAt, periodEndsAt, type };
}

/**
 * Whether the charge read back shows what the event claims. A confirmation
 * needs a charge that was paid at some point (a late one keeps its fact even if
 * the charge was refunded since: money moved, and the order of facts is the
 * domain's to judge). A refund, a chargeback and its reversal need the charge
 * to be in that state now, and a failure needs a charge that was never paid: a
 * body with the right token cannot take access away from a healthy charge. An
 * event whose charge has moved on since gives no fact; the reconciliation
 * reads the state that holds.
 */
function chargeShows(type: string, status: string): boolean {
  switch (type) {
    case "charge_succeeded":
      return PAID_STATUSES.has(status);
    case "charge_refunded":
      return status === "REFUNDED";
    case "charge_disputed":
      return CHARGEBACK_STATUSES.has(status);
    case "dispute_reversed":
      return status === "AWAITING_CHARGEBACK_REVERSAL";
    default:
      return !PAID_STATUSES.has(status);
  }
}

/** The fact of a charge event: what the event says, if the charge read back shows it. */
export function mapAsaasPaymentEvent(input: {
  eventType: string;
  now: Date;
  occurredAt: Date;
  payment: AsaasPayment;
  providerEventId: string;
  subscription: AsaasSubscription;
}): ProviderBillingEvent[] {
  const { payment, subscription } = input;
  const type = PAYMENT_EVENTS[input.eventType];
  if (!(type && ownsCharge(payment, subscription))) {
    return [];
  }
  if (!chargeShows(type, payment.status)) {
    return [];
  }
  return [
    event(
      chargeFact(
        type,
        payment,
        subscription,
        type === "charge_succeeded"
          ? confirmationTime(input.occurredAt, payment.confirmedOn, input.now)
          : input.occurredAt
      ),
      input.providerEventId,
      subscription
    ),
  ];
}

/** The fact of a subscription event: cancelled only when the subscription read back is. */
export function mapAsaasSubscriptionEvent(input: {
  occurredAt: Date;
  providerEventId: string;
  subscription: AsaasSubscription;
}): ProviderBillingEvent[] {
  const { subscription } = input;
  if (
    subscription.checkoutSession === null ||
    !(subscription.deleted || subscription.status !== "ACTIVE")
  ) {
    return [];
  }
  return [
    event(
      { occurredAt: input.occurredAt, type: "subscription_cancelled" },
      input.providerEventId,
      subscription
    ),
  ];
}

/** Charges in the order they fall due. */
function byDueDate(payments: readonly AsaasPayment[]): AsaasPayment[] {
  return [...payments].sort(
    (left, right) =>
      left.originalDueDate.localeCompare(right.originalDueDate) ||
      left.id.localeCompare(right.id)
  );
}

/**
 * Whether the subscription began with a trial: its first charge was created to
 * fall due later (the end of the trial) rather than on the day. Read from the
 * charge's own dates, which never change, so a late event reads the same.
 */
function startedWithTrial(payments: readonly AsaasPayment[]): boolean {
  const [first] = byDueDate(payments);
  return first !== undefined && first.originalDueDate > first.createdOn;
}

/** Whether the subscription is still live at the provider. */
function isLive(subscription: AsaasSubscription): boolean {
  return !subscription.deleted && subscription.status === "ACTIVE";
}

/**
 * The fact of a finished checkout (`CHECKOUT_PAID`): the card was accepted, so
 * the renewal method is ready and the trial may start (AC-15). Without a trial
 * the first charge is the fact (`PAYMENT_CONFIRMED`), and this gives none.
 */
export function mapAsaasCheckoutPaid(input: {
  occurredAt: Date;
  payments: readonly AsaasPayment[];
  providerEventId: string;
  subscription: AsaasSubscription;
}): ProviderBillingEvent[] {
  const { subscription } = input;
  const own = input.payments.filter((payment) =>
    ownsCharge(payment, subscription)
  );
  if (subscription.checkoutSession === null || !startedWithTrial(own)) {
    return [];
  }
  return [
    event(
      {
        cycleMonths: cycleOf(subscription),
        occurredAt: input.occurredAt,
        type: "trial_method_ready",
      },
      input.providerEventId,
      subscription
    ),
  ];
}

/**
 * The facts the provider's state implies, for the reconciliation (Q8): the same
 * reading of each charge as the webhook's, with IDs that are the same every
 * time the same state is read (`reconcile:<id>:<status>`), so reading twice
 * stores once. A webhook of the same fact has another ID; its row is absorbed
 * by value (same period, `not_applicable`). Only charges whose period has not
 * ended yet are read: an older one can no longer change access.
 */
export function reconcileAsaasSubscription(input: {
  now: Date;
  payments: readonly AsaasPayment[];
  subscription: AsaasSubscription;
}): ProviderBillingEvent[] {
  const { now, subscription } = input;
  if (subscription.checkoutSession === null) {
    return [];
  }
  const charges = byDueDate(
    input.payments.filter((payment) => ownsCharge(payment, subscription))
  );
  const events: ProviderBillingEvent[] = [];
  const add = (fact: BillingFact, id: string, status: string) => {
    events.push(event(fact, `reconcile:${id}:${status}`, subscription));
  };
  // a subscription already gone never starts a trial from the reconciliation
  if (isLive(subscription) && startedWithTrial(charges)) {
    add(
      {
        cycleMonths: cycleOf(subscription),
        occurredAt: now,
        type: "trial_method_ready",
      },
      subscription.id,
      "CHECKOUT_PAID"
    );
  }
  for (const payment of charges) {
    if (chargePeriodEndsAt(payment, subscription).getTime() <= now.getTime()) {
      continue;
    }
    const fact = (type: Parameters<typeof chargeFact>[0]) =>
      chargeFact(type, payment, subscription, now);
    if (payment.status === "OVERDUE") {
      add(fact("charge_failed"), payment.id, "OVERDUE");
    }
    if (PAID_STATUSES.has(payment.status)) {
      add(fact("charge_succeeded"), payment.id, "CONFIRMED");
    }
    if (payment.status === "REFUNDED") {
      add(fact("charge_refunded"), payment.id, "REFUNDED");
    }
    if (CHARGEBACK_STATUSES.has(payment.status)) {
      add(fact("charge_disputed"), payment.id, "CHARGEBACK_REQUESTED");
    }
    if (payment.status === "AWAITING_CHARGEBACK_REVERSAL") {
      add(fact("dispute_reversed"), payment.id, "AWAITING_CHARGEBACK_REVERSAL");
    }
  }
  if (!isLive(subscription)) {
    add(
      { occurredAt: now, type: "subscription_cancelled" },
      subscription.id,
      "DELETED"
    );
  }
  return events;
}

/**
 * The newest charge of the subscription that fell due unpaid (`OVERDUE`), the one the owner pays on the provider's
 * page in grace (ADR 0104, decision 3), or null. Only a charge the subscription owns (`ownsCharge`).
 */
export function overdueCharge(
  payments: readonly AsaasPayment[],
  subscription: AsaasSubscription
): AsaasPayment | null {
  return (
    byDueDate(
      payments.filter(
        (payment) =>
          ownsCharge(payment, subscription) && payment.status === "OVERDUE"
      )
    ).at(-1) ?? null
  );
}

/**
 * The charge of the period in force, if it can still be refunded in full: the
 * latest live charge of the subscription already due (in São Paulo), paid (`CONFIRMED` or `RECEIVED`) and
 * whose period has not ended. A charge already being refunded, refunded or
 * charged back, an unpaid one or a period already over gives null: a repeated
 * request never falls back to an earlier charge.
 */
export function refundableCharge(
  payments: readonly AsaasPayment[],
  subscription: AsaasSubscription,
  now: Date
): AsaasPayment | null {
  // the next charge is created ahead of its due date: it is not the period in force yet
  const today = new Date(now.getTime() - SAO_PAULO_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
  const latest = byDueDate(
    payments.filter(
      (payment) =>
        ownsCharge(payment, subscription) && payment.originalDueDate <= today
    )
  ).at(-1);
  if (
    !(
      latest &&
      (latest.status === "CONFIRMED" || latest.status === "RECEIVED")
    ) ||
    chargePeriodEndsAt(latest, subscription).getTime() <= now.getTime()
  ) {
    return null;
  }
  return latest;
}
