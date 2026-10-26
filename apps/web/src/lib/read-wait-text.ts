import { calendarDayInTimezone, clockPartsInTimezone } from "./dates";

/**
 * The words of a read that takes long or ran out of tries (paliativo dos 1102). Provisional: the final texts are the
 * design review's (Petković).
 */

/** Under the skeleton after ~3 s, while the tries go on: no button, nothing to do yet. */
export const SLOW_READ_TEXT = "Demorando mais que o normal…";

/** Over the copy the screen shows when every try failed with a connection. */
export const STALE_COPY_TITLE = "Não foi possível atualizar agora";

/**
 * "Atualizado às 14:05" when the copy is of today in the store's zone, "Atualizado em 22/10 às 18:40" when it is of
 * another day: the hour alone would pass an old copy for a fresh one.
 */
export function updatedAtText(
  generatedAt: string,
  timezone: string | null,
  now: Date
): string {
  const instant = new Date(generatedAt);
  if (Number.isNaN(instant.getTime())) {
    return "";
  }
  const { time } = clockPartsInTimezone(instant, timezone);
  const day = calendarDayInTimezone(instant, timezone);
  if (day === calendarDayInTimezone(now, timezone)) {
    return `Atualizado às ${time}`;
  }
  return `Atualizado em ${day.slice(8, 10)}/${day.slice(5, 7)} às ${time}`;
}
