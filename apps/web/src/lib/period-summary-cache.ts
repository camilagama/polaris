import type { PeriodSummaryReadModel } from "@polaris/contracts";
import {
  type CogsCoverage,
  cogsCoverage,
} from "@polaris/domain/economics/period-summary";
import type { PreferenceStorage } from "./current-organization-model";

/**
 * The last confirmed result of a month as of the last time the dashboard read it
 * with a connection, kept so the screen can still show it without one (ADR
 * 0056). It is a copy of what the server said at `generatedAt`, never a figure
 * the device computed, and it never includes work still waiting in the outbox.
 * The copy goes away with the session (sign-out or an "unauthorized" answer),
 * like the cached organizations and payment profiles (ADR 0047, 0049).
 */
const KEY_PREFIX = "polaris.offline.periodSummary.";

/** The Início's own copy (`home/home-copy.ts`): the days before the month, the goal shown and whether the store sold. */
export const HOME_COPY_KEY_PREFIX = "polaris.offline.home.";

/** The copy of the Início's map (`home/rhythm-copy.ts`): the light daily series before the month, ~3 KB. */
export const DAILY_SALES_COPY_KEY_PREFIX = "polaris.offline.dailySales.";

/**
 * The map's series of this page, by organization (`home/rhythm-copy.ts`): the daily cache that works with the offline
 * runtime off too (nothing on the disk then), so going back to the Início after a sale does not read it again. It goes
 * with the copies below; leaving the page (Sair) takes it anyway.
 */
export const dailySalesMemory = new Map<string, unknown>();

type SummaryDay = PeriodSummaryReadModel["daily"][number];

/** A day as kept: a copy written before the costs of the day existed has no `costs`, `operatingExpenses` or `operatingResult`. */
export type StoredDay = Omit<
  SummaryDay,
  "costs" | "operatingExpenses" | "operatingResult"
> &
  Partial<Pick<SummaryDay, "costs" | "operatingExpenses" | "operatingResult">>;

type SummaryQuality = PeriodSummaryReadModel["quality"];

/**
 * The quality as kept: a copy written before `cogsCoverage` existed (or a Worker of the version before) has none, and
 * one from a later server may bring a value this bundle does not know. Neither is read: see `cogsCoverageOf`.
 */
export type StoredQuality = Omit<SummaryQuality, "cogsCoverage"> & {
  cogsCoverage?: unknown;
};

/**
 * A summary as kept on the device: a copy written before the daily series
 * existed has no `daily` (the screen then draws no series for that month), one
 * written before the costs of the day has days without `costs` (no series of
 * costs is drawn), one written before the coverage of the cost of the goods has
 * no `quality.cogsCoverage`, and the most sold products are there only when the
 * read asked for them.
 */
export type StoredPeriodSummary = Omit<
  PeriodSummaryReadModel,
  "daily" | "quality"
> & {
  daily?: StoredDay[];
  quality: StoredQuality;
};

/**
 * The coverage of the cost of the goods of a summary on screen: always the domain's, from the two counts of item lines
 * that every valid copy has, never the server's field (an older copy has none, a later server could send a value this
 * bundle does not know, and the field could disagree with the counts). The same function the server runs.
 */
