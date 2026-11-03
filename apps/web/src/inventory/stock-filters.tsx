import FunnelIcon from "lucide-react/dist/esm/icons/funnel";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldLabel } from "@/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { StatusNav } from "../catalog/screen-parts";
import {
  STOCK_FILTERS,
  type StockFilter,
  type StockFilters,
} from "./stock-list-model";

/** The filters that narrow the list; the search box is not one of them, it has its own field. */
export function activeStockFilters(filters: StockFilters): number {
  return (
    (filters.stock === "all" ? 0 : 1) +
    (filters.unknownCost ? 1 : 0) +
    (filters.includeArchived ? 1 : 0)
  );
}

interface StockFiltersButtonProps {
  filters: StockFilters;
  onArchived: (checked: boolean) => void;
  onStock: (stock: StockFilter) => void;
  onUnknownCost: (checked: boolean) => void;
}

/**
 * One button for the criteria besides the search: balance tabs, "Sem custo" and "Incluir arquivados" are inside it, so
 * the first row of the list stays on the first screen of a phone. The button says how many filters narrow the list.
 */
export function StockFiltersButton({
  filters,
  onArchived,
  onStock,
  onUnknownCost,
}: StockFiltersButtonProps) {
  const active = activeStockFilters(filters);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={
              active === 0
                ? "Filtros"
                : `Filtros, ${active} ${active === 1 ? "ativo" : "ativos"}`
            }
            className="shrink-0"
            type="button"
            variant="outline"
          />
        }
      >
        <FunnelIcon aria-hidden="true" data-icon="inline-start" />
        Filtros
        {active === 0 ? null : (
          <Badge aria-hidden="true" variant="secondary">
            {active}
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Filtros"
        className="w-80 max-w-[calc(100vw-2rem)] gap-3 p-3"
      >
        <StatusNav
          label="Filtrar por saldo"
          onSelect={onStock}
          options={STOCK_FILTERS}
          value={filters.stock}
        />
        <Field className="min-h-ctl-md w-auto" orientation="horizontal">
          <Checkbox
            checked={filters.unknownCost}
            id="stock-unknown-cost"
            onCheckedChange={onUnknownCost}
          />
          <FieldLabel htmlFor="stock-unknown-cost">Sem custo</FieldLabel>
        </Field>
        <Field className="min-h-ctl-md w-auto" orientation="horizontal">
          <Checkbox
            checked={filters.includeArchived}
            id="stock-archived"
            onCheckedChange={onArchived}
          />
          <FieldLabel htmlFor="stock-archived">Incluir arquivados</FieldLabel>
        </Field>
      </PopoverContent>
    </Popover>
  );
}
