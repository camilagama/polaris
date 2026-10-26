import { useCallback, useMemo } from "react";
import { FilterBar, type FilterField, type FilterRule } from "@/ui/filter-bar";
import {
  HISTORY_STATUS_FILTERS,
  type HistoryFilters,
  type HistoryStatusFilter,
} from "./sale-history-model";

/** "Todas" is no filter: the choice lists only what narrows the history. */
const STATUS_OPTIONS = HISTORY_STATUS_FILTERS.filter(
  ([value]) => value !== ""
).map(([value, label]) => ({ label, value }));

function isStatusFilter(value: string): value is HistoryStatusFilter {
  return HISTORY_STATUS_FILTERS.some(([status]) => status === value);
}

const FIELD_PERIOD = "period";
const FIELD_STATUS = "status";
const FIELD_CUSTOMER = "customer";
const FIELD_QUERY = "query";

interface FiltersProps {
  filters: HistoryFilters;
  /** Without a connection the text search over the items is not available. */
  offline: boolean;
  onChange: (changes: Partial<HistoryFilters>) => void;
}

/**
 * The filters of the screen as the bar's list: one rule per filter in use, in the order the fields are listed. The
 * period is a pill only with both ends, as the bar writes it (the editor makes a whole range); a state with one end
 * alone cannot be reached from the bar.
 */
export function historyRules(filters: HistoryFilters): FilterRule[] {
  const rules: FilterRule[] = [];
  if (filters.from !== "" && filters.to !== "") {
    rules.push({
      fieldId: FIELD_PERIOD,
      value: { from: filters.from, to: filters.to },
    });
  }
  if (filters.status !== "") {
    rules.push({ fieldId: FIELD_STATUS, value: filters.status });
  }
  if (filters.customer.trim() !== "") {
    rules.push({ fieldId: FIELD_CUSTOMER, value: filters.customer });
  }
  if (filters.query.trim() !== "") {
    rules.push({ fieldId: FIELD_QUERY, value: filters.query });
  }
  return rules;
}

function textOf(rules: readonly FilterRule[], fieldId: string): string {
  const value = rules.find((rule) => rule.fieldId === fieldId)?.value;
  return typeof value === "string" ? value : "";
}

/** The bar's next list as the four filters the page keeps, every one written (a pill taken out is an empty filter). */
export function historyFilters(rules: readonly FilterRule[]): HistoryFilters {
  const period = rules.find((rule) => rule.fieldId === FIELD_PERIOD)?.value;
  const status = textOf(rules, FIELD_STATUS);
  return {
    customer: textOf(rules, FIELD_CUSTOMER),
    from: period && typeof period !== "string" ? period.from : "",
    query: textOf(rules, FIELD_QUERY),
    status: isStatusFilter(status) ? status : "",
    to: period && typeof period !== "string" ? period.to : "",
  };
}

/** The fields of the bar, in the order the "Filtrar" menu lists them. */
export function historyFields(offline: boolean): FilterField[] {
  return [
    { id: FIELD_PERIOD, label: "Período", type: "date-range" },
    {
      id: FIELD_STATUS,
      label: "Situação",
      options: STATUS_OPTIONS,
      type: "select",
    },
    {
      id: FIELD_CUSTOMER,
      label: "Cliente",
      placeholder: "Nome do cliente",
      type: "text",
    },
    {
      disabledReason: offline ? "Só com conexão" : undefined,
      id: FIELD_QUERY,
      label: "Busca",
      placeholder: "Produto vendido",
      type: "text",
    },
  ];
}

export function HistoryFiltersBar({
  filters,
  offline,
  onChange,
}: FiltersProps) {
  const fields = useMemo(() => historyFields(offline), [offline]);
  const rules = useMemo(() => historyRules(filters), [filters]);
  const handleChange = useCallback(
    (next: FilterRule[]) => onChange(historyFilters(next)),
    [onChange]
  );
  return (
    <FilterBar
      fields={fields}
      label="Filtrar vendas"
      onChange={handleChange}
      value={rules}
    />
  );
}
