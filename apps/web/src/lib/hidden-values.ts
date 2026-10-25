import { useCallback, useSyncExternalStore } from "react";
import { browserStorage } from "./theme";

/**
 * "Esconder valores" (revisão de UI v7, § 6): a choice about who is around the screen, not about the account, so it is
 * kept on the device like the theme (`polaris-valores` in localStorage, one word of a closed list) and is the same on
 * the Início and on the Resultado. While it is on, every amount in reais is written "R$ ••••" and read "valor
 * escondido"; percents, counts and the shape of the charts stay.
 */
export const HIDDEN_VALUES_STORAGE_KEY = "polaris-valores";
const HIDDEN = "escondidos";

/** What an amount becomes on the screen, and what a screen reader says in its place. */
export const MASKED_MONEY = "R$ ••••";
export const MASKED_SPOKEN = "valor escondido";

/** An amount as `formatBrlAmount` writes it, with its sign: "R$ 1.234,56", "-R$ 12,00", "+R$ 436,86". */
const MONEY_TEXT = /[-+−]?R\$\s?[\d.]+,\d{2}/g;

export function readHiddenValues(
  storage: Pick<Storage, "getItem"> | undefined
): boolean {
  try {
    return storage?.getItem(HIDDEN_VALUES_STORAGE_KEY) === HIDDEN;
  } catch {
    // storage refused (private mode, policy): the values show
    return false;
  }
}

export function saveHiddenValues(
  storage: Pick<Storage, "removeItem" | "setItem"> | undefined,
  hidden: boolean
) {
  try {
    if (hidden) {
      storage?.setItem(HIDDEN_VALUES_STORAGE_KEY, HIDDEN);
    } else {
      storage?.removeItem(HIDDEN_VALUES_STORAGE_KEY);
    }
  } catch {
    // the choice lasts until the page closes
  }
}

/** A text with every amount in it written as "R$ ••••" (or `replacement`), the rest untouched. */
export function maskMoney(text: string, replacement = MASKED_MONEY): string {
  return text.replace(MONEY_TEXT, replacement);
}

/** A text cut into its plain parts and its amounts, so that each amount can be masked on its own. */
export function moneyParts(
  text: string
): Array<{ money: boolean; text: string }> {
  const parts: Array<{ money: boolean; text: string }> = [];
  let last = 0;
  for (const match of text.matchAll(MONEY_TEXT)) {
    const start = match.index ?? 0;
    if (start > last) {
      parts.push({ money: false, text: text.slice(last, start) });
    }
    parts.push({ money: true, text: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) {
    parts.push({ money: false, text: text.slice(last) });
  }
  return parts;
}

/* the choice of this page, shared by every component that reads it; the storage is read once, at the first read */
let current: boolean | null = null;
const listeners = new Set<() => void>();

function snapshot(): boolean {
  if (current === null) {
    current = readHiddenValues(browserStorage());
  }
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const fromOtherTab = (event: StorageEvent) => {
    if (event.key === HIDDEN_VALUES_STORAGE_KEY || event.key === null) {
      current = readHiddenValues(browserStorage());
      listener();
    }
  };
  window.addEventListener("storage", fromOtherTab);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", fromOtherTab);
  };
}

export function setHiddenValues(hidden: boolean) {
  saveHiddenValues(browserStorage(), hidden);
  current = hidden;
  for (const listener of listeners) {
    listener();
  }
}

/** Whether the amounts are hidden now, and the way to change it (kept on the device, the same in every screen). */
export function useHiddenValues(): [boolean, (hidden: boolean) => void] {
  const hidden = useSyncExternalStore(subscribe, snapshot, () => false);
  const set = useCallback((next: boolean) => setHiddenValues(next), []);
  return [hidden, set];
}
