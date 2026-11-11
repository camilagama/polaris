import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { type MouseEvent, type ReactNode, useCallback, useMemo } from "react";
import { FilterBar, type FilterField, type FilterRule } from "@/ui/filter-bar";
import { focusLater } from "../lib/focus";
import { groupCategories } from "./expense-model";
import type { ExpenseStatusFilter } from "./use-expense-list";

const EXPENSE_FILTERS_LABEL = "Filtrar despesas";

const FIELD_CATEGORY = "category";

const STATUS_OPTIONS: ReadonlyArray<{
  label: string;
  value: ExpenseStatusFilter;
}> = [
  { label: "Ativas", value: "active" },
  { label: "Anuladas", value: "voided" },
];

/** What the list filters by; the month is the page's own picker, and the status is the segmented on the same line. */
export interface ExpenseBarFilters {
  /** Empty for every category. */
  categoryId: string;
  status: ExpenseStatusFilter;
}

function isStatus(value: string | undefined): value is ExpenseStatusFilter {
  return STATUS_OPTIONS.some((option) => option.value === value);
}

/** The bar's rules: only the category narrows by pill; "Ativas | Anuladas" is the segmented, one touch from the month. */
export function expenseRules(filters: ExpenseBarFilters): FilterRule[] {
  return filters.categoryId === ""
    ? []
    : [{ fieldId: FIELD_CATEGORY, value: filters.categoryId }];
}

function chosen(rules: readonly FilterRule[], fieldId: string): string {
  const value = rules.find((rule) => rule.fieldId === fieldId)?.value;
  return typeof value === "string" ? value : "";
}

/** The next filters of the page from the bar's list: the category written (a pill taken out is a filter turned off), the status as it was. */
export function expenseFilters(
  rules: readonly FilterRule[],
  status: ExpenseStatusFilter
): ExpenseBarFilters {
  return { categoryId: chosen(rules, FIELD_CATEGORY), status };
}

function categoryOptions(categories: readonly ExpenseCategoryReadModel[]) {
  return groupCategories(categories).flatMap((section) =>
    section.items.map((category) => ({
      label:
        category.status === "archived"
          ? `${category.name} (arquivada)`
          : category.name,
      value: category.id,
    }))
  );
}

/** The fields the "Filtrar" menu lists: the category. */
export function expenseFields(
  categories: readonly ExpenseCategoryReadModel[]
): FilterField[] {
  return [
    {
      id: FIELD_CATEGORY,
      label: "Categoria",
      options: categoryOptions(categories),
      type: "select",
    },
  ];
}

function focusFilterButton() {
  document
    .querySelector<HTMLElement>(
      `[aria-label="${EXPENSE_FILTERS_LABEL}"] [data-slot="filter-add"]`
    )
    ?.focus();
}

/** "Filtrar" takes the focus when the control that had it left the screen with the pill ("Limpar filtros" of the empty list). */
export function focusFilterAfterClear() {
  focusLater(focusFilterButton);
}

interface StatusSegmentedProps {
  onChange: (status: ExpenseStatusFilter) => void;
  status: ExpenseStatusFilter;
}

/** "Ativas | Anuladas" on the month's line: a touch swaps the list, and the one on screen is `aria-pressed` and filled (the Aparência segmented of the sidebar marks its choice the same way). */
function StatusSegmented({ onChange, status }: StatusSegmentedProps) {
  const pick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const value = event.currentTarget.dataset.status;
      if (isStatus(value)) {
        onChange(value);
      }
    },
    [onChange]
  );
  return (
    <fieldset
      aria-label="Situação"
      className="m-0 flex shrink-0 rounded-md border-0 p-0 shadow-xs"
    >
      {STATUS_OPTIONS.map((option) => (
        <button
          aria-pressed={option.value === status}
          className="touch-hit focus-ring not-first:-ml-px inline-flex h-ctl-md touch:h-11 items-center justify-center border border-border bg-card px-2 font-medium text-foreground text-xs motion-full:transition-colors first:rounded-l-md last:rounded-r-md hover:bg-accent aria-pressed:bg-primary aria-pressed:text-primary-foreground sm:px-2.5 sm:text-sm dark:bg-secondary/60 dark:aria-pressed:bg-primary"
          data-status={option.value}
          key={option.value}
          onClick={pick}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

interface ExpenseFiltersBarProps {
  categories: readonly ExpenseCategoryReadModel[];
  filters: ExpenseBarFilters;
  /** The month picker, which shares the first line with the status and "Filtrar". */
  leading: ReactNode;
  onChange: (filters: ExpenseBarFilters) => void;
}

/** The criteria besides the month: the status on the line, the category on the bar of the project the Histórico and the Estoque filter with. */
export function ExpenseFiltersBar({
  categories,
  filters,
  leading,
  onChange,
}: ExpenseFiltersBarProps) {
  const fields = useMemo(() => expenseFields(categories), [categories]);
  const { categoryId, status } = filters;
  const rules = useMemo(
    () => expenseRules({ categoryId, status }),
    [categoryId, status]
  );
  const handleChange = useCallback(
    (next: FilterRule[]) => onChange(expenseFilters(next, status)),
    [onChange, status]
  );
  const handleStatus = useCallback(
    (next: ExpenseStatusFilter) => onChange({ categoryId, status: next }),
    [categoryId, onChange]
  );
  return (
    <FilterBar
      addIconOnPhone
      fields={fields}
      label={EXPENSE_FILTERS_LABEL}
      leading={
        <>
          {leading}
          <StatusSegmented onChange={handleStatus} status={status} />
        </>
      }
      onChange={handleChange}
      value={rules}
    />
  );
}
