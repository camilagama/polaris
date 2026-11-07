/**
 * Which writes made the result of a period older than the read the Resultado holds. A part of the app that changes
 * what `report.periodSummary` adds up (an expense, a recurring rule) calls `markPeriodSummaryStale()` once the server
 * accepted it; the Resultado reads again when it is next in front, and not before. A counter, not a flag: a write
 * that lands while a read is on its way still counts, because the read started before it.
 */

let version = 0;
const listeners = new Set<() => void>();

export function markPeriodSummaryStale(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function periodSummaryStaleVersion(): number {
  return version;
}

export function subscribePeriodSummaryStale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
