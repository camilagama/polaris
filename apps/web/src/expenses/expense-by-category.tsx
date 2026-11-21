import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Money } from "@/ui/money";
import { Skeleton } from "@/ui/skeleton";
import { formatBrlAmount } from "../lib/format";
import { useMotionLevel } from "../lib/motion-level";
import { type CategoryShareRow, categoryShareRows } from "./expense-model";
import type { ExpenseFilters, ExpenseListState } from "./use-expense-list";

const TITLE_ID = "expense-by-category-title";
const FIRST_SKELETON_LINES = 3;

/** Only the plain month of the active expenses is split by category: a category on the bar or the voided ones leave it out. */
export function showsCategoryBlock(filters: ExpenseFilters): boolean {
  return filters.categoryId === "" && filters.status === "active";
}

/**
 * The bar of a line: a drawing only (the name, the share and the amount are written beside it), in the one color of
 * the expenses in the bar of parts of the Resultado. On a desktop it grows from the left once when the lines are drawn;
 * on a phone and under reduced motion it is whole at once.
 */
function ShareBar({ width }: { width: number }) {
  const level = useMotionLevel();
  const [grown, setGrown] = useState(level !== "full");
  useEffect(() => {
    if (grown) {
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setGrown(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [grown]);
  return (
    <div
      aria-hidden="true"
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
      data-share-track=""
    >
      <div
        className="h-full origin-left rounded-full bg-(--chart-2) motion-full:transition-transform motion-full:duration-200 motion-full:ease-out"
        data-share-bar=""
        style={{ transform: `scaleX(${grown ? 1 : 0})`, width: `${width}%` }}
      />
    </div>
  );
}

interface ShareLineProps {
  onPick: (categoryId: string) => void;
  row: CategoryShareRow;
}

const LINE_CLASS = "grid w-full gap-1.5 rounded-md px-1 py-2 text-left";

/** Name on the left (it breaks), share and amount on the right (they do not); under them the bar. */
function ShareLineBody({
  action,
  row,
}: {
  /** The words only a screen reader hears before the name ("Filtrar por "), so the name of the button says what it does and still holds the text on screen. */
  action?: string;
  row: CategoryShareRow;
}) {
  return (
    <>
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 flex-1 basis-32 font-medium [overflow-wrap:anywhere]">
          {action ? <span className="sr-only">{action}</span> : null}
          {row.name}
        </span>
        <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
          <span className="text-muted-foreground text-support">
            {row.percent}%
          </span>
          <Money size="sm" text={formatBrlAmount(row.amount)} />
        </span>
      </span>
      <ShareBar width={row.width} />
    </>
  );
}

function ShareLine({ onPick, row }: ShareLineProps) {
  const { categoryId } = row;
  const handleClick = useCallback(() => {
    if (categoryId !== null) {
      onPick(categoryId);
    }
  }, [categoryId, onPick]);
  if (categoryId === null) {
    return (
      <li>
        <div className={cn(LINE_CLASS, "min-h-11")} data-share-line="">
          <ShareLineBody row={row} />
        </div>
      </li>
    );
  }
  return (
    <li>
      <button
        className={cn(
          LINE_CLASS,
          "focus-ring min-h-11 motion-full:transition-colors hover:bg-accent"
        )}
        data-share-line=""
        onClick={handleClick}
        type="button"
      >
        <ShareLineBody action="Filtrar por " row={row} />
      </button>
    </li>
  );
}

/** As many lines as the last split had (three on the first read), each as tall as a line of the split, so the list does not move. */
function ShareSkeleton({ lines }: { lines: number }) {
  return (
    <div aria-hidden="true" className="grid gap-1" data-share-skeleton="">
      {Array.from({ length: lines }, (_, index) => (
        <div className="grid min-h-11 gap-1.5 px-1 py-2" key={index}>
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

interface ExpenseByCategoryProps {
  categories: readonly ExpenseCategoryReadModel[];
  filters: ExpenseFilters;
  /** Applies the category to the filter bar of the list: the same filter the bar's own menu sets. */
  onPick: (categoryId: string) => void;
  state: ExpenseListState;
}

/**
 * "Por categoria": where the month's expenses went, the five largest categories and the rest in "Outras (N)", from
 * the same read as the list (the sum of the lines is the "Total do período"). It holds its height as lines of skeleton
 * while that read is open and leaves out of the page when there is nothing to split: a category chosen, the voided
 * ones, fewer than two categories, or an answer with no split.
 */
export function ExpenseByCategory({
  categories,
  filters,
  onPick,
  state,
}: ExpenseByCategoryProps) {
  const rows = useMemo(
    () => categoryShareRows(state.totalsByCategory, categories, state.total),
    [categories, state.total, state.totalsByCategory]
  );
  const lastLines = useRef(FIRST_SKELETON_LINES);
  useEffect(() => {
    if (rows) {
      lastLines.current = rows.length;
    }
  }, [rows]);
  if (!showsCategoryBlock(filters) || state.error !== null) {
    return null;
  }
  const reading = state.isLoading && rows === null;
  if (!(reading || rows)) {
    return null;
  }
  return (
    <Card aria-labelledby={TITLE_ID} role="region">
      <CardHeader>
        <CardTitle aria-level={2} id={TITLE_ID} role="heading">
          Por categoria
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows ? (
          <ul className="grid gap-1">
            {rows.map((row) => (
              <ShareLine key={row.key} onPick={onPick} row={row} />
            ))}
          </ul>
        ) : (
          <ShareSkeleton lines={lastLines.current} />
        )}
      </CardContent>
    </Card>
  );
}
