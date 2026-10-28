import type { PreferenceStorage } from "../lib/current-organization-model";
import {
  isPeriodSummary,
  previousWindowMemory,
  type StoredPeriodSummary,
} from "../lib/period-summary-cache";
import { readHomeCopy, writeHomeCopy } from "./home-copy";
import { type Period, storeToday } from "./home-model";

/**
 * The "janela anterior" (B) of the Início, taken from what the server last said instead of read again (ADR 0056,
 * emenda sobre a janela anterior). B is the days before the open month: it only changes with a late return, a late cancellation or an
 * expense with a past competence, so the Início reads it once per store's day. It is taken only when the copy was read
 * on the store's today and is of exactly the period asked for; any other copy is as good as none. The month and today
 * (A) are never taken from here, and neither is any other screen: Resultado, Histórico and Meta read the server.
 *
 * The copy lives in the page's memory (the runtime off, as in production today) and, with the runtime on, on the
 * device in the Início's own copy (`home-copy.ts`). A return or a cancellation made on this device of a sale from
 * before the open month takes it back at once (`invalidatePreviousWindow`); one made on another device, or in another
 * tab, shows only the next day, or on "Atualizar".
 */

/** Keeps B as the server just returned it, in the page's memory. The caller asks the guard (no refusal, no sign-out). */
export function rememberPreviousWindow(
  organizationId: string,
  summary: StoredPeriodSummary
): void {
  if (summary.daily !== undefined) {
    previousWindowMemory.set(organizationId, summary);
  }
}

/** The copy of B, from the page's memory or else from the device (unless it was taken back), or null. */
function keptPreviousWindow(
  storage: PreferenceStorage | null,
  organizationId: string
): StoredPeriodSummary | null {
  const remembered = previousWindowMemory.get(organizationId);
  if (isPeriodSummary(remembered)) {
    return remembered;
  }
  const copy = readHomeCopy(storage, organizationId);
  return copy && copy.beforeStale !== true ? copy.before : null;
}

/**
 * B in place of a read: the copy of the organization, only when it is of exactly `period` and was read on the store's
 * `today` (the day of its own `generatedAt`, in the store's time zone). Null otherwise.
 */
export function reusablePreviousWindow(
  storage: PreferenceStorage | null,
  organizationId: string,
  period: Period,
  today: string,
  timezone: string | null
): StoredPeriodSummary | null {
  const kept = keptPreviousWindow(storage, organizationId);
  if (
    kept === null ||
    kept.daily === undefined ||
    kept.period.from !== period.from ||
    kept.period.to !== period.to ||
    storeToday(kept.generatedAt, timezone) !== today
  ) {
    return null;
  }
  return kept;
}

/**
 * A return, a cancellation or an adjustment was made on this device on a sale of `saleDay` (the store's date of the
 * sale; null when it is not known): when that day is before the open month, B no longer says what the server does,
 * so the copy is taken back, in memory and on the device (it still shows without a connection, but is not reused).
 * A sale of the open month is in A, which is always read.
 */
export function invalidatePreviousWindow(
  storage: PreferenceStorage | null,
  organizationId: string,
  saleDay: string | null
): void {
  const kept = keptPreviousWindow(storage, organizationId);
  if (kept === null || (saleDay !== null && saleDay > kept.period.to)) {
    return;
  }
  previousWindowMemory.delete(organizationId);
  if (readHomeCopy(storage, organizationId)?.before) {
    writeHomeCopy(storage, organizationId, { beforeStale: true });
  }
}
