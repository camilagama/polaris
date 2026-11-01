import { useEffect, useState } from "react";
import { calendarDayInTimezone } from "../lib/dates";

/** The screen is left open for hours; a minute is the finest the day of the store can turn at. */
export const STORE_TODAY_TICK_MS = 60_000;

/**
 * The store's calendar day (YYYY-MM-DD), following the clock: it turns at midnight of the store's zone, not of the
 * device's, and a tab that wakes up late reads it again at once. Only the day is kept in state, so the minute tick
 * renders nothing while the day stays the same. Reading the clock is local, so it costs no request.
 */
export function useStoreToday(timezone: string | null): string {
  const [today, setToday] = useState(() =>
    calendarDayInTimezone(new Date(), timezone)
  );

  useEffect(() => {
    const read = () => setToday(calendarDayInTimezone(new Date(), timezone));
    read();
    const timer = window.setInterval(read, STORE_TODAY_TICK_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [timezone]);

  return today;
}
