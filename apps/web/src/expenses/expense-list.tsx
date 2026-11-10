import type { ExpenseReadModel } from "@polaris/contracts";
import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { Money } from "@/ui/money";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { ListTotalFooter } from "../catalog/screen-parts";
import { useConnectionOnline } from "../lib/browser-connection";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import { sumBrlAmounts } from "../lib/sum-brl";
import {
  LIST_NOTE_MIN_HEIGHT_CLASS,
  ListNote,
  LoadError,
} from "./expense-fields";
import { formatMonthLabel } from "./expense-model";
import type { ExpenseFilters, ExpenseListState } from "./use-expense-list";

function countLabel(count: number): string {
  return count === 1 ? "1 despesa" : `${count} despesas`;
}

function loadedCountLabel(count: number, hasMore: boolean): string {
  return `${countLabel(count)}${hasMore ? " · há mais" : ""}`;
}

interface ExpenseSummaryProps {
  filters: ExpenseFilters;
  state: ExpenseListState;
}

/** The total comes from the server: it covers every page, not only what is loaded. It opens the card of the list; the count is its `role="status"`. */
export function ExpenseSummary({ filters, state }: ExpenseSummaryProps) {
  const showTotal = !state.isLoading || state.expenses.length > 0;
  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1"
      role="status"
    >
      <div className="grid gap-0.5">
        <p className="font-medium text-muted-foreground text-support">
          Total do período
          {filters.status === "voided" ? " (anuladas)" : ""}
        </p>
        <p className="min-h-[2.125rem] touch:min-h-[1.9375rem] font-semibold">
          {showTotal ? (
            <Money size="lg" text={formatBrlAmount(state.total)} />
          ) : (
            "…"
          )}
        </p>
      </div>
      <p className="text-muted-foreground text-support">
        {showTotal ? countLabel(state.count) : ""}
        <span className="sr-only"> em {formatMonthLabel(filters.month)}</span>
      </p>
    </div>
  );
}

/**
 * From 30 rem the buttons of a row have a fixed width (12 rem, enough for "Editar" and "Anulando…" and for
 * "Reativando…"), so the figures end in the same x on every row. The total ends there too: the buttons, the 12 px
 * gap of the row less the 1 px border of the box, as padding on the right. The `md:` copy stays: the box has its own
 * `md:px-4`, which would win over the `min-[30rem]` one from 48 rem.
 */
const ACTIONS_WIDTH = "min-[30rem]:w-48";
const TOTAL_UNDER_VALUES =
  "min-[30rem]:pr-[calc(12rem+0.6875rem)] md:pr-[calc(12rem+0.6875rem)]";

/**
 * The total of the rows loaded, under them: the sum the eye does down the column. The "Total do período" above is the
 * server's and covers every page; this one is what is on the screen, so with "Carregar mais" pending they differ
 * and the count says "há mais", as the sales history does.
 */
function ExpenseListTotal({ state }: { state: ExpenseListState }) {
  const unknown = state.isLoading && state.expenses.length === 0;
  const failed = state.error !== null && state.expenses.length === 0;
  const sum = sumBrlAmounts(state.expenses.map((expense) => expense.amount));
  let value = "—";
  if (unknown) {
    value = "…";
  } else if (sum !== null && !failed) {
    value = formatBrlAmount(sum);
  }
  return (
    <ListTotalFooter
      className={cn("rounded-lg border", TOTAL_UNDER_VALUES)}
      count={
        unknown || failed
          ? ""
          : loadedCountLabel(state.expenses.length, state.nextCursor !== null)
      }
      value={value}
    />
  );
}

interface ExpenseCardProps {
  busyKey: string | null;
  expense: ExpenseReadModel;
  onEdit: (expense: ExpenseReadModel) => void;
  onRestore: (expense: ExpenseReadModel) => void;
  onVoid: (expense: ExpenseReadModel) => void;
}

