import type { PreferenceStorage } from "../lib/current-organization-model";

/**
 * The owner's closed stores this browser last heard of, by name, for the discreet line on the Início of the active
 * store. Only what was already read for another reason is kept (the panel of the closed store, and the `listClosed`
 * of an account with no active store): the Início never reads it from the server (the Workers Free plan counts each
 * call). It is a convenience for one line, never proof of anything: "Ver" opens the panel, which reads the server.
 */
export const CLOSED_STORES_KEY = "polaris.closedStores";

export interface RememberedClosedStore {
  id: string;
  name: string;
}

function isRemembered(value: unknown): value is RememberedClosedStore {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.name === "string" &&
    row.name.length > 0
  );
}

export function readClosedStores(
  storage: PreferenceStorage | null
): RememberedClosedStore[] {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(CLOSED_STORES_KEY) ?? "[]"
    );
    return Array.isArray(parsed) ? parsed.filter(isRemembered) : [];
  } catch {
    return [];
  }
}

function write(
  storage: PreferenceStorage | null,
  stores: readonly RememberedClosedStore[]
): void {
  try {
    if (stores.length === 0) {
      storage?.removeItem(CLOSED_STORES_KEY);
      return;
    }
    storage?.setItem(
      CLOSED_STORES_KEY,
      JSON.stringify(stores.map(({ id, name }) => ({ id, name })))
    );
  } catch {
    // without it only the line on the Início is missing
  }
}

/** What the server listed is the whole list now; a purged store has nothing left to see. */
export function rememberClosedStores(
  storage: PreferenceStorage | null,
  stores: readonly (RememberedClosedStore & { phase?: string })[]
): void {
  write(
    storage,
    stores.filter((store) => store.phase !== "purged")
  );
}

/** One store read on its own: kept, replaced, or forgotten when the server no longer has it closed (or purged it). */
export function rememberClosedStore(
  storage: PreferenceStorage | null,
  id: string,
  store: (RememberedClosedStore & { phase?: string }) | null
): void {
  const others = readClosedStores(storage).filter((item) => item.id !== id);
  write(
    storage,
    store === null || store.phase === "purged" ? others : [...others, store]
  );
}

export function clearClosedStores(storage: PreferenceStorage | null): void {
  try {
    storage?.removeItem(CLOSED_STORES_KEY);
  } catch {
    // nothing to clean when storage is unavailable
  }
}

/** The closed stores to mention beside the active ones: never one the server lists as active again. */
export function closedStoresBeside(
  remembered: readonly RememberedClosedStore[],
  activeIds: readonly string[]
): RememberedClosedStore[] {
  return remembered.filter((store) => !activeIds.includes(store.id));
}

export const CLOSED_STORE_LINE_LINK = "Ver";

export function closedStoreLineText(name: string): string {
  return `Você também tem uma loja encerrada: ${name}.`;
}