export function cogsCoverageOf(
  quality: Pick<SummaryQuality, "itemLines" | "itemLinesWithUnknownCost">
): CogsCoverage {
  return cogsCoverage(quality);
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
/** Money as the server writes it (`Money.from` reads it): a copy with anything else would break a sum on screen. */
const moneyPattern = /^-?\d{1,18}(?:\.\d{1,2})?$/;
/** A percent as the server writes it (two places for the margin, one for a goal): the same shape. */
const percentPattern = /^-?\d{1,20}(?:\.\d{1,2})?$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many months are kept per organization; the oldest read goes first. */
const MAX_MONTHS_PER_ORGANIZATION = 6;

const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const MISSING_CODES: readonly string[] = [
  "no_expenses",
  "no_sales",
  "unknown_anticipation_fee",
  "unknown_cost",
  "unknown_processing_fee",
];
const QUALITY_LEVELS: readonly string[] = ["complete", "no_data", "partial"];
const CARD_COUNTS = ["items", "salesCount"] as const;
const CARD_TEXTS = ["netSales", "operatingResult"] as const;
const CHAIN_TEXTS = [
  "anticipationFees",
  "cogs",
  "commercialSurcharges",
  "contributionMargin",
  "discounts",
  "estimatedOperatingResult",
  "grossProfit",
  "grossSales",
  "linkedExpenses",
  "netSales",
  "operatingExpenses",
  "processingFees",
  "returns",
] as const;
const QUALITY_COUNTS = [
  "anticipationFeesUnknown",
  "itemLines",
  "itemLinesWithUnknownCost",
  "linkedExpenses",
  "operatingExpenses",
  "processingFeesUnknown",
  "salesCount",
] as const;

type Dictionary = Record<string, unknown>;

function isDictionary(value: unknown): value is Dictionary {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string";
/** Money text, which a sum on screen can read. */
export const isMoney = (value: unknown): value is string =>
  isText(value) && moneyPattern.test(value);
/** Percent text, which the screen can write. */
export const isPercent = (value: unknown): value is string =>
  isText(value) && percentPattern.test(value);
const isCount = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function hasAll(
  value: Dictionary,
  keys: readonly string[],
  check: (field: unknown) => boolean
): boolean {
  return keys.every((key) => check(value[key]));
}

function isCards(value: unknown): boolean {
  return (
    isDictionary(value) &&
    hasAll(value, CARD_COUNTS, isCount) &&
    hasAll(value, CARD_TEXTS, isMoney) &&
    (value.marginPercent === null || isPercent(value.marginPercent)) &&
    (value.ticket === null || isMoney(value.ticket))
  );
}

/** `cogsCoverage` is not checked: absent, unknown or of another type, the screen derives it (`cogsCoverageOf`). */
function isQuality(value: unknown): boolean {
  return (
    isDictionary(value) &&
    hasAll(value, QUALITY_COUNTS, isCount) &&
    typeof value.level === "string" &&
    QUALITY_LEVELS.includes(value.level) &&
    Array.isArray(value.missing) &&
    value.missing.every(
      (code) => typeof code === "string" && MISSING_CODES.includes(code)
    )
  );
}

/** A date that exists: `Date.parse` rolls "2026-02-30" over into March, so the day is read back and compared. */
export function isDate(value: unknown): value is string {
  if (!(isText(value) && datePattern.test(value))) {
    return false;
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

function isPeriod(value: unknown): boolean {
  return isDictionary(value) && isDate(value.from) && isDate(value.to);
}

function isInstant(value: unknown): boolean {
  return isText(value) && !Number.isNaN(Date.parse(value));
}

const DAY_MS = 86_400_000;

/** The date `days` after `date` (both `YYYY-MM-DD`). */
function dateAfter(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Absent (an older copy), null (unknown, never zero) or money. */
function isOptionalMoney(value: unknown): boolean {
  return value === undefined || value === null || isMoney(value);
}

/** Absent (an older copy), or one entry per date of the period, in order. */
function isDaily(value: unknown, period: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!(Array.isArray(value) && isDictionary(period) && isDate(period.from))) {
    return false;
  }
  const { from } = period;
  return (
    value.length > 0 &&
    value.every(
      (day, index) =>
        isDictionary(day) &&
        day.date === dateAfter(from, index) &&
        isMoney(day.netSales) &&
        isCount(day.salesCount) &&
        isOptionalMoney(day.costs) &&
        (day.operatingExpenses === undefined ||
          isMoney(day.operatingExpenses)) &&
        isOptionalMoney(day.operatingResult)
    ) &&
    (value.at(-1) as Dictionary).date === period.to
  );
}

/** Absent (not asked for), or the ranked products as the server sent them. */
function isTopProducts(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry) =>
          isDictionary(entry) &&
          typeof entry.deleted === "boolean" &&
          isText(entry.name) &&
          isMoney(entry.netSales) &&
          isText(entry.productId) &&
          uuidPattern.test(entry.productId) &&
          isCount(entry.quantity) &&
          (entry.quantity as number) > 0
      ))
  );
}

/** True when the value has every field the dashboard reads, with the right kind of value. */
export function isPeriodSummary(value: unknown): value is StoredPeriodSummary {
  return (
    isDictionary(value) &&
    isInstant(value.generatedAt) &&
    isCards(value.cards) &&
    isDictionary(value.chain) &&
    hasAll(value.chain, CHAIN_TEXTS, isMoney) &&
    isPeriod(value.period) &&
    isDaily(value.daily, value.period) &&
    isTopProducts(value.topProducts) &&
    isQuality(value.quality)
  );
}

const organizationPrefix = (organizationId: string) =>
  `${KEY_PREFIX}${organizationId}.`;

const keyOf = (organizationId: string, month: string) =>
  `${organizationPrefix(organizationId)}${month}`;

