import { calendarDayInTimezone } from "../lib/dates";
import { useNow } from "../lib/use-now";

/** The screen is left open for hours; a minute is the finest the day of the store can turn at. */
export const STORE_TODAY_TICK_MS = 60_000;

/**
 * The store's calendar day (YYYY-MM-DD), following the clock: it turns at midnight of the store's zone, not of the
 * device's, and a tab that wakes up late reads it again at once. Reading the clock is local, so it costs no request.
 */
export function useStoreToday(timezone: string | null): string {
  return calendarDayInTimezone(useNow(STORE_TODAY_TICK_MS), timezone);
}
