import type { BillingPlanView } from "@polaris/contracts";
import { saoPauloDateOf } from "@polaris/domain/billing/provider-period";
import { tabHref } from "../app-shell/navigation-model";
import { clockPartsInTimezone } from "../lib/dates";
import { formatCalendarDate } from "../lib/format";

/**
 * The part of the Assinatura the shell needs on every screen (the notice of grace at the top, AS-35, and the return of
 * the checkouts opened before the return moved to the Assinatura): the days of the plan, São Paulo's, as the server's.
 * Kept apart from the screen's model, so the shell does not carry the screen.
 */

export const DAY_MS = 86_400_000;

/** The last day an access that ends at `instant` covers: the end is the first instant after that day. */
export function lastDayOf(instant: string): string {
  return saoPauloDateOf(new Date(new Date(instant).getTime() - 1));
}

/** dd/mm/aaaa of the last day an access ending at `instant` covers. */
export function accessDateText(instant: string): string {
  return formatCalendarDate(lastDayOf(instant));
}

/** dd/mm/aaaa, 23:59 of the last second of a window (the refund's `until`), in São Paulo. */
export function untilText(instant: string): string {
  const { date, time } = clockPartsInTimezone(
    new Date(instant),
    "America/Sao_Paulo"
  );
  return `${date}, ${time}`;
}

