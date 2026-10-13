const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The calendar day (YYYY-MM-DD) of an instant in an IANA time zone. An unknown
 * zone falls back to the device zone instead of failing.
 */
export function calendarDayInTimezone(
  instant: Date,
  timezone: string | null
): string {
  const format = (zone: string | undefined) =>
    new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone: zone,
      year: "numeric",
    }).format(instant);
  try {
    return format(timezone ?? undefined);
  } catch {
    return format(undefined);
  }
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isCalendarDate(value: string): boolean {
  if (!calendarDatePattern.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}
