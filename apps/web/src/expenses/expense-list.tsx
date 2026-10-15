import type {
  ExpenseCategoryReadModel,
  ExpenseReadModel,
} from "@polaris/contracts";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { formatBrlAmount, formatCalendarDate } from "../lib/format";
import { ExpenseCategorySelect } from "./expense-category-select";
import {
  expenseGroupLabel,
  formatMonthLabel,
  isMonthValue,
  shiftMonth,
} from "./expense-model";
import type {
  ExpenseFilters,
  ExpenseListState,
  ExpenseStatusFilter,
} from "./use-expense-list";

const statusTabs: ReadonlyArray<readonly [ExpenseStatusFilter, string]> = [
  ["active", "Ativas"],
  ["voided", "Anuladas"],
];

interface StatusTabProps {
  current: ExpenseStatusFilter;
  label: string;
  onSelect: (value: ExpenseStatusFilter) => void;
  value: ExpenseStatusFilter;
}

function StatusTab({ current, label, onSelect, value }: StatusTabProps) {
  const handleClick = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <button
      aria-pressed={current === value}
      className={
        current === value ? "category-tab is-selected" : "category-tab"
      }
      onClick={handleClick}
      type="button"
    >
      {label}
    </button>
  );
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
  // typed text can be half a month for a moment: only a whole month is applied
  const [monthText, setMonthText] = useState(month);
  useEffect(() => setMonthText(month), [month]);

  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);

  const handlePrevious = useCallback(() => {
    if (previous) {
      onChange({ ...filters, month: previous });
    }
  }, [filters, onChange, previous]);
  const handleNext = useCallback(() => {
    if (next) {
      onChange({ ...filters, month: next });
    }
  }, [filters, next, onChange]);
  const handleMonth = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { value } = event.currentTarget;
      setMonthText(value);
      if (isMonthValue(value) && value !== month) {
        onChange({ ...filters, month: value });
      }
    },
    [filters, month, onChange]
  );
  const handleStatus = useCallback(
    (value: ExpenseStatusFilter) => onChange({ ...filters, status: value }),
    [filters, onChange]
  );
  const handleCategory = useCallback(
    (value: string) => onChange({ ...filters, categoryId: value }),
    [filters, onChange]
  );

  return (
    <div className="expense-filters">
      <div className="expense-month-filter">
        <label className="field-label" htmlFor="expense-month">
          Mês de competência
        </label>
        <div className="expense-month-controls">
          <button
            aria-label="Mês anterior"
            className="quiet-button"
            disabled={previous === null}
            onClick={handlePrevious}
            type="button"
          >
            ‹
          </button>
          <input
            id="expense-month"
            onChange={handleMonth}
            pattern="\d{4}-\d{2}"
            placeholder="AAAA-MM"
            type="month"
            value={monthText}
          />
          <button
            aria-label="Próximo mês"
            className="quiet-button"
            disabled={next === null}
            onClick={handleNext}
            type="button"
          >
            ›
          </button>
        </div>
      </div>

      <div className="expense-category-filter">
        <label className="field-label" htmlFor="expense-category-filter">
          Categoria
        </label>
        <ExpenseCategorySelect
          categories={categories}
          disabled={false}
          id="expense-category-filter"
          onChange={handleCategory}
          placeholder="Todas as categorias"
          value={categoryId}
        />
      </div>

      <nav
        aria-label="Situação das despesas"
        className="category-tabs expense-status-tabs"
      >
        {statusTabs.map(([value, label]) => (
          <StatusTab
            current={status}
            key={value}
            label={label}
            onSelect={handleStatus}
            value={value}
          />
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
    <div aria-live="polite" className="expense-summary">
      <div>
        <p className="expense-summary-label">
          Total do período
          {filters.status === "voided" ? " (anuladas)" : ""}
        </p>
        <p className="expense-summary-total">
          {showTotal ? formatBrlAmount(state.total) : "…"}
        </p>
      </div>
      <p className="expense-summary-meta">
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
    <article className={voided ? "expense-card is-voided" : "expense-card"}>
      <div className="expense-card-main">
        <div className="expense-card-title-row">
          <h3>{expense.description}</h3>
          {voided ? (
            <span className="category-status status-deleted">Anulada</span>
          ) : null}
          {expense.recurringRuleId ? (
            <span
              className="category-status status-active"
              title="Lançada automaticamente por uma despesa recorrente"
            >
              Recorrente
            </span>
          ) : null}
        </div>
        <p className="expense-card-meta">
          {expense.categoryName}
          <span className="expense-card-group">
            {" "}
            · {expenseGroupLabel(expense.categoryGroup)}
          </span>
        </p>
        <p className="expense-card-meta">
          Competência {formatCalendarDate(expense.competenceOn)}
          {expense.payee ? ` · ${expense.payee}` : ""}
        </p>
      </div>
      <p className="expense-card-amount">{formatBrlAmount(expense.amount)}</p>
      <div className="expense-card-actions">
        {voided ? (
          <button
            aria-label={`Reativar despesa ${expense.description}`}
            className="quiet-button"
            disabled={isBusy}
            onClick={handleRestore}
            type="button"
          >
            {thisBusy ? "Reativando…" : "Reativar"}
          </button>
        ) : (
          <>
            <button
              aria-label={`Editar despesa ${expense.description}`}
              className="quiet-button"
              disabled={isBusy}
              onClick={handleEdit}
              type="button"
            >
              Editar
            </button>
            <button
              aria-label={`Anular despesa ${expense.description}`}
              className="quiet-button"
              disabled={isBusy}
              onClick={handleVoid}
              type="button"
            >
              {thisBusy ? "Anulando…" : "Anular"}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

interface ExpenseListProps {
  busyKey: string | null;
  filters: ExpenseFilters;
  onEdit: (expense: ExpenseReadModel) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRestore: (expense: ExpenseReadModel) => void;
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
    <div aria-busy={isLoading}>
      {state.error ? (
        <p className="categories-message is-error" role="alert">
          {state.error}{" "}
          <button
            className="quiet-button"
            disabled={isLoading || state.isLoadingMore}
            onClick={onRetry}
            type="button"
          >
            Tentar de novo
          </button>
        </p>
      ) : null}
      {isLoading && expenses.length === 0 ? (
        <p className="expense-empty-state" role="status">
          Carregando despesas…
        </p>
      ) : null}
      {!isLoading && expenses.length === 0 && state.error === null ? (
        <p className="expense-empty-state">{emptyText(filters)}</p>
      ) : null}
      {expenses.length > 0 ? (
        <ul className="expense-list">
          {expenses.map((expense) => (
            <li className="expense-list-item" key={expense.id}>
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
        <div className="expense-more">
          <button
            className="quiet-button"
            disabled={state.isLoadingMore || busyKey !== null}
            onClick={onLoadMore}
            type="button"
          >
            {state.isLoadingMore ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      )}
    </div>
  );
}
