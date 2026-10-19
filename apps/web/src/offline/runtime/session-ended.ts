import { useSyncExternalStore } from "react";

/**
 * Set when the server said, in answer to "Revogar", that this browser's own
 * session was ended too. It lives only in memory: the screen is rebuilt when the
 * organizations are read again, and it must not ask the dead session for the
 * list or forget what happened. Nothing is written to the browser.
 */
export interface SessionEndedHere {
  /** There was work queued on this browser when the session ended. */
  keptWork: boolean;
}

let ended: SessionEndedHere | null = null;
let over = false;
const listeners = new Set<() => void>();

/** The server said the session is over (a 401 in answer to a screen's own call). */
export function markSessionOver(): void {
  over = true;
}

/** Whether this page already knows the session is over, so it must not read what needs one. */
export function isSessionOver(): boolean {
  return over || ended !== null;
}

export function markSessionEndedHere(state: SessionEndedHere): void {
  over = true;
  ended = state;
  for (const listener of listeners) {
    listener();
  }
}

function sessionEndedHere(): SessionEndedHere | null {
  return ended;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSessionEndedHere(): SessionEndedHere | null {
  return useSyncExternalStore(subscribe, sessionEndedHere);
}
