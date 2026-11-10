import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { type ReactNode, useCallback, useMemo } from "react";
import { FilterBar, type FilterField, type FilterRule } from "@/ui/filter-bar";
import { focusLater } from "../lib/focus";
import { groupCategories } from "./expense-model";
import type { ExpenseStatusFilter } from "./use-expense-list";

const EXPENSE_FILTERS_LABEL = "Filtrar despesas";

const FIELD_CATEGORY = "category";
const FIELD_STATUS = "status";

const STATUS_OPTIONS: ReadonlyArray<{
  label: string;
  value: ExpenseStatusFilter;
}> = [
  { label: "Ativas", value: "active" },
  { label: "Anuladas", value: "voided" },
];

/** What the bar edits; the month is the page's own picker, on the same line. */
export interface ExpenseBarFilters {
  /** Empty for every category. */
  categoryId: string;
  status: ExpenseStatusFilter;
}

function isStatus(value: string): value is ExpenseStatusFilter {
  return STATUS_OPTIONS.some((option) => option.value === value);
}

/**
 * The filters as the bar's rules. "Ativas" is how the list opens, so it has no pill (as "Todas" has none in the
 * Histórico): a pill appears only for what narrows the list, and the total's label says "(anuladas)" when the list is the voided ones.
 */
export function expenseRules(filters: ExpenseBarFilters): FilterRule[] {
  const rules: FilterRule[] = [];
  if (filters.categoryId !== "") {
    rules.push({ fieldId: FIELD_CATEGORY, value: filters.categoryId });
  }
  if (filters.status !== "active") {
    rules.push({ fieldId: FIELD_STATUS, value: filters.status });
  }
  return rules;
}

function chosen(rules: readonly FilterRule[], fieldId: string): string {
  const value = rules.find((rule) => rule.fieldId === fieldId)?.value;
  return typeof value === "string" ? value : "";
}

/** The next filters of the page from the bar's list: both written, so a pill taken out is a filter turned off. */
export function expenseFilters(
  rules: readonly FilterRule[]
): ExpenseBarFilters {
  const status = chosen(rules, FIELD_STATUS);
  return {
    categoryId: chosen(rules, FIELD_CATEGORY),
    status: isStatus(status) ? status : "active",
  };
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

/** The fields in the order the "Filtrar" menu lists them. */
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
    {
      id: FIELD_STATUS,
      label: "Situação",
      options: STATUS_OPTIONS,
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

interface ExpenseFiltersBarProps {
  categories: readonly ExpenseCategoryReadModel[];
  filters: ExpenseBarFilters;
  /** The month picker, which shares the first line with "Filtrar". */
  leading: ReactNode;
  onChange: (filters: ExpenseBarFilters) => void;
}

/** The criteria besides the month, on the bar of the project: the Histórico and the Estoque filter the same way. */
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
    (next: FilterRule[]) => {
      const written = expenseFilters(next);
      onChange(written);
      // "Ativas" chosen in the editor is no pill: the editor's trigger leaves with it, and "Filtrar" takes the focus
      if (chosen(next, FIELD_STATUS) === "active") {
        focusFilterAfterClear();
      }
    },
    [onChange]
  );
  return (
    <FilterBar
      fields={fields}
      label={EXPENSE_FILTERS_LABEL}
      leading={leading}
      onChange={handleChange}
      value={rules}
    />
  );
}
