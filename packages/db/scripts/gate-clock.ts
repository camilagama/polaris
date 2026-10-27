import { calendarDateInTimeZone } from "@polaris/domain/sales/confirm-sale";

/**
 * The clock of a gate that works out a calendar day (t438; the economics gate of PR 306 failed the main CI
 * because "3 hours ago" fell on yesterday before 03:00 in São Paulo and on today after it).
 *
 * A gate does not read the wall clock to find a day: it asks `runClock`, which is read once when the process starts
 * and never moves, so every day a run works out agrees with the others, and it hands its dates to the helpers below,
 * which take the clock as an argument. The unit test of the helpers runs them on fixed clocks around midnight in São
 * Paulo (`gate-clock.test.ts`); the test of the loose clock (`gate-loose-clock.test.ts`) keeps `Date.now()` and
 * `new Date()` out of the gates.
 *
 * The organization's calendar is America/Sao_Paulo (UTC-3, no daylight saving time since 2019).
 */
const STORE_TIME_ZONE = "America/Sao_Paulo";

export type Clock = () => Date;

const startedAt = new Date();

/** The instant the process started: the same on every call, so a run never sees two different days. */
export const runClock: Clock = () => new Date(startedAt.getTime());

/** Shifts a `YYYY-MM-DD` calendar date by whole days. */
export function shiftDay(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days))
    .toISOString()
    .slice(0, 10);
}

/** The organization's calendar date on `clock`, moved by whole days (a calendar shift, not `days * 24 h`). */
export function storeDay(
  clock: Clock,
  offsetDays = 0,
  timeZone: string = STORE_TIME_ZONE
): string {
  return shiftDay(calendarDateInTimeZone(clock(), timeZone), offsetDays);
}

/** Noon of a store day, as the instant a command carries: the same day in the store calendar and in UTC. */
export function storeNoon(day: string): string {
  return `${day}T15:00:00.000Z`;
}
