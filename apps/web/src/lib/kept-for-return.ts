/**
 * What a screen kept (a draft closed by Esc) when the app took the person to another screen with no load of the page
 * ("Conhecer o Pro", corte 1.6 AC-7): the screen leaves the tree, and comes back to it by "voltar". Memory only, as
 * the drafts themselves: nothing is written to the browser, and a load of the page drops it.
 */
const kept = new Map<string, unknown>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Only while the app opens another screen for "Conhecer o Pro": a screen left any other way keeps nothing. */
let leaving = false;

/**
 * The app is about to open another screen with no load of the page: the screen that leaves the tree now keeps its
 * draft. The mark is used once, by that screen as it leaves (later, when the new screen's chunk loads first), or by
 * the next screen that looks for what was kept.
 */
export function leaveForReturn(): void {
  leaving = true;
}

/** Keeps the value for the next mount of the screen, while leaving for "Conhecer o Pro"; `null` drops what was kept. */
export function keepForReturn(key: string, value: unknown): void {
  if (!leaving) {
    return;
  }
  leaving = false;
  if (value === null) {
    kept.delete(key);
  } else {
    kept.set(key, value);
  }
  emit();
}

/** What was kept under the key, taken out (it comes back once). */
export function takeKept<T>(key: string): T | undefined {
  leaving = false;
  const value = kept.get(key) as T | undefined;
  if (kept.delete(key)) {
    emit();
  }
  return value;
}

/**
 * How many drafts wait to come back: a reload would drop them (they live in memory only), so the swap of the build
 * waits until the screen took them back (`pwa/swap-guard.ts`).
 */
export function keptCount(): number {
  return kept.size;
}

export function subscribeKept(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
