import { useCallback, useMemo, useRef } from "react";
import type { SaleDraft } from "./sale-draft-storage";

/**
 * The two instants kept with the cart in the tab. `startedAt` is set once, with the first change, and never moves:
 * the send attempt and the redo of a refused sale match the draft by it. `updatedAt` moves only when the person
 * changes the cart (`markEdited`); opening the cart again, or reading its prices again, leaves it where it was, so
 * the six hours after the last change are never renewed by looking at it.
 */
export function useSaleDraftStamps(restored: SaleDraft | null) {
  const startedAt = useRef<string | null>(restored?.startedAt ?? null);
  const updatedAt = useRef<string | null>(restored?.updatedAt ?? null);
  const markEdited = useCallback(() => {
    updatedAt.current = new Date().toISOString();
  }, []);
  const reset = useCallback(() => {
    startedAt.current = null;
    updatedAt.current = null;
  }, []);
  const stamp = useCallback(() => {
    startedAt.current ??= updatedAt.current ?? new Date().toISOString();
    updatedAt.current ??= startedAt.current;
    return { startedAt: startedAt.current, updatedAt: updatedAt.current };
  }, []);
  return useMemo(
    () => ({ markEdited, reset, stamp, startedAt }),
    [markEdited, reset, stamp]
  );
}
