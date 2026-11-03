import { type ReactNode, useCallback, useState } from "react";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
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
 * The count above a list ("1.248 produtos"), read before the rows. While the list loads the line is there and
 * empty, so the rows do not move when the number arrives; with no text and nothing loading it takes no room.
 */
export function ListCountLine({
  loading,
  text,
}: {
  loading: boolean;
  text: string | null;
}) {
  if (!(loading || text)) {
    return null;
  }
  return (
    <p
      aria-live="polite"
      className="min-h-5 text-muted-foreground text-support"
    >
      {loading ? null : text}
    </p>
  );
}

/** Below a list with more rows than drawn: the same button as the Estoque, here with no wait (the rows are on hand). */
export function LoadMoreButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      className="justify-self-start"
      onClick={onClick}
      type="button"
      variant="outline"
    >
      Carregar mais
    </Button>
  );
}

interface RowOpenButtonProps {
  /** Read before the name, only by the screen reader: "Editar" makes "Editar Ana Lima". */
  action: string;
  /** The element that says why the row does not open, when it is locked. */
  describedBy?: string | undefined;
  locked: boolean;
  name: string;
  onOpen: () => void;
}

/**
 * The name of a row as the button that opens it, stretched over the whole row (the `li` is `relative`): tapping
 * anywhere on the row opens the item, while the menu and the links of the row stay their own controls beside it,
 * never inside a button. Locked, it stays focusable and says why (`aria-disabled` with the reason).
 */
export function RowOpenButton({
  action,
  describedBy,
  locked,
  name,
  onOpen,
}: RowOpenButtonProps) {
  const handleClick = useCallback(() => {
    if (!locked) {
      onOpen();
    }
  }, [locked, onOpen]);
  return (
    <button
      aria-describedby={locked ? describedBy : undefined}
      aria-disabled={locked || undefined}
      className="w-fit cursor-pointer text-left font-medium outline-none [overflow-wrap:anywhere] after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:outline-3 focus-visible:after:outline-ring focus-visible:after:-outline-offset-3 aria-disabled:cursor-default"
      data-row-open=""
      onClick={handleClick}
      type="button"
    >
      <span className="sr-only">{action} </span>
      {name}
    </button>
  );
}

/** The row of a list that opens by a `RowOpenButton`: the ground of the stretched button, and the hover of an open row. */
export const OPENABLE_ROW_CLASS =
  "relative has-[[data-row-open]:not([aria-disabled]):hover]:bg-muted/50";
