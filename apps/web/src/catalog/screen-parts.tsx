import { type ReactNode, useCallback, useState } from "react";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { focusLater } from "../lib/focus";
import { LIST_PAGE_SIZE, type ListPage, listPage } from "./list-page-model";

/* The parts the list screens share (Categorias, Clientes, Produtos, Despesas, Estoque): the state choice under the
   title, the card that says loading, empty or no result, and the date as the lists write it. */

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });

export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

interface StatusNavProps<T extends string> {
  /** The tabs cannot change while an action runs. */
  disabled?: boolean | undefined;
  label: string;
  onSelect: (value: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
}

/**
 * The states of a list as tabs (the Tabs of `src/ui`): arrows move to the next tab and choose it, Tab leaves the
 * group, and the screen reader hears "aba, selecionada". The tabs have no panel of their own: the list below them
 * is the screen's.
 */
export function StatusNav<T extends string>({
  disabled = false,
  label,
  onSelect,
  options,
  value,
}: StatusNavProps<T>) {
  const handleChange = useCallback(
    (next: unknown) => {
      const chosen = options.find(([option]) => option === next);
      if (chosen) {
        onSelect(chosen[0]);
      }
    },
    [onSelect, options]
  );
  return (
    <Tabs onValueChange={handleChange} value={value}>
      <TabsList activateOnFocus aria-label={label}>
        {options.map(([option, text]) => (
          <TabsTrigger disabled={disabled} key={option} value={option}>
            {text}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** Loading, empty or no result of a list: a card with a few words, and what to do next when there is one. */
export function ListNotice({ children }: { children: ReactNode }) {
  return (
    <Card className="py-6">
      <div className="grid justify-items-center gap-3 px-4 text-center">
        {children}
      </div>
    </Card>
  );
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

/**
 * The count above a list ("1.248 produtos"), read before the rows. The line stays while the list loads and while a
 * search finds nothing, empty, so the rows do not move when the number arrives and the live region is already
 * there to announce it; it takes no room only when the list has no row at all (`shown` false).
 */
export function ListCountLine({
  shown,
  text,
}: {
  shown: boolean;
  text: string | null;
}) {
  if (!shown) {
    return null;
  }
  return (
    <p
      aria-live="polite"
      className="min-h-5 text-muted-foreground text-support"
    >
      {text}
    </p>
  );
}

interface LoadMoreButtonProps {
  /** The `aria-label` of the list the button feeds: the focus goes to the first new row in it. */
  listLabel: string;
  onClick: () => void;
  /** How many rows are drawn before the click: the index of the first new one. */
  shown: number;
}

/**
 * Below a list with more rows than drawn: the same button as the Estoque, here with no wait (the rows are on hand).
 * The focus moves to the first control of the first new row: the keyboard goes on reading where the list grew, and
 * on the last page, when the button leaves the page, the focus does not fall to the body.
 */
export function LoadMoreButton({
  listLabel,
  onClick,
  shown,
}: LoadMoreButtonProps) {
  const handleClick = useCallback(() => {
    onClick();
    focusLater(() => {
      const rows = document.querySelectorAll(
        `ul[aria-label="${listLabel}"] > li`
      );
      rows[shown]?.querySelector<HTMLElement>("button, a[href]")?.focus();
    });
  }, [listLabel, onClick, shown]);
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

/** A row that opens by a `RowOpenButton`: the hover of the whole row while the button under the pointer opens. */
export const OPENABLE_ROW_CLASS =
  "has-[[data-row-open]:not([aria-disabled]):hover]:bg-muted/50";
