import { useEffect, useId, useSyncExternalStore } from "react";

/**
 * Which screens hold work that was typed or picked and not sent yet. Each screen says so itself, from
 * its own state (the sale cart, a stock or expense draft, a customer form): the shell does not guess
 * from the fields on the page. A field that still has its initial value is not work, and a cart built
 * only by taps and selections is. Memory only: nothing is written to the browser.
 */
const dirtySources = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Marks a source as holding unsent work; the returned function clears it. */
export function markUnsentWork(source: string): () => void {
  dirtySources.add(source);
  emit();
  return () => {
    dirtySources.delete(source);
    emit();
  };
}

export function hasUnsentWork(): boolean {
  return dirtySources.size > 0;
}

/** A screen's own sign that its form was changed and not sent. It clears when the screen leaves. */
export function useReportUnsentWork(dirty: boolean): void {
  const source = useId();
  useEffect(() => {
    if (!dirty) {
      return;
    }
    return markUnsentWork(source);
  }, [dirty, source]);
}

/** Whether any screen on the page holds work that is not sent (the session notice's warning). */
export function useHasUnsentWork(): boolean {
  return useSyncExternalStore(subscribe, hasUnsentWork);
}

/** Whether a draft differs from the one the form started with (compared field by field, as text or flags). */
export function isDraftChanged<T extends object>(
  draft: T,
  initial: T
): boolean {
  const current = draft as Record<string, unknown>;
  const start = initial as Record<string, unknown>;
  return Object.keys(start).some((key) => current[key] !== start[key]);
}
