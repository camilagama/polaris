import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { type ReactNode, useCallback, useMemo } from "react";
import { FilterBar, type FilterField, type FilterRule } from "@/ui/filter-bar";
import { SegmentedFilter } from "@/ui/segmented-filter";
import { focusLater } from "../lib/focus";
import { groupCategories } from "./expense-model";
import type { ExpenseStatusFilter } from "./use-expense-list";

const EXPENSE_FILTERS_LABEL = "Filtrar despesas";

const FIELD_CATEGORY = "category";

const STATUS_OPTIONS: ReadonlyArray<readonly [ExpenseStatusFilter, string]> = [
  ["active", "Ativas"],
  ["voided", "Anuladas"],
];

/** What the list filters by; the month is the page's own picker, and the status is the segmented on the same line. */
export interface ExpenseBarFilters {
  /** Empty for every category. */
  categoryId: string;
  status: ExpenseStatusFilter;
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

/** "Ativas | Anuladas" on the month's line: the state filter of the project, so a touch swaps the list and the one on screen is the open tab. */
function StatusSegmented({
  onChange,
  status,
}: {
  onChange: (status: ExpenseStatusFilter) => void;
  status: ExpenseStatusFilter;
}) {
  return (
    <SegmentedFilter
      compact
      label="Situação"
      onSelect={onChange}
      options={STATUS_OPTIONS}
      value={status}
    />
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
