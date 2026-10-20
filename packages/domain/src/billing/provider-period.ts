import { isValidCalendarDate } from "../inventory/calendar-date";
import type { BillingCycleMonths } from "./facts";

/**
 * The end of the period a provider charge pays for (ADR 0101). Neither payment
 * provider says when a paid period ends, so it is derived from two stable
 * fields of the provider: the charge's own due date and the cycle of its
 * subscription. Never from "now": the same charge read by a webhook, by its
 * redelivery and by the reconciliation gives the same end, whenever it is read.
 *
 * Months are added on the calendar and a day the target month lacks is clamped
 * to its last day (31/01 + 1 month = 28/02, and the renewal due on 28/02 ends
 * on 28/03). The paid period runs through the whole of that day in São Paulo,
 * because the renewal is charged during the day it falls due; a payment made
 * late keeps the end its due date gives, so the days of delay are lost.
 */

const DAY_MS = 86_400_000;
/** São Paulo has had no daylight saving time since 2019: its days start at 03:00 UTC. */
const SAO_PAULO_OFFSET = "-03:00";

export class InvalidDueDateError extends Error {
  readonly code = "invalid_due_date";

  constructor() {
    super("invalid_due_date");
    this.name = "InvalidDueDateError";
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** `AAAA-MM-DD` plus whole months, clamped to the last day of the target month. */
export function addCalendarMonths(date: string, months: number): string {
  if (!(isValidCalendarDate(date) && Number.isInteger(months) && months >= 0)) {
    throw new InvalidDueDateError();
  }
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = (monthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${pad(targetYear, 4)}-${pad(targetMonth, 2)}-${pad(Math.min(day, lastDay), 2)}`;
}

/** The instant the period paid by a charge due on `dueOn` (`AAAA-MM-DD`) ends. */
export function paidPeriodEndsAt(
  dueOn: string,
  cycleMonths: BillingCycleMonths
): Date {
  const lastDay = addCalendarMonths(dueOn, cycleMonths);
  const start = new Date(`${lastDay}T00:00:00.000${SAO_PAULO_OFFSET}`);
  return new Date(start.getTime() + DAY_MS);
}

/** The calendar day (`AAAA-MM-DD`) an instant falls on in São Paulo. */
export function saoPauloDateOf(instant: Date): string {
  const time = instant.getTime();
  if (!Number.isFinite(time)) {
    throw new InvalidDueDateError();
  }
  return new Date(time - 3 * 3_600_000).toISOString().slice(0, 10);
}
