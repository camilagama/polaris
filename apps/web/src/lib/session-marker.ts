import {
  browserStorage,
  type PreferenceStorage,
} from "./current-organization-model";

/**
 * Whether this browser ever held a session, so the app does not say "Sua sessão acabou" to someone who never
 * had one (U-01). One word of a closed list, never proof of access: the server decides every request.
 * "ativa": the app opened with a session here; "saiu": the person chose "Sair". Nothing: first visit.
 */
export const SESSION_MARKER_KEY = "polaris.sessionMarker";

export type SessionMarker = "ativa" | "saiu";

export function readSessionMarker(
  storage: PreferenceStorage | null = browserStorage()
): SessionMarker | null {
  try {
    const value = storage?.getItem(SESSION_MARKER_KEY);
    return value === "ativa" || value === "saiu" ? value : null;
  } catch {
    return null;
  }
}

export function writeSessionMarker(
  marker: SessionMarker,
  storage: PreferenceStorage | null = browserStorage()
): void {
  try {
    storage?.setItem(SESSION_MARKER_KEY, marker);
  } catch {
    // Without it the sign-in screen just opens without a reason.
  }
}

export function clearSessionMarker(
  storage: PreferenceStorage | null = browserStorage()
): void {
  try {
    storage?.removeItem(SESSION_MARKER_KEY);
  } catch {
    // Nothing to clean when storage is unavailable.
  }
}

/** The reason the sign-in screen says when the app opened with no session: only what really happened. */
export function openingReason(
  marker: SessionMarker | null
): "saiu" | "sessao" | undefined {
  if (marker === "ativa") {
    return "sessao";
  }
  return marker === "saiu" ? "saiu" : undefined;
}
