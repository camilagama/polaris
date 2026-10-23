import type {
  ExpenseCategoryReadModel,
  ExpenseReadModel,
} from "@polaris/contracts";
import { type MouseEvent, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import { ExpenseCategorySelect, ListNote, LoadError } from "./expense-fields";
import { expenseGroupLabel, formatMonthLabel } from "./expense-model";
import { MonthPicker } from "./month-picker";
import type {
  ExpenseFilters,
  ExpenseListState,
  ExpenseStatusFilter,
} from "./use-expense-list";

const statusTabs: ReadonlyArray<readonly [ExpenseStatusFilter, string]> = [
  ["active", "Ativas"],
  ["voided", "Anuladas"],
];

function isStatusFilter(
  value: string | undefined
): value is ExpenseStatusFilter {
  return value === "active" || value === "voided";
}

interface ExpenseFiltersBarProps {
  categories: readonly ExpenseCategoryReadModel[];
  filters: ExpenseFilters;
  onChange: (filters: ExpenseFilters) => void;
}

/** Month, category and status of the list. */
export function ExpenseFiltersBar({
  categories,
  filters,
  onChange,
}: ExpenseFiltersBarProps) {
  const { categoryId, month, status } = filters;

  const handleMonth = useCallback(
    (value: string) => onChange({ ...filters, month: value }),
    [filters, onChange]
  );
  const handleStatus = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const value = event.currentTarget.dataset.expenseStatus;
      if (isStatusFilter(value)) {
        onChange({ ...filters, status: value });
      }
    },
    [filters, onChange]
  );
  const handleCategory = useCallback(
    (value: string) => onChange({ ...filters, categoryId: value }),
    [filters, onChange]
  );

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 min-[30rem]:grid-cols-[auto_minmax(0,1fr)] min-[30rem]:items-end">
        <MonthPicker
          id="expense-month"
          label="Mês de competência"
          month={month}
          onChange={handleMonth}
        />
        <ExpenseCategorySelect
          allLabel="Todas as categorias"
          categories={categories}
          id="expense-category-filter"
          label="Categoria"
          onChange={handleCategory}
          value={categoryId}
        />
      </div>
      {/* Active or voided: a line under the selected one, the buttons say which is pressed (as in Produtos) */}
      <nav
        aria-label="Situação das despesas"
        className="flex gap-4 border-border border-b"
      >
        {statusTabs.map(([value, label]) => (
          <button
            aria-pressed={status === value}
            className="focus-ring touch-hit relative -mb-px inline-flex h-ctl-lg items-center border-transparent border-b-2 font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-foreground aria-pressed:text-foreground"
            data-expense-status={value}
            key={value}
            onClick={handleStatus}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function countLabel(count: number): string {
  return count === 1 ? "1 despesa" : `${count} despesas`;
}

interface ExpenseSummaryProps {
  filters: ExpenseFilters;
  state: ExpenseListState;
}

/** The month total comes from the server: it covers every page, not only what is loaded. */
export function ExpenseSummary({ filters, state }: ExpenseSummaryProps) {
  const showTotal = !state.isLoading || state.expenses.length > 0;
  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2.5"
    >
      <div className="grid gap-0.5">
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Total do período
          {filters.status === "voided" ? " (anuladas)" : ""}
        </p>
        <p className="font-semibold text-value-lg tabular-nums">
          {showTotal ? formatBrlAmount(state.total) : "…"}
        </p>
      </div>
      <p className="text-muted-foreground text-support">
        {formatMonthLabel(filters.month)}
        {showTotal ? ` · ${countLabel(state.count)}` : ""}
      </p>
    </div>
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
  const handleVoid = useCallback(() => onVoid(expense), [expense, onVoid]);
  const handleRestore = useCallback(
    () => onRestore(expense),
    [expense, onRestore]
  );
  const isBusy = busyKey !== null;
  const thisBusy = busyKey?.endsWith(expense.id) ?? false;

  return (
    <article className="grid gap-x-4 gap-y-2 py-3 min-[30rem]:grid-cols-[minmax(0,1fr)_auto] min-[30rem]:items-center">
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
          {expense.categoryName} · {expenseGroupLabel(expense.categoryGroup)}
        </p>
        <p className="text-muted-foreground text-support [overflow-wrap:anywhere]">
          Competência {formatCalendarDate(expense.competenceOn)}
          {expense.payee ? ` · ${expense.payee}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 min-[30rem]:justify-end">
        <p
          className={cn(
            "whitespace-nowrap font-semibold text-value-md tabular-nums",
            voided && "text-muted-foreground line-through"
          )}
        >
          {formatBrlAmount(expense.amount)}
        </p>
        <div className="flex gap-2">
          {voided ? (
            <Button
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
                disabled={isBusy}
                onClick={handleEdit}
                size="sm"
                type="button"
                variant="outline"
              >
                Editar
              </Button>
              <Button
                aria-label={`Anular despesa ${expense.description}`}
                disabled={isBusy}
                onClick={handleVoid}
                size="sm"
                type="button"
                variant="outline"
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
  onEdit: (expense: ExpenseReadModel) => void;
  onLoadMore: () => void;
  onRestore: (expense: ExpenseReadModel) => void;
  onRetry: () => void;
  onVoid: (expense: ExpenseReadModel) => void;
  state: ExpenseListState;
}

function emptyText(filters: ExpenseFilters): string {
  if (filters.status === "voided") {
    return "Nenhuma despesa anulada neste período.";
  }
  return "Nenhuma despesa neste período. Use o formulário para registrar a primeira.";
}

export function ExpenseList({
  busyKey,
  filters,
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
        <ListNote loading>Carregando despesas…</ListNote>
      ) : null}
      {!isLoading && expenses.length === 0 && state.error === null ? (
        <ListNote>{emptyText(filters)}</ListNote>
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