function ExpenseCard({
  busyKey,
  expense,
  onEdit,
  onRestore,
  onVoid,
}: ExpenseCardProps) {
  const voided = expense.status === "voided";
  const handleEdit = useCallback(() => onEdit(expense), [expense, onEdit]);
  const online = useConnectionOnline();
  const handleVoid = useCallback(() => onVoid(expense), [expense, onVoid]);
  const handleRestore = useCallback(
    () => onRestore(expense),
    [expense, onRestore]
  );
  const isBusy = busyKey !== null;
  const thisBusy = busyKey?.endsWith(expense.id) ?? false;

  return (
    <article
      className="grid gap-x-4 gap-y-2 py-3 min-[30rem]:grid-cols-[minmax(0,1fr)_auto] min-[30rem]:items-center"
      data-expense-id={expense.id}
    >
      <div className="grid min-w-0 gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3
            className={cn(
              "font-medium [overflow-wrap:anywhere]",
              voided && "text-muted-foreground"
            )}
          >
            {expense.description}
          </h3>
          {voided ? <Badge variant="warning">Anulada</Badge> : null}
          {expense.recurringRuleId ? (
            <Badge title="Lançada automaticamente por uma despesa recorrente">
              Recorrente
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-support [overflow-wrap:anywhere]">
          {expense.categoryName} · {formatCalendarDate(expense.competenceOn)}
          {expense.payee ? ` · ${expense.payee}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 min-[30rem]:justify-end">
        <p
          className={cn(
            "font-semibold tabular-nums",
            voided && "text-muted-foreground line-through"
          )}
        >
          <Money size="md" text={formatBrlAmount(expense.amount)} />
        </p>
        <div
          className={cn(
            "flex items-center gap-2 touch:gap-3 min-[30rem]:justify-end",
            ACTIONS_WIDTH
          )}
        >
          {voided ? (
            <Button
              {...connectionControlProps(online)}
              aria-label={`Reativar despesa ${expense.description}`}
              disabled={isBusy}
              onClick={handleRestore}
              size="sm"
              type="button"
              variant="outline"
            >
              {thisBusy ? "Reativando…" : "Reativar"}
            </Button>
          ) : (
            <>
              <Button
                aria-label={`Editar despesa ${expense.description}`}
                data-expense-edit=""
                disabled={isBusy}
                onClick={handleEdit}
                size="sm"
                type="button"
                variant="outline"
              >
                Editar
              </Button>
              <Button
                {...connectionControlProps(online)}
                aria-label={`Anular despesa ${expense.description}`}
                className="ml-3 text-destructive hover:text-destructive"
                disabled={isBusy}
                onClick={handleVoid}
                size="sm"
                type="button"
                variant="ghost"
              >
                {thisBusy ? "Anulando…" : "Anular"}
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

interface ExpenseListProps {
  busyKey: string | null;
  filters: ExpenseFilters;
  onClearFilters: () => void;
  onEdit: (expense: ExpenseReadModel) => void;
  onLoadMore: () => void;
  onRestore: (expense: ExpenseReadModel) => void;
  onRetry: () => void;
  onVoid: (expense: ExpenseReadModel) => void;
  state: ExpenseListState;
}

/** With a filter on, the way out is the button: the sentence alone made the person find the pills and take them out. */
function EmptyExpenses({
  filters,
  onClearFilters,
}: {
  filters: ExpenseFilters;
  onClearFilters: () => void;
}) {
  const narrowed = filters.categoryId !== "" || filters.status !== "active";
  if (!narrowed) {
    return <EmptyState afterRead bare title="Nenhuma despesa neste período." />;
  }
  return (
    <EmptyState
      afterRead
      bare
      title="Nenhuma despesa encontrada com estes filtros."
    >
      <Button onClick={onClearFilters} type="button" variant="outline">
        Limpar filtros
      </Button>
    </EmptyState>
  );
}

/** The empty list reserves the loading box's height, so the list that arrives empty does not push the screen. */
const EMPTY_BOX_CLASS = `grid ${LIST_NOTE_MIN_HEIGHT_CLASS} content-center`;

export function ExpenseList({
  busyKey,
  filters,
  onClearFilters,
  onEdit,
  onLoadMore,
  onRestore,
  onRetry,
  onVoid,
  state,
}: ExpenseListProps) {
  const { expenses, isLoading } = state;
  return (
    <div aria-busy={isLoading} className="grid gap-2">
      {state.error ? (
        <LoadError
          busy={isLoading || state.isLoadingMore}
          message={state.error}
          onRetry={onRetry}
        />
      ) : null}
      {isLoading && expenses.length === 0 ? (
        <div className={EMPTY_BOX_CLASS}>
          <ListNote loading>Carregando despesas…</ListNote>
        </div>
      ) : null}
      {!isLoading && expenses.length === 0 && state.error === null ? (
        <div className={`${EMPTY_BOX_CLASS} py-4`}>
          <EmptyExpenses filters={filters} onClearFilters={onClearFilters} />
        </div>
      ) : null}
      {expenses.length > 0 ? (
        <ul className="divide-y">
          {expenses.map((expense) => (
            <li key={expense.id}>
              <ExpenseCard
                busyKey={busyKey}
                expense={expense}
                onEdit={onEdit}
                onRestore={onRestore}
                onVoid={onVoid}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <ExpenseListTotal state={state} />
      {state.nextCursor === null ? null : (
        <div className="flex justify-center pt-2">
          <Button
            disabled={state.isLoadingMore || busyKey !== null}
            onClick={onLoadMore}
            type="button"
            variant="outline"
          >
            {state.isLoadingMore ? "Carregando…" : "Carregar mais"}
          </Button>
        </div>
      )}
    </div>
  );
}
