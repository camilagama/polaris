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

export interface ClockParts {
  /** dd/mm/aaaa */
  date: string;
  /** HH:mm, 24 hours */
  time: string;
}

/**
 * The date and the time of an instant in an IANA time zone, as dd/mm/aaaa and
 * HH:mm. An unknown zone falls back to the device zone instead of failing.
 */
export function clockPartsInTimezone(
  instant: Date,
  timezone: string | null
): ClockParts {
  const parts = (zone: string | undefined) => {
    const found: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone: zone,
      year: "numeric",
    }).formatToParts(instant)) {
      found[part.type] = part.value;
    }
    return found;
  };
  let found: Record<string, string>;
  try {
    found = parts(timezone ?? undefined);
  } catch {
    found = parts(undefined);
  }
  return {
    date: `${found.day}/${found.month}/${found.year}`,
    time: `${found.hour}:${found.minute}`,
  };
}
