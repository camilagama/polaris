import { calendarDateInTimeZone } from "./confirm-sale";

/**
 * Retroactive window of a sale for the V1 `owner`: "approximately 30 days"
 * (time and dates rules). It is counted in calendar days of the organization's
 * time zone, so a sale on the same local date 30 days ago is still accepted and
 * one on the previous local date is not.
 */
export const OWNER_MAX_RETROACTIVE_DAYS = 30;

/**
 * Days a role may back-date a sale. Only the V1 `owner` exists; an unknown role
 * gets zero days, so the window fails closed when roles are added.
 */
export function retroactiveLimitDaysForRole(role: string): number {
  return role === "owner" ? OWNER_MAX_RETROACTIVE_DAYS : 0;
}

/** The commercial date is older than the role's retroactive window. */
export class SaleOccurredTooOldError extends Error {
  readonly code = "sale_occurred_too_old";

  constructor() {
    super("sale_occurred_too_old");
    this.name = "SaleOccurredTooOldError";
  }
}

const millisecondsPerDay = 86_400_000;

function utcDay(localDate: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

/** Whole calendar days between two `YYYY-MM-DD` dates (later minus earlier). */
export function calendarDaysBetween(earlier: string, later: string): number {
  return Math.round((utcDay(later) - utcDay(earlier)) / millisecondsPerDay);
}

export interface SaleCommercialTimeWindow {
  maxRetroactiveDays: number;
  /** The server clock; the authority for the confirmation. */
  now: Date;
  occurredAt: Date;
  /** IANA time zone of the organization. */
  timeZone: string;
}

/**
 * Checks the retroactive limit in the organization's calendar and returns the
 * commercial date (`occurred_on`) in that calendar. The future bound is checked
 * earlier, with the command, because it needs no time zone.
 */
export function assertSaleOccurredWithinWindow(
  window: SaleCommercialTimeWindow
): string {
  const occurredOn = calendarDateInTimeZone(window.occurredAt, window.timeZone);
  const today = calendarDateInTimeZone(window.now, window.timeZone);
  if (calendarDaysBetween(occurredOn, today) > window.maxRetroactiveDays) {
    throw new SaleOccurredTooOldError();
  }
  return occurredOn;
}
