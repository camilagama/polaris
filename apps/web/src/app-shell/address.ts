import { useSyncExternalStore } from "react";

/**
 * The address of the page as the shell reads it. A tab is changed in place (`replaceState`, no step in the history),
 * and the browser says nothing of that: this event tells the shell, so the state chip and the notice of connection
 * follow the tab on screen (a tab that works offline beside one that needs the connection).
 */
const ADDRESS_EVENT = "polaris:address";

/** Rewrites the address in place (no step in the history) and tells the shell. */
export function replaceAddress(next: string): void {
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) {
    return;
  }
  window.history.replaceState(window.history.state, "", next);
  window.dispatchEvent(new Event(ADDRESS_EVENT));
}

function historyState(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null
    ? Object.fromEntries(Object.entries(state))
    : {};
}

/**
 * Adds a step to the history for an address of the same screen, with no scroll and no focus move (the caller places the
 * focus). `mark` is written in the entry's state, so `isMarkedEntry` tells later that this step was added by the screen
 * and the one before it is the screen's own list.
 */
export function pushAddress(next: string, mark: string): void {
  window.history.pushState({ [mark]: true }, "", next);
  window.dispatchEvent(new Event(ADDRESS_EVENT));
}

/** Whether the current history entry was added by `pushAddress` with this `mark`. */
export function isMarkedEntry(mark: string): boolean {
  return historyState()[mark] === true;
}

/**
 * Opens another screen of the app with no load of the page (corte 1.6, AC-7): a step in the history, so "voltar" comes
 * back, and the shell draws the screen of the new address. What lives in memory (a draft kept by Esc) stays.
 */
export function navigateInApp(next: string): void {
  window.history.pushState(null, "", next);
  window.dispatchEvent(new Event(ADDRESS_EVENT));
  window.scrollTo({ top: 0 });
  // the link that was clicked left with the screen: the focus starts again at the content, as on a load of the page
  window.setTimeout(() => {
    document.getElementById("conteudo")?.focus({ preventScroll: true });
  }, 0);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(ADDRESS_EVENT, onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener(ADDRESS_EVENT, onChange);
    window.removeEventListener("popstate", onChange);
  };
}

const pathAndQuery = () =>
  `${window.location.pathname}${window.location.search}`;

/** The pathname and the query of the page, kept current through `replaceAddress` and the browser's own steps. */
export function useAddress(): { pathname: string; search: string } {
  const address = useSyncExternalStore(subscribe, pathAndQuery);
  const queryStart = address.indexOf("?");
  return queryStart === -1
    ? { pathname: address, search: "" }
    : {
        pathname: address.slice(0, queryStart),
        search: address.slice(queryStart),
      };
}
