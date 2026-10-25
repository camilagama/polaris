/**
 * The values of the date pickers, as calendar days written `AAAA-MM-DD` (the form `<input type="date">` gave the
 * screens, and the one the server reads): no hour and no time zone, so a day never slides to the one before. Pure
 * functions with no library, so the trigger of a picker writes its date without the calendar chunk (date-fns and
 * react-day-picker come only with `calendar.tsx`, on demand).
 */
export type IsoDate = string;

export interface DateRange {
  from: IsoDate;
  to: IsoDate;
}

/** A range being chosen: the first touch marks the start and leaves the end open. */
export interface DraftRange {
  from?: IsoDate | undefined;
  to?: IsoDate | undefined;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (value: number) => String(value).padStart(2, "0");

/** The day of a `Date`, read in the device's calendar. */
export function toIsoDate(date: Date): IsoDate {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The `Date` at noon of a day (noon, as in the Araute's picker: a change of daylight time never moves it to another
 * day), or `undefined` for anything that is not a real day.
 */
export function parseIsoDate(
  value: IsoDate | null | undefined
): Date | undefined {
  const match = value ? ISO_DATE.exec(value) : null;
  if (!match) {
    return undefined;
  }
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : undefined;
}

/** `value` when it is a real day, and otherwise `undefined` (a screen that passes a bad date gets an empty field). */
export function validDay(
  value: IsoDate | null | undefined
): IsoDate | undefined {
  return parseIsoDate(value) ? (value as IsoDate) : undefined;
}

/** The store's day the screen passed, or the device's when it passed none or a bad one. */
export function todayOr(value: IsoDate | null | undefined): IsoDate {
  return validDay(value) ?? toIsoDate(new Date());
}

/** `range` when both ends are real days in order, and otherwise null (a bad range from a screen shows as none). */
export function validRange(
  range: DateRange | null | undefined
): DateRange | null {
  return range &&
    validDay(range.from) &&
    validDay(range.to) &&
    range.from <= range.to
    ? range
    : null;
}

function parts(value: IsoDate) {
  const [year, month, day] = value.split("-");
  return { day: day ?? "", month: month ?? "", year: year ?? "" };
}

/** "24/10/2026". */
export function formatDate(value: IsoDate): string {
  const { day, month, year } = parts(value);
  return `${day}/${month}/${year}`;
}

/**
 * The text of the range picker's button: "01/10 a 24/10", or "24/10/2026" when it is one day. The year is written
 * when the range is not all in the year of `today`, so a range of another year is never read as this year's.
 */
export function formatRange(range: DateRange, today: IsoDate): string {
  if (range.from === range.to) {
    return formatDate(range.from);
  }
  const from = parts(range.from);
  const to = parts(range.to);
  const thisYear = parts(today).year;
  if (from.year === thisYear && to.year === thisYear) {
    return `${from.day}/${from.month} a ${to.day}/${to.month}`;
  }
  return `${formatDate(range.from)} a ${formatDate(range.to)}`;
}

/**
 * The next state of a range after a touch on `day`. An empty or complete range starts again at `day`, open; an
 * open one closes, with the earlier of the two days as the start, so an inverted range cannot exist. `complete`
 * says the picker may close and hand the range over.
 */
export function nextRange(
  draft: DraftRange | undefined,
  day: IsoDate
):
  | { complete: false; draft: DraftRange }
  | { complete: true; range: DateRange } {
  const from = draft?.from;
  if (!from || draft?.to) {
    return { complete: false, draft: { from: day, to: undefined } };
  }
  return {
    complete: true,
    range: day < from ? { from: day, to: from } : { from, to: day },
  };
}

/** Whether `day` is inside the allowed days (both ends included; a missing end does not limit). */
export function isWithin(
  day: IsoDate,
  min: IsoDate | undefined,
  max: IsoDate | undefined
): boolean {
  return (min === undefined || day >= min) && (max === undefined || day <= max);
}

/** `day` brought inside the allowed days: `min` when it is before them, `max` when it is after. */
export function clampDay(
  day: IsoDate,
  min: IsoDate | undefined,
  max: IsoDate | undefined
): IsoDate {
  if (min !== undefined && day < min) {
    return min;
  }
  return max !== undefined && day > max ? max : day;
}

export type RangePreset = "hoje" | "7-dias" | "este-mes" | "mes-passado";

export const RANGE_PRESETS: readonly { label: string; value: RangePreset }[] = [
  { label: "Hoje", value: "hoje" },
  { label: "7 dias", value: "7-dias" },
  { label: "Este mês", value: "este-mes" },
  { label: "Mês passado", value: "mes-passado" },
];

function shiftDays(value: IsoDate, days: number): IsoDate {
  const date = parseIsoDate(value) as Date;
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

/**
 * The range of a shortcut, counted back to `today` (the store's day, which the screen takes from the server): "7 dias"
 * is today and the six before it, "Este mês" the 1st to today, "Mês passado" the whole month before.
 */
export function presetRange(preset: RangePreset, today: IsoDate): DateRange {
  const { month, year } = parts(today);
  switch (preset) {
    case "hoje":
      return { from: today, to: today };
    case "7-dias":
      return { from: shiftDays(today, -6), to: today };
    case "este-mes":
      return { from: `${year}-${month}-01`, to: today };
    case "mes-passado": {
      const firstOfThisMonth = `${year}-${month}-01`;
      const lastOfPrevious = shiftDays(firstOfThisMonth, -1);
      const previous = parts(lastOfPrevious);
      return {
        from: `${previous.year}-${previous.month}-01`,
        to: lastOfPrevious,
      };
    }
    default:
      return preset satisfies never;
  }
}

/** The shortcut whose range is exactly `range`, if there is one (the segment shown as pressed). */
export function matchingPreset(
  range: DateRange | null,
  today: IsoDate
): RangePreset | undefined {
  if (!range) {
    return undefined;
  }
  return RANGE_PRESETS.find(({ value }) => {
    const preset = presetRange(value, today);
    return preset.from === range.from && preset.to === range.to;
  })?.value;
}
