/**
 * Dates of the journeys, computed from T0 and the organization's time zone, never written by hand (T-125a §4.1).
 */

/** "AAAA-MM-DD" of an instant in a time zone. */
export function localDate(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone, year: "numeric" }).format(
    new Date(instant)
  );
}

/**
 * The extreme zone whose local date differs from the UTC date at T0: +14 h (Kiritimati) from 10:00 UTC on, −11 h
 * (Pago Pago) before 11:00 UTC. One of them always differs, so the "local date ≠ UTC date" class of error is
 * covered at any hour of the run.
 */
export function extremeTimeZone(t0: number): "Pacific/Kiritimati" | "Pacific/Pago_Pago" {
  const utc = localDate(t0, "UTC");
  return localDate(t0, "Pacific/Kiritimati") !== utc ? "Pacific/Kiritimati" : "Pacific/Pago_Pago";
}

/** The first day of the month of a local date, shifted by whole months. */
export function monthStart(date: string, shift = 0): string {
  const [year, month] = date.split("-").map(Number) as [number, number];
  const index = year * 12 + (month - 1) + shift;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

/** A local date shifted by whole days (calendar arithmetic, no time zone). */
export function addDays(date: string, days: number): string {
  const instant = Date.parse(`${date}T12:00:00Z`) + days * 86_400_000;
  return new Date(instant).toISOString().slice(0, 10);
}

/** "DD/MM/AAAA" as the app shows a calendar date. */
export function brDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}
