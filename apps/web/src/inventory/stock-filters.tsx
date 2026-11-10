import { type ReactNode, useCallback, useMemo } from "react";
import { FilterBar, type FilterField, type FilterRule } from "@/ui/filter-bar";
import {
  STOCK_FILTERS,
  type StockFilter,
  type StockFilters,
} from "./stock-list-model";

/** "Todas" is no filter: the choice lists only what narrows the balance. */
const BALANCE_OPTIONS = STOCK_FILTERS.filter(([value]) => value !== "all").map(
  ([value, label]) => ({ label, value })
);

const FIELD_BALANCE = "balance";
const FIELD_UNKNOWN_COST = "unknown-cost";
const FIELD_ARCHIVED = "archived";

const UNKNOWN_COST_ONLY = "only";
const ARCHIVED_INCLUDED = "include";

type StockBarFilters = Pick<
  StockFilters,
  "includeArchived" | "stock" | "unknownCost"
>;

function isNarrowingBalance(value: string): value is StockFilter {
  return BALANCE_OPTIONS.some((option) => option.value === value);
}

/** The filters of the list as the bar's rules, in the order the fields are listed; the search is not one of them. */
export function stockRules(filters: StockBarFilters): FilterRule[] {
  const rules: FilterRule[] = [];
  if (filters.stock !== "all") {
    rules.push({ fieldId: FIELD_BALANCE, value: filters.stock });
  }
  if (filters.unknownCost) {
    rules.push({ fieldId: FIELD_UNKNOWN_COST, value: UNKNOWN_COST_ONLY });
  }
  if (filters.includeArchived) {
    rules.push({ fieldId: FIELD_ARCHIVED, value: ARCHIVED_INCLUDED });
  }
  return rules;
}

function chosen(rules: readonly FilterRule[], fieldId: string): string {
  const value = rules.find((rule) => rule.fieldId === fieldId)?.value;
  return typeof value === "string" ? value : "";
}

/** The bar's next list as the three filters the page keeps, every one written (a pill taken out is a filter turned off). */
export function stockFilters(rules: readonly FilterRule[]): StockBarFilters {
  const balance = chosen(rules, FIELD_BALANCE);
  return {
    includeArchived: chosen(rules, FIELD_ARCHIVED) === ARCHIVED_INCLUDED,
    stock: isNarrowingBalance(balance) ? balance : "all",
    unknownCost: chosen(rules, FIELD_UNKNOWN_COST) === UNKNOWN_COST_ONLY,
  };
}

/** The fields of the bar, in the order the "Filtrar" menu lists them. The average cost is only known with a connection. */
export function stockFields(offline: boolean): FilterField[] {
  return [
    {
      id: FIELD_BALANCE,
      label: "Saldo",
      options: BALANCE_OPTIONS,
      type: "select",
    },
    {
      disabledReason: offline ? "Só com conexão" : undefined,
      id: FIELD_UNKNOWN_COST,
      label: "Custo",
      options: [{ label: "Desconhecido", value: UNKNOWN_COST_ONLY }],
      type: "select",
    },
    {
      id: FIELD_ARCHIVED,
      label: "Arquivados",
      options: [{ label: "Incluir", value: ARCHIVED_INCLUDED }],
      type: "select",
    },
  ];
}

interface StockFiltersBarProps {
  filters: StockFilters;
  /** The search box of the list, on the line of "Filtrar". */
  leading: ReactNode;
  /** Without a connection the filter by cost is not available. */
  offline: boolean;
  onChange: (changes: Partial<StockFilters>) => void;
}

/** The criteria besides the search, on the bar of the project: the Histórico filters the same way. */
export function StockFiltersBar({
  filters,
  leading,
  offline,
  onChange,
}: StockFiltersBarProps) {
  const fields = useMemo(() => stockFields(offline), [offline]);
  const { includeArchived, stock, unknownCost } = filters;
  const rules = useMemo(
    () => stockRules({ includeArchived, stock, unknownCost }),
    [includeArchived, stock, unknownCost]
  );
  const handleChange = useCallback(
    (next: FilterRule[]) => onChange(stockFilters(next)),
    [onChange]
  );
  return (
    <FilterBar
      fields={fields}
      label="Filtrar estoque"
      leading={leading}
      onChange={handleChange}
      value={rules}
    />
  );
}
