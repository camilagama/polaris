import { readGoalsLink } from "./goal-model";

/**
 * The tab of the Resultado in the address (corte resultado-v2, AC-13): `aba=metas` is the Metas tab and no parameter is
 * the Resultado tab. The two links of the Início, `meta=nova` and `meta=lista`, imply the Metas tab and win when they
 * come together with `aba`. Changing tabs rewrites the address in place (`replaceState`): a reload keeps the tab and
 * the browser's "voltar" leaves the screen instead of walking between tabs.
 */
export type ResultTab = "metas" | "resultado";

const TAB_PARAMETER = "aba";

/** The tab an address opens: Metas for `aba=metas` or for either link of the Início, else Resultado. */
export function readResultTab(search: string): ResultTab {
  if (readGoalsLink(search) !== null) {
    return "metas";
  }
  return new URLSearchParams(search).get(TAB_PARAMETER) === "metas"
    ? "metas"
    : "resultado";
}

/** The path, query and hash of `href` with the tab written in: `aba=metas`, or no `aba` for the Resultado tab. */
export function addressWithTab(href: string, tab: ResultTab): string {
  const url = new URL(href);
  if (tab === "metas") {
    url.searchParams.set(TAB_PARAMETER, "metas");
  } else {
    url.searchParams.delete(TAB_PARAMETER);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Writes the tab into the address of the page without adding a step to the history. */
export function writeResultTab(tab: ResultTab): void {
  const next = addressWithTab(window.location.href, tab);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(window.history.state, "", next);
  }
}
