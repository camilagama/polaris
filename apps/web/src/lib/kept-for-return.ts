/**
 * What a screen kept (a draft closed by Esc) when the app took the person to another screen with no load of the page
 * ("Conhecer o Pro", corte 1.6 AC-7): the screen leaves the tree, and comes back to it by "voltar". Memory only, as
 * the drafts themselves: nothing is written to the browser, and a load of the page drops it.
 */
const kept = new Map<string, unknown>();

/** Keeps the value for the next mount of the screen; `null` drops what was kept. */
export function keepForReturn(key: string, value: unknown): void {
  if (value === null) {
    kept.delete(key);
  } else {
    kept.set(key, value);
  }
}

/** What was kept under the key, taken out (it comes back once). */
export function takeKept<T>(key: string): T | undefined {
  const value = kept.get(key) as T | undefined;
  kept.delete(key);
  return value;
}
