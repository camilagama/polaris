const decimalTextPattern = /^(-?)(\d+)(?:\.(\d+))?$/;
const thousandsPattern = /\B(?=(\d{3})+(?!\d))/g;
const trailingZerosPattern = /0+$/;
const shortInstantFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
});
const instantFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

/** Formats an exact decimal string as BRL without going through a float. */
export function formatBrlAmount(value: string): string {
  const match = decimalTextPattern.exec(value.trim());
  if (!match) {
    return value;
  }
  const sign = match[1] ?? "";
  const whole = (match[2] ?? "0").replace(thousandsPattern, ".");
  const trimmed = (match[3] ?? "").replace(trailingZerosPattern, "");
  const fraction = trimmed.padEnd(2, "0");
  return `${sign}R$ ${whole},${fraction}`;
}

/** Reais always to the cent, half-up from the exact decimal text and without a float: "19.395" becomes "R$ 19,40". */
export function formatBrlCents(value: string): string {
  const match = decimalTextPattern.exec(value.trim());
  if (!match) {
    return value;
  }
  const sign = match[1] ?? "";
  const fraction = match[3] ?? "";
  const cents = BigInt(`${match[2]}${fraction.slice(0, 2).padEnd(2, "0")}`);
  const rounded = fraction.charAt(2) >= "5" ? cents + 1n : cents;
  const digits = rounded.toString().padStart(3, "0");
  const whole = digits.slice(0, -2).replace(thousandsPattern, ".");
  const isZero = rounded === 0n;
  return `${isZero ? "" : sign}R$ ${whole},${digits.slice(-2)}`;
}

/** An instant in the device's locale and time zone, e.g. `13/10/2026 15:30`. */
export function formatInstant(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : instantFormatter.format(date);
}

/** An instant without the year, in the device's locale and time zone, e.g. `13/10 15:30`. */
export function formatShortInstant(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const parts = Object.fromEntries(
    shortInstantFormatter
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}

/** dd/mm/aaaa from a YYYY-MM-DD calendar date, without any time zone shift. */
export function formatCalendarDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

/** Whole units with thousands separators: 12345 becomes "12.345". */
export function formatQuantity(value: number): string {
  return String(value).replace(thousandsPattern, ".");
}
