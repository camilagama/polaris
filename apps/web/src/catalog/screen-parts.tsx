import { type ReactNode, useCallback, useState } from "react";
import { Button } from "@/ui/button";
import { focusLater } from "../lib/focus";
import { LIST_PAGE_SIZE, type ListPage, listPage } from "./list-page-model";

// biome-ignore lint/performance/noBarrelFile: the screens still import the list parts from this path; each folder moves to the `ListBlock` and drops its import
export { ListNotice } from "@/ui/list-notice";
export { ListTotalFooter } from "@/ui/list-total-footer";
export { RowTile } from "@/ui/row-tile";

/* The parts the list screens share (Categorias, Clientes, Produtos, Despesas, Estoque): the date as the lists write
   it, the rows drawn so far and the buttons of a row. */

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });

export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

/**
 * The rows of a long list drawn so far, and the step that draws the next page. Another `resetKey` (a search, a tab)
 * starts again from one page, also when it goes back to a key seen before.
 */
export function useListPage<T>(
  items: readonly T[],
  resetKey: string
): ListPage<T> & { loadMore: () => void } {
  const [page, setPage] = useState({ key: resetKey, size: LIST_PAGE_SIZE });
  const size = page.key === resetKey ? page.size : LIST_PAGE_SIZE;
  if (page.key !== resetKey) {
    setPage({ key: resetKey, size: LIST_PAGE_SIZE });
  }
  const loadMore = useCallback(
    () => setPage({ key: resetKey, size: size + LIST_PAGE_SIZE }),
    [resetKey, size]
  );
  return { ...listPage(items, size), loadMore };
}

type LoadMoreListProps =
  | {
      /** The id of the title of the `ListBlock` the button feeds: the focus goes to the first new row in its list. */
      listHeadingId: string;
      listLabel?: never;
    }
  | {
      listHeadingId?: never;
      /** The `aria-label` of a list that has no `ListBlock`. */
      listLabel: string;
    };

type LoadMoreButtonProps = LoadMoreListProps & {
  onClick: () => void;
  /** How many rows are drawn before the click: the index of the first new one. */
  shown: number;
};

/**
 * Below a list with more rows than drawn: the same button as the Estoque, here with no wait (the rows are on hand).
 * The focus moves to the first control of the first new row: the keyboard goes on reading where the list grew, and
 * on the last page, when the button leaves the page, the focus does not fall to the body.
 */
export function LoadMoreButton({
  listHeadingId,
  listLabel,
  onClick,
  shown,
}: LoadMoreButtonProps) {
  const handleClick = useCallback(() => {
    onClick();
    focusLater(() => {
      const list =
        listHeadingId === undefined
          ? `ul[aria-label="${listLabel}"]`
          : `ul[aria-labelledby="${listHeadingId}"]`;
      const rows = document.querySelectorAll(`${list} > li`);
      rows[shown]?.querySelector<HTMLElement>("button, a[href]")?.focus();
    });
  }, [listHeadingId, listLabel, onClick, shown]);
  return (
    <Button
      className="justify-self-start"
      onClick={handleClick}
      type="button"
      variant="outline"
    >
      Carregar mais
    </Button>
  );
}

interface RowOpenButtonProps {
  /**
   * The visible content of the row it opens: the circle, the name and the support line. Only the name is the
   * button's name ("Editar " comes first, for the screen reader alone); the circle and the support line are
   * `aria-hidden`, and the support line comes back as the description (`describedBy`).
   */
  children: ReactNode;
  /** The elements that describe the row (the support line) and, locked, the one that says why it does not open. */
  describedBy?: string | undefined;
  locked: boolean;
  onOpen: () => void;
}

/**
 * The part of a row that opens the item: a real button with the circle, the name and the support line, as tall as
 * the row and as wide as everything but the menu, so its own box is the touch area and draws the 3 px ring. What
 * acts or announces on its own (the menu, the link to Pendências, a status) stays out of it, beside or below,
 * never inside a button. Locked, it stays focusable and says why (`aria-disabled` with the reason).
 */
export function RowOpenButton({
  children,
  describedBy,
  locked,
  onOpen,
}: RowOpenButtonProps) {
  const handleClick = useCallback(() => {
    if (!locked) {
      onOpen();
    }
  }, [locked, onOpen]);
  return (
    <button
      aria-describedby={describedBy}
      aria-disabled={locked || undefined}
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md py-2.5 text-left focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-solid focus-visible:-outline-offset-3 aria-disabled:cursor-default"
      data-row-open=""
      onClick={handleClick}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * Name, support line and state of a configuration row. The state badge is the last child: from 40rem it sits at the
 * right end of the row; below that (a phone, or a large letter, since the breakpoint is in rem) it drops under the
 * text, at the left of the text column. The breakpoint, not the wrapping of the line, decides: a short badge such as
 * "Ativo" would still fit beside the text on a phone and the rows would not agree.
 */
export const ROW_BODY_CLASS =
  "flex min-w-0 flex-1 flex-col items-start gap-1 min-[40rem]:flex-row min-[40rem]:gap-3";
export const ROW_TEXT_CLASS =
  "grid min-w-0 gap-0.5 self-stretch min-[40rem]:flex-1";

/** A row that opens by a `RowOpenButton`: the hover of the whole row while the button under the pointer opens. */
export const OPENABLE_ROW_CLASS =
  "has-[[data-row-open]:not([aria-disabled]):hover]:bg-muted/50";
