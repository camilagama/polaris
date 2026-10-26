import type { PreferenceStorage } from "../lib/current-organization-model";
import {
  DAILY_SALES_COPY_KEY_PREFIX,
  type PeriodSummaryWriteGuard,
} from "../lib/period-summary-cache";
import { type DailySeries, isDailySeries } from "./home-rhythm-model";

/**
 * The copy of the Início's map on the device (desenho do `dailySales`, Filipe 25/10; condição do Rodrigo, PR 335): the
 * series `report.dailySales` returned (the days before the month, ~3 KB), under `polaris.offline.dailySales.<org>`,
 * with the same life as the other copies of the Início: it goes with "Sair" and with the session ended
 * (`clearPeriodSummaryCaches`), with a refusal of the store (`clearOrganizationResultCopies`), and a read still in flight
 * does not write it once sign-out started (the guard). The days of the month are the month's copy; without this one
 * the map says it opens with a connection.
 */
const keyOf = (organizationId: string) =>
  `${DAILY_SALES_COPY_KEY_PREFIX}${organizationId}`;

/** Keeps the series the server just returned; nothing when the runtime is off or sign-out has started. */
export function writeRhythmCopy(
  storage: PreferenceStorage | null,
  organizationId: string,
  series: DailySeries,
  guard: PeriodSummaryWriteGuard
): void {
  if (!(guard.offlineRuntimeEnabled && storage) || guard.signingOut) {
    return;
  }
  if (!isDailySeries(series)) {
    return;
  }
  try {
    storage.setItem(
      keyOf(organizationId),
      JSON.stringify({
        count: series.count,
        from: series.from,
        net: series.net,
      })
    );
  } catch {
    // Without it the map only loses its copy for offline.
  }
}

/** The series kept for the organization, or null when missing, corrupt or not the expected shape. */
export function readRhythmCopy(
  storage: PreferenceStorage | null,
  organizationId: string
): DailySeries | null {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(keyOf(organizationId)) ?? "null"
    );
    return isDailySeries(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
