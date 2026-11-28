import type { ExpenseReadModel } from "@polaris/contracts";
import MoreHorizontalIcon from "lucide-react/dist/esm/icons/ellipsis";
import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { ListBlock } from "@/ui/list-block";
import { Money } from "@/ui/money";
import { Skeleton } from "@/ui/skeleton";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import {
  formatBrlAmount,
  formatCalendarDate,
  formatQuantity,
} from "../lib/format";
import { sumBrlAmounts } from "../lib/sum-brl";
import { LoadError } from "./expense-fields";
import { formatMonthLabel } from "./expense-model";
import type { ExpenseFilters, ExpenseListState } from "./use-expense-list";

function countLabel(count: number): string {
  return count === 1 ? "1 despesa" : `${formatQuantity(count)} despesas`;
}

function loadedCountLabel(count: number, hasMore: boolean): string {
  return `${countLabel(count)}${hasMore ? " · há mais" : ""}`;
}

interface PeriodTotalProps {
  filters: ExpenseFilters;
  state: ExpenseListState;
}

/** The "Total do período" comes from the server: it covers every page, not only what is loaded. It is the first line of the panel. */
function PeriodTotal({ filters, state }: PeriodTotalProps) {
  const showTotal = !state.isLoading || state.expenses.length > 0;
  return (
    <>
      <div className="grid gap-0.5">
        <p className="font-medium text-muted-foreground text-support">
          Total do período
          {filters.status === "voided" ? " (anuladas)" : ""}
        </p>
        <p className="min-h-[2.125rem] touch:min-h-[1.9375rem] font-semibold text-foreground">
          {showTotal ? (
            <Money size="lg" text={formatBrlAmount(state.total)} />
          ) : (
            "…"
          )}
        </p>
      </div>
      <span className="sr-only"> em {formatMonthLabel(filters.month)}</span>
    </>
  );
}

/**
 * From 30 rem the buttons of a row have a fixed width (12 rem, enough for "Editar" and its menu and for
 * "Reativando…"), so the figures end in the same x on every row. The total ends there too: the buttons, the 12 px gap
 * of the row and the edge of the panel, as padding on the right. The `md:` copy stays: the panel has its own `md:px-4`,
 * which would win over the `min-[30rem]` one from 48 rem.
 */
const ACTIONS_WIDTH = "min-[30rem]:w-48";
const TOTAL_UNDER_VALUES =
  "min-[30rem]:pr-[calc(12rem+0.75rem+0.625rem)] md:pr-[calc(12rem+0.75rem+1rem)]";

/**
 * The total of the rows loaded, last in the panel: the sum the eye does down the column. The "Total do período"
 * above is the server's and covers every page; this one is what is on the screen, so with "Carregar mais" pending
 * they differ and the count says "há mais", as the sales history does.
 */
function loadedTotal(state: ExpenseListState) {
  const unknown = state.isLoading && state.expenses.length === 0;
  const sum = sumBrlAmounts(state.expenses.map((expense) => expense.amount));
  let value = "—";
  if (unknown) {
    value = "…";
  } else if (sum !== null) {
    value = formatBrlAmount(sum);
  }
  return (
    <ListBlock.Total
      className={TOTAL_UNDER_VALUES}
      count={
        unknown
          ? ""
          : loadedCountLabel(state.expenses.length, state.nextCursor !== null)
      }
      value={value}
      valueLoading={unknown}
    />
  );
}

interface VoidMenuProps {
  expense: ExpenseReadModel;
  isBusy: boolean;
  onVoid: (expense: ExpenseReadModel) => void;
}