/** The keys that start with the prefix; empty when the storage cannot list its keys. */
function keysWithPrefix(
  preference: PreferenceStorage | null,
  prefix: string
): string[] {
  // the browser storage also lists its keys; a narrower fake may not
  const storage = preference as
    | (PreferenceStorage & Partial<Pick<Storage, "key" | "length">>)
    | null;
  if (
    !storage ||
    typeof storage.key !== "function" ||
    typeof storage.length !== "number"
  ) {
    return [];
  }
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) {
      keys.push(key);
    }
  }
  return keys;
}

/** The summary kept under a key, when it is still a valid copy of that month. */
function readEntry(
  storage: PreferenceStorage,
  key: string,
  month: string
): StoredPeriodSummary | null {
  const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
  if (
    !isDictionary(parsed) ||
    parsed.month !== month ||
    !isPeriodSummary(parsed.summary) ||
    !parsed.summary.period.from.startsWith(month)
  ) {
    return null;
  }
  return parsed.summary;
}

/** Keeps the newest months of the organization (by when the server read them) and drops the rest. */
function trimToRecentMonths(
  storage: PreferenceStorage,
  organizationId: string
): void {
  const prefix = organizationPrefix(organizationId);
  const entries = keysWithPrefix(storage, prefix).flatMap((key) => {
    const month = key.slice(prefix.length);
    if (!monthPattern.test(month)) {
      return [];
    }
    let generatedAt = Number.NEGATIVE_INFINITY;
    try {
      const summary = readEntry(storage, key, month);
      generatedAt = summary ? Date.parse(summary.generatedAt) : generatedAt;
    } catch {
      // a corrupt copy counts as the oldest and goes first
    }
    return [{ generatedAt, key }];
  });
  entries.sort((a, b) => b.generatedAt - a.generatedAt);
  for (const entry of entries.slice(MAX_MONTHS_PER_ORGANIZATION)) {
    storage.removeItem(entry.key);
  }
}

export interface PeriodSummaryWriteGuard {
  /** The offline runtime is on in this build: only then is the copy kept at all. */
  offlineRuntimeEnabled: boolean;
  /** The person chose "Sair": a read still in flight must not write the copy again. */
  signingOut: boolean;
}

/**
 * Keeps the summary the server just returned for a month. Callers write only
 * after a successful read; the guard turns it into nothing when the offline
 * runtime is off or sign-out has started.
 */
export function writePeriodSummaryCache(
  storage: PreferenceStorage | null,
  organizationId: string,
  month: string,
  summary: StoredPeriodSummary,
  guard: PeriodSummaryWriteGuard
): void {
  if (!guard.offlineRuntimeEnabled || guard.signingOut) {
    return;
  }
  if (!(storage && monthPattern.test(month) && isPeriodSummary(summary))) {
    return;
  }
  try {
    storage.setItem(
      keyOf(organizationId, month),
      JSON.stringify({ month, summary })
    );
    trimToRecentMonths(storage, organizationId);
  } catch {
    // Without it the dashboard only loses its copy for offline.
  }
}

/** The cached summary of that month, or null when missing, corrupt, of another month or not the expected shape. */
export function readPeriodSummaryCache(
  storage: PreferenceStorage | null,
  organizationId: string,
  month: string
): StoredPeriodSummary | null {
  if (!(storage && monthPattern.test(month))) {
    return null;
  }
  try {
    return readEntry(storage, keyOf(organizationId, month), month);
  } catch {
    return null;
  }
}

/**
 * Forgets the copies of one organization (the server refused this person its results): the months and the Início's
 * (its blocks and its map).
 */
export function clearOrganizationResultCopies(
  preference: PreferenceStorage | null,
  organizationId: string
): void {
  dailySalesMemory.delete(organizationId);
  try {
    for (const key of [
      ...keysWithPrefix(preference, organizationPrefix(organizationId)),
      ...keysWithPrefix(preference, `${HOME_COPY_KEY_PREFIX}${organizationId}`),
      ...keysWithPrefix(
        preference,
        `${DAILY_SALES_COPY_KEY_PREFIX}${organizationId}`
      ),
    ]) {
      preference?.removeItem(key);
    }
  } catch {
    // Nothing to clean when storage is unavailable.
  }
}

/** Forgets the summaries of every organization and the Início's copies with them, the map's too (the session ended). */
export function clearPeriodSummaryCaches(
  preference: PreferenceStorage | null
): void {
  dailySalesMemory.clear();
  try {
    for (const key of [
      ...keysWithPrefix(preference, KEY_PREFIX),
      ...keysWithPrefix(preference, HOME_COPY_KEY_PREFIX),
      ...keysWithPrefix(preference, DAILY_SALES_COPY_KEY_PREFIX),
    ]) {
      preference?.removeItem(key);
    }
  } catch {
    // Nothing to clean when storage is unavailable.
  }
}
