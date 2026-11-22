import { useCallback, useMemo } from "react";
import { DateRangePicker } from "@/ui/date-range-picker";
import type { DateRange } from "@/ui/date-values";
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

const FIELD_STATUS = "status";
const FIELD_CUSTOMER = "customer";
const FIELD_QUERY = "query";

interface FiltersProps {
  filters: HistoryFilters;
  /** Without a connection the text search over the items is not available. */
  offline: boolean;
  onChange: (changes: Partial<HistoryFilters>) => void;
}

/** The screen has no future days: "Este mês" of its period ends today. */
export const HISTORY_PERIOD_ENDS_TODAY = true;

/** The filters of the screen as the bar's list: one rule per filter in use, in the order the fields are listed. */
export function historyRules(filters: HistoryFilters): FilterRule[] {
  const rules: FilterRule[] = [];
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

/** The bar's next list as the three filters it holds, every one written (a pill taken out is an empty filter). */
export function historyFilters(
  rules: readonly FilterRule[]
): Pick<HistoryFilters, "customer" | "query" | "status"> {
  const status = textOf(rules, FIELD_STATUS);
  return {
    customer: textOf(rules, FIELD_CUSTOMER),
    query: textOf(rules, FIELD_QUERY),
    status: isStatusFilter(status) ? status : "",
  };
}

/** The fields of the bar, in the order the "Filtrar" menu lists them: the period is the control of the title line. */
export function historyFields(offline: boolean): FilterField[] {
  return [
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
      label: "Produto vendido",
      placeholder: "Nome do produto",
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

/**
 * The period of the history, the action of the title line: a range with both ends or none ("Limpar"). A state with one
 * end alone, which only an address could bring, reads as no period.
 */
export function HistoryPeriodPicker({
  filters,
  onChange,
}: {
  filters: HistoryFilters;
  onChange: (changes: Pick<HistoryFilters, "from" | "to">) => void;
}) {
  const value =
    filters.from !== "" && filters.to !== ""
      ? { from: filters.from, to: filters.to }
      : null;
  const handleChange = useCallback(
    (range: DateRange | null) =>
      onChange({ from: range?.from ?? "", to: range?.to ?? "" }),
    [onChange]
  );
  return (
    <DateRangePicker
      action={value ? "editar" : undefined}
      endsToday={HISTORY_PERIOD_ENDS_TODAY}
      label="Período"
      onValueChange={handleChange}
      value={value}
    />
  );
}
