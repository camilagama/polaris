import type { PreferenceStorage } from "../lib/current-organization-model";
import {
  DAILY_SALES_COPY_KEY_PREFIX,
  dailySalesMemory,
  type PeriodSummaryWriteGuard,
} from "../lib/period-summary-cache";
import type { Period } from "./home-model";
import { type DailySeries, isDailySeries } from "./home-rhythm-model";

/**
 * The copy of the Início's map on the device (desenho do `dailySales`, Filipe 25/10; condição do Rodrigo, PR 335): the
 * series `report.dailySales` returned (the days before the month, ~3 KB), under `polaris.offline.dailySales.<org>`,
 * with the same life as the other copies of the Início: it goes with "Sair" and with the session ended
 * (`clearPeriodSummaryCaches`), with a refusal of the store (`clearOrganizationResultCopies`), and a read still in flight
 * does not write it once sign-out started (the guard). The days of the month are the month's copy; without this one
 * the map says it opens with a connection.
 *
 * It is also the map's daily cache (Filipe, CPU-1e item 3): the copy keeps the store's day it was read on, and the
 * Início asks `report.dailySales` again only when the copy is not of today (or of another period), or on an explicit
 * "Tentar novamente". The days before the month may then miss a return made today until tomorrow: "até ontem".
 * With the runtime off (production today) nothing goes to the disk: the same day and series stay in the page's memory
 * (`dailySalesMemory`, cleared with the copies), so a second opening in the same page still reads once a day.
 */
const keyOf = (organizationId: string) =>
  `${DAILY_SALES_COPY_KEY_PREFIX}${organizationId}`;

/**
 * Keeps the series the server just returned, in the page's memory and, with the runtime on, on the device; nothing
 * once sign-out has started.
 */
export function writeRhythmCopy(
  storage: PreferenceStorage | null,
  organizationId: string,
  series: DailySeries,
  readOn: string,
  guard: PeriodSummaryWriteGuard
): void {
  if (guard.signingOut || !isDailySeries(series)) {
    return;
  }
  dailySalesMemory.set(organizationId, { readOn, series });
  if (!(guard.offlineRuntimeEnabled && storage)) {
    return;
  }
  try {
    storage.setItem(
      keyOf(organizationId),
      JSON.stringify({
        count: series.count,
        from: series.from,
        net: series.net,
        readOn,
      })
    );
  } catch {
    // Without it the map only loses its copy for offline.
  }
}

function readKept(
  storage: PreferenceStorage | null,
  organizationId: string
): { readOn: unknown; series: DailySeries } | null {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(keyOf(organizationId)) ?? "null"
    );
    if (!isDailySeries(parsed)) {
      return null;
    }
    const { count, from, net } = parsed;
    return {
      readOn: (parsed as { readOn?: unknown }).readOn,
      series: { count, from, net },
    };
  } catch {
    return null;
  }
}

/** The series kept for the organization, or null when missing, corrupt or not the expected shape. */
export function readRhythmCopy(
  storage: PreferenceStorage | null,
  organizationId: string
): DailySeries | null {
  return readKept(storage, organizationId)?.series ?? null;
}

/**
 * The series kept (in the page's memory, or else on the device), only when it was read on the store's `today` for this
 * `period`: what the Início shows instead of reading `report.dailySales` again (one read a day per device). Null
 * otherwise, a copy without its day included.
 */
export function todaysRhythmCopy(
  storage: PreferenceStorage | null,
  organizationId: string,
  period: Period,
  today: string
): DailySeries | null {
  const remembered = dailySalesMemory.get(organizationId) as
    | { readOn: string; series: DailySeries }
    | undefined;
  const kept =
    remembered?.readOn === today
      ? remembered
      : readKept(storage, organizationId);
  return kept?.readOn === today && isDailySeries(kept.series, period)
    ? kept.series
    : null;
}