/** Anular is the one destructive action of a row: it lives in the "…" menu, and without a connection it stays in the menu, off, with its reason. */
function VoidMenu({ expense, isBusy, onVoid }: VoidMenuProps) {
  const online = useConnectionOnline();
  const handleVoid = useCallback(() => {
    if (online) {
      onVoid(expense);
    }
  }, [expense, online, onVoid]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Mais ações para ${expense.description}`}
            disabled={isBusy}
            size="icon"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem
          {...connectionControlProps(online)}
          aria-label={`Anular despesa ${expense.description}`}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          closeOnClick={online}
          onClick={handleVoid}
          variant="destructive"
        >
          Anular
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ExpenseRowProps {
  busyKey: string | null;
  expense: ExpenseReadModel;
  onEdit: (expense: ExpenseReadModel) => void;
  onRestore: (expense: ExpenseReadModel) => void;
  onVoid: (expense: ExpenseReadModel) => void;
}

function ExpenseRow({
  busyKey,
  expense,
  onEdit,
  onRestore,
  onVoid,
}: ExpenseRowProps) {
  const voided = expense.status === "voided";
  const handleEdit = useCallback(() => onEdit(expense), [expense, onEdit]);
  const online = useConnectionOnline();
  const handleRestore = useCallback(
    () => onRestore(expense),
    [expense, onRestore]
  );
  const isBusy = busyKey !== null;
  const voiding = busyKey === `void:${expense.id}`;
  const restoring = busyKey === `restore:${expense.id}`;

  return (
    <ListBlock.Row
      className="grid items-stretch gap-x-4 gap-y-2 min-[30rem]:grid-cols-[minmax(0,1fr)_auto] min-[30rem]:items-center"
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
        {voiding && !voided ? (
          <p className="text-muted-foreground text-support" role="status">
            Anulando…
          </p>
        ) : null}
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
            "ml-auto flex items-center justify-end gap-2 touch:gap-3",
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
              {restoring ? "Reativando…" : "Reativar"}
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
              <VoidMenu expense={expense} isBusy={isBusy} onVoid={onVoid} />
            </>
          )}
        </div>
      </div>
    </ListBlock.Row>
  );
}

/** The shape of a row while the list loads: the description and the line under it, and the amount. */
function ExpenseRowShape() {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="grid flex-1 gap-1.5">
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-4 w-20" />
    </div>
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

/** With a category on, "Limpar filtros" takes its pill out in one touch; the status is the segmented, which stays. */
function EmptyExpenses({
  filters,
  onClearFilters,
}: {
  filters: ExpenseFilters;
  onClearFilters: () => void;
}) {
  if (filters.categoryId === "") {
    return (
      <p className="text-muted-foreground" role="status">
        {filters.status === "voided"
          ? "Nenhuma despesa anulada neste período."
          : "Nenhuma despesa neste período."}
      </p>
    );
  }
  return (
    <>
      <p className="text-muted-foreground" role="status">
        Nenhuma despesa encontrada com estes filtros.
      </p>
      <Button onClick={onClearFilters} type="button" variant="outline">
        Limpar filtros
      </Button>
    </>
  );
}

const LIST_TITLE_ID = "expense-list-title";
const LIST_TITLE = "Despesas do período";

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
  const unknown = isLoading && expenses.length === 0;
  const loadError = state.error ? (
    <LoadError
      busy={isLoading || state.isLoadingMore}
      message={state.error}
      onRetry={onRetry}
    />
  ) : null;
  if (state.error !== null && expenses.length === 0 && !isLoading) {
    return loadError;
  }
  const showTotal = !isLoading || expenses.length > 0;
  const period = (
    <ListBlock.Header
      aria-live="polite"
      className="items-end justify-between"
      role="status"
    >
      <PeriodTotal filters={filters} state={state} />
    </ListBlock.Header>
  );
  const total = loadedTotal(state);
  const count = showTotal ? countLabel(state.count) : "";
  let block = (
    <ListBlock count={count} id={LIST_TITLE_ID} state="rows" title={LIST_TITLE}>
      {period}
      {expenses.map((expense) => (
        <ExpenseRow
          busyKey={busyKey}
          expense={expense}
          key={expense.id}
          onEdit={onEdit}
          onRestore={onRestore}
          onVoid={onVoid}
        />
      ))}
      {total}
    </ListBlock>
  );
  if (unknown) {
    block = (
      <ListBlock
        count={count}
        id={LIST_TITLE_ID}
        skeleton={<ExpenseRowShape />}
        state="loading"
        title={LIST_TITLE}
      >
        {period}
        {total}
      </ListBlock>
    );
  } else if (expenses.length === 0) {
    block = (
      <ListBlock
        count={count}
        emptyNotice={
          <EmptyExpenses filters={filters} onClearFilters={onClearFilters} />
        }
        id={LIST_TITLE_ID}
        state="filtered-empty"
        title={LIST_TITLE}
      >
        {period}
        {total}
      </ListBlock>
    );
  }
  return (
    <div aria-busy={isLoading} className="grid gap-2">
      {loadError}
      {block}
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
