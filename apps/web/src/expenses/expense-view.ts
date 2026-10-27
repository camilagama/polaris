import { useCallback, useLayoutEffect } from "react";
import { replaceAddress, useAddress } from "../app-shell/address";

/**
 * The three parts of the Despesas tab, side by side in a segmented list (UI-H): the expenses of the month, the
 * recurring rules and the categories. The part on screen is in the address (`?ver=`), so a link opens it.
 */
export const EXPENSE_VIEWS = [
  { label: "Lançamentos", value: "lancamentos" },
  { label: "Recorrentes", value: "recorrentes" },
  { label: "Categorias", value: "categorias" },
] as const;

export type ExpenseView = (typeof EXPENSE_VIEWS)[number]["value"];

const VIEW_PARAMETER = "ver";

function isExpenseView(value: unknown): value is ExpenseView {
  return EXPENSE_VIEWS.some((view) => view.value === value);
}

/**
 * The part the address asks for. No `ver` opens Lançamentos; a value that is no part (`?ver=xyz`) opens Lançamentos
 * too, and says the address must be rewritten.
 */
export function openedExpenseView(search: string): {
  rewrite: boolean;
  value: ExpenseView;
} {
  const named = new URLSearchParams(search).get(VIEW_PARAMETER);
  if (named === null) {
    return { rewrite: false, value: "lancamentos" };
  }
  return isExpenseView(named)
    ? { rewrite: false, value: named }
    : { rewrite: true, value: "lancamentos" };
}

/** The path, query and hash of `href` with the part written in; Lançamentos, the first, is no `ver` at all. */
export function addressWithExpenseView(
  href: string,
  value: ExpenseView
): string {
  const url = new URL(href, "https://polaris.invalid");
  if (value === EXPENSE_VIEWS[0].value) {
    url.searchParams.delete(VIEW_PARAMETER);
  } else {
    url.searchParams.set(VIEW_PARAMETER, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The part on screen and the way to change it. Both rewrite the address in place (`replaceAddress`, no step in the
 * history), as the tabs of a screen do: "voltar" leaves the screen, and an invalid `ver` is corrected before the
 * effects of a form dialog push their entry.
 */
export function useExpenseView(): [ExpenseView, (next: unknown) => void] {
  const { search } = useAddress();
  const { rewrite, value } = openedExpenseView(search);
  useLayoutEffect(() => {
    if (rewrite) {
      replaceAddress(addressWithExpenseView(window.location.href, value));
    }
  }, [rewrite, value]);
  const select = useCallback((next: unknown) => {
    if (isExpenseView(next)) {
      replaceAddress(addressWithExpenseView(window.location.href, next));
    }
  }, []);
  return [value, select];
}
