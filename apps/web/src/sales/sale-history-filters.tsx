import FunnelIcon from "lucide-react/dist/esm/icons/funnel";
import { useCallback, useState } from "react";
import { useIsMobile } from "@/lib/use-mobile";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { SelectField, TextField } from "./sale-fields";
import {
  activeFilterCount,
  HISTORY_STATUS_FILTERS,
  type HistoryFilters,
  type HistoryStatusFilter,
} from "./sale-history-model";

/** The select has no empty value: "Todas" is "all" here and "" in the filters. */
const ALL = "all";
const STATUS_OPTIONS = HISTORY_STATUS_FILTERS.map(([value, label]) => ({
  id: value === "" ? ALL : value,
  label,
}));

function isStatusFilter(value: string): value is HistoryStatusFilter {
  return HISTORY_STATUS_FILTERS.some(([status]) => status === value);
}

interface FiltersProps {
  filters: HistoryFilters;
  /** Without a connection the text search over the items is not available. */
  offline: boolean;
  onChange: (changes: Partial<HistoryFilters>) => void;
  onReset: () => void;
  period: string | null;
}

export function HistoryFiltersBar({
  filters,
  offline,
  onChange,
  onReset,
  period,
}: FiltersProps) {
  const active = activeFilterCount(filters);
  const handleFrom = useCallback(
    (from: string) => onChange({ from }),
    [onChange]
  );
  const handleTo = useCallback((to: string) => onChange({ to }), [onChange]);
  const handleStatus = useCallback(
    (value: string) => {
      const status = value === ALL ? "" : value;
      onChange({ status: isStatusFilter(status) ? status : "" });
    },
    [onChange]
  );
  const handleCustomer = useCallback(
    (customer: string) => onChange({ customer }),
    [onChange]
  );
  const handleQuery = useCallback(
    (query: string) => onChange({ query }),
    [onChange]
  );
  // Below 760 px the five fields would push the first sale a screen down: they sit in a panel under "Filtrar",
  // closed unless the screen arrives with a filter on. From 760 px they are in the page, as before.
  const mobile = useIsMobile();
  const [open, setOpen] = useState(active > 0);
  const fields = (
    <>
      <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <TextField
          id="history-from"
          label="De (data da venda)"
          onChange={handleFrom}
          type="date"
          value={filters.from}
        />
        <TextField
          error={period ?? undefined}
          id="history-to"
          label="Até (data da venda)"
          onChange={handleTo}
          type="date"
          value={filters.to}
        />
        <SelectField
          id="history-status"
          label="Situação"
          onChange={handleStatus}
          options={STATUS_OPTIONS}
          placeholder="Todas"
          value={filters.status === "" ? ALL : filters.status}
        />
        <TextField
          id="history-customer"
          label="Cliente"
          onChange={handleCustomer}
          placeholder="Nome do cliente"
          value={filters.customer}
        />
        <TextField
          disabled={offline}
          id="history-query"
          label="Busca"
          onChange={handleQuery}
          placeholder={offline ? "Só com conexão" : "Produto vendido"}
          value={filters.query}
        />
      </div>
      <Button
        className="justify-self-start"
        disabled={active === 0}
        onClick={onReset}
        type="button"
        variant="outline"
      >
        Limpar filtros{active > 0 ? ` (${active})` : ""}
      </Button>
    </>
  );
  return (
    <search aria-label="Filtrar vendas" className="grid gap-3">
      {mobile ? (
        <Collapsible onOpenChange={setOpen} open={open}>
          <CollapsibleTrigger
            render={<Button className="justify-self-start" variant="outline" />}
          >
            <FunnelIcon aria-hidden="true" data-icon="inline-start" />
            {active > 0 ? `Filtrar · ${active}` : "Filtrar"}
          </CollapsibleTrigger>
          <CollapsiblePanel className="grid gap-3 pt-3">
            {fields}
          </CollapsiblePanel>
        </Collapsible>
      ) : (
        fields
      )}
    </search>
  );
}