/** Whole calendar days from `today` to `day` (both `AAAA-MM-DD`), never negative. */
export function daysUntil(day: string, today: string): number {
  const at = (date: string) => new Date(`${date}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.round((at(day) - at(today)) / DAY_MS));
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "(7 dias)" next to the end of the grace; the last day is said as such. */
export function daysLeftText(days: number): string {
  return days === 0 ? "último dia" : plural(days, "dia", "dias");
}

/** `/?assinatura=` of a checkout opened before the return moved to the Assinatura: the same return, on the screen. */
export function legacyCheckoutReturnPath(
  pathname: string,
  search: string
): string | null {
  if (pathname !== "/") {
    return null;
  }
  const value = new URLSearchParams(search).get("assinatura");
  return value === "concluida" || value === "cancelada" || value === "expirada"
    ? `${tabHref("settings", "assinatura")}&retorno=${value}`
    : null;
}

// ---- the notice at the top of the app (AS-35) ------------------------------------------------------------------

export interface GraceNotice {
  description: string;
  title: string;
}

/**
 * In grace, the notice at the top of every screen of the owner: until when the Pro goes and how many days are
 * left, counted from the end of the period already paid plus the grace (RN:19), never negative. No promise of a way to
 * pay here (T-2): the Assinatura says what there is.
 */
export function graceNotice(
  plan: Pick<BillingPlanView, "accessEndsAt" | "state">,
  now: Date
): GraceNotice | null {
  if (plan.state !== "grace" || plan.accessEndsAt === null) {
    return null;
  }
  const lastDay = lastDayOf(plan.accessEndsAt);
  const days = daysUntil(lastDay, saoPauloDateOf(now));
  return {
    description: `Seu Pro vai até ${formatCalendarDate(lastDay)} (${daysLeftText(days)}); depois a loja volta ao Free e seus dados ficam.`,
    title: "O último pagamento não foi confirmado.",
  };
}

// ---- what the notice remembers between the screens of this tab ------------------------------------------------

/**
 * The state of the plan the notice reads, kept for this tab only (`sessionStorage`, or the page's memory where the
 * browser refuses it), so every screen of the owner does not read the whole plan again: nothing but the state and the
 * end of the access, never a plan shown as current on the Assinatura (which reads its own, AS-8). What was read is
 * shown at once, and read again once it is older than a few minutes (the notice stays while it is read again).
 */
export const PLAN_NOTICE_KEY = "polaris.billing.planNotice";
export const PLAN_NOTICE_FOR_MS = 5 * 60_000;

export type PlanNoticeFacts = Pick<BillingPlanView, "accessEndsAt" | "state">;

export interface RememberedNotice extends PlanNoticeFacts {
  organizationId: string;
  readAt: number;
}

type SessionStore = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function sessionStore(): SessionStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The copy in the page's memory: the notice works without the storage, for as long as the page lives. */
let inMemory: string | null = null;

const listeners = new Set<() => void>();

/** The screens that read the plan tell the notice, which shows or hides at once. */
export function subscribePlanNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function tell(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function rememberPlanNotice(
  organizationId: string,
  plan: PlanNoticeFacts,
  now: number = Date.now(),
  store: SessionStore | null = sessionStore()
): void {
  const value: RememberedNotice = {
    accessEndsAt: plan.accessEndsAt,
    organizationId,
    readAt: now,
    state: plan.state,
  };
  inMemory = JSON.stringify(value);
  try {
    store?.setItem(PLAN_NOTICE_KEY, inMemory);
  } catch {
    // the page's memory still has it
  }
  tell();
}

function storedText(store: SessionStore | null): string | null {
  try {
    return store?.getItem(PLAN_NOTICE_KEY) ?? inMemory;
  } catch {
    return inMemory;
  }
}

/** What this tab read of the store's plan, and when; null for another store or a value that is not one. */
export function rememberedPlanNotice(
  organizationId: string,
  store: SessionStore | null = sessionStore()
): RememberedNotice | null {
  try {
    const value = JSON.parse(
      storedText(store) ?? "null"
    ) as Partial<RememberedNotice> | null;
    if (
      value === null ||
      typeof value !== "object" ||
      value.organizationId !== organizationId ||
      typeof value.readAt !== "number" ||
      typeof value.state !== "string" ||
      !(value.accessEndsAt === null || typeof value.accessEndsAt === "string")
    ) {
      return null;
    }
    return {
      accessEndsAt: value.accessEndsAt,
      organizationId,
      readAt: value.readAt,
      state: value.state,
    };
  } catch {
    return null;
  }
}

/** The wait before the notice tries a failed read again: 1 min, doubling up to 10 min. */
export function planNoticeRetryDelayMs(failures: number): number {
  return Math.min(60_000 * 2 ** Math.max(failures - 1, 0), 600_000);
}

/**
 * The wait after failed reads, of ONE store: the reads that failed in a row and the first instant the next one may
 * start. It names its store, so a wait never carries over to another one (the user switching stores) and the answer
 * of a read that was started for a store is never counted in another's.
 */
export interface PlanReadBackoff {
  failures: number;
  organizationId: string;
  retryAt: number;
}

/** No failure yet, in this store. */
export function noPlanReadBackoff(organizationId: string): PlanReadBackoff {
  return { failures: 0, organizationId, retryAt: 0 };
}

/** The wait that applies to this store: the one kept, or none when it is of another store. */
export function planReadBackoffFor(
  backoff: PlanReadBackoff,
  organizationId: string
): PlanReadBackoff {
  return backoff.organizationId === organizationId
    ? backoff
    : noPlanReadBackoff(organizationId);
}

/** A read of this store worked: its wait is over. The answer of a store no longer the one kept changes nothing. */
export function planReadSucceeded(
  backoff: PlanReadBackoff,
  organizationId: string
): PlanReadBackoff {
  return backoff.organizationId === organizationId
    ? noPlanReadBackoff(organizationId)
    : backoff;
}

/**
 * A read of this store failed: one more failure, and the wait counted from `startedAt`, the minute that started the
 * read, so it is not stretched by the answer's delay. The failure of a store no longer the one kept changes nothing.
 */
export function planReadFailed(
  backoff: PlanReadBackoff,
  organizationId: string,
  startedAt: number
): PlanReadBackoff {
  if (backoff.organizationId !== organizationId) {
    return backoff;
  }
  const failures = backoff.failures + 1;
  return {
    failures,
    organizationId,
    retryAt: startedAt + planNoticeRetryDelayMs(failures),
  };
}

/** The stores whose plan is being read right now: a read of one store never holds back another's. */
export type PlanReadsInFlight = ReadonlySet<string>;

/** No read in flight. */
export const noPlanReadsInFlight: PlanReadsInFlight = new Set<string>();

/** A read of this store is already on its way: the same store never starts two at once. */
export function planReadInFlight(
  reads: PlanReadsInFlight,
  organizationId: string
): boolean {
  return reads.has(organizationId);
}

/** A read of this store started. */
export function planReadStarted(
  reads: PlanReadsInFlight,
  organizationId: string
): PlanReadsInFlight {
  return new Set(reads).add(organizationId);
}

/** The read of this store ended, with an answer or not: it frees only this store. */
export function planReadEnded(
  reads: PlanReadsInFlight,
  organizationId: string
): PlanReadsInFlight {
  const rest = new Set(reads);
  rest.delete(organizationId);
  return rest;
}

/** Read again: never read, older than the few minutes, or read "in the future" (the device's clock went back). */
export function planNoticeIsOld(
  remembered: Pick<RememberedNotice, "readAt"> | null,
  now: number
): boolean {
  return (
    remembered === null ||
    now - remembered.readAt >= PLAN_NOTICE_FOR_MS ||
    now < remembered.readAt
  );
}

/** The session is over: what the notice kept of the plan goes with it. */
export function clearPlanNotice(
  store: SessionStore | null = sessionStore()
): void {
  inMemory = null;
  try {
    store?.removeItem(PLAN_NOTICE_KEY);
  } catch {
    // nothing kept, nothing to drop
  }
  tell();
}
