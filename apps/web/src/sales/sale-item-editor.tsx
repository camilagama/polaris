import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { FieldDescription } from "@/ui/field";
import { QuantityStepper, TextField } from "./sale-fields";
import {
  type EvaluationContext,
  type ItemDraft,
  itemFieldKey,
  type SaleSummary,
  stepQuantity,
  stockView,
} from "./sale-form-model";
import { VariantSearch } from "./sale-variant-picker";

type LocalSearch = (query: string) => Promise<{
  entries: readonly InventoryBalanceEntryReadModel[];
  more: boolean;
}>;

interface ItemEditorProps {
  canRemove: boolean;
  errors: Record<string, string>;
  index: number;
  item: ItemDraft;
  /** Searches this device's collections instead of the server (no connection). */
  localSearch: LocalSearch | undefined;
  onChange: (draftId: string, changes: Partial<ItemDraft>) => void;
  onClearVariant: (draftId: string) => void;
  onPick: (draftId: string, entry: InventoryBalanceEntryReadModel) => void;
  onRemove: (draftId: string) => void;
  organizationId: string;
  priceHint: string | null;
  stock: EvaluationContext["stock"];
  stockWarning: string | undefined;
  /** This line in the summary, once the whole sale adds up. */
  summaryLine: SaleSummary["lines"][number] | undefined;
}

export function ItemEditor({
  canRemove,
  errors,
  index,
  item,
  localSearch,
  onChange,
  onClearVariant,
  onPick,
  onRemove,
  organizationId,
  priceHint,
  stock,
  stockWarning,
  summaryLine,
}: ItemEditorProps) {
  const prefix = `sale-item-${item.draftId}`;
  const chosen = item.variantId !== "";
  const stockState = chosen ? stockView(stock[item.variantId]) : null;
  const pickError =
    errors[itemFieldKey(item.draftId, "product")] ??
    errors[itemFieldKey(item.draftId, "variant")];
  const handlePick = useCallback(
    (entry: InventoryBalanceEntryReadModel) => onPick(item.draftId, entry),
    [item.draftId, onPick]
  );
  const handleClear = useCallback(
    () => onClearVariant(item.draftId),
    [item.draftId, onClearVariant]
  );
  const handleQuantity = useCallback(
    (value: string) => onChange(item.draftId, { quantity: value }),
    [item.draftId, onChange]
  );
  const handleListed = useCallback(
    (value: string) => onChange(item.draftId, { listedUnitPrice: value }),
    [item.draftId, onChange]
  );
  const handleCharged = useCallback(
    (value: string) => onChange(item.draftId, { chargedUnitPrice: value }),
    [item.draftId, onChange]
  );
  const handleRemove = useCallback(
    () => onRemove(item.draftId),
    [item.draftId, onRemove]
  );
  return (
    <fieldset className="grid min-w-0 gap-3 border-border border-t pt-4 first-of-type:border-t-0 first-of-type:pt-0">
      <legend className="sr-only">Item {index + 1}</legend>
      <div className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-0.5">
          {chosen ? (
            <>
              <p className="font-medium [overflow-wrap:anywhere]">
                {item.label}
              </p>
              {stockState ? (
                <p
                  className={cn(
                    "text-support",
                    stockState.tone === "warning"
                      ? "text-warning"
                      : "text-muted-foreground"
                  )}
                  id={`${prefix}-stock`}
                  role="status"
                >
                  {stockState.text} {localSearch ? "" : stockState.costText}
                </p>
              ) : null}
              <Button
                className="justify-self-start"
                onClick={handleClear}
                size="sm"
                text="support"
                type="button"
                variant="link"
              >
                Trocar variante
              </Button>
            </>
          ) : (
            <VariantSearch
              error={pickError}
              id={prefix}
              localSearch={localSearch}
              onPick={handlePick}
              organizationId={organizationId}
            />
          )}
        </div>
        {canRemove ? (
          <Button
            aria-label={`Remover item ${index + 1}`}
            className="hover:text-destructive"
            onClick={handleRemove}
            size="icon"
            type="button"
            variant="ghost-muted"
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {stockWarning ? (
        <p
          className="flex items-start gap-1.5 text-support text-warning"
          role="status"
        >
          <TriangleAlertIcon
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          {stockWarning}
        </p>
      ) : null}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-4 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
        <QuantityStepper
          error={errors[itemFieldKey(item.draftId, "quantity")]}
          id={`${prefix}-quantity`}
          label="Quantidade"
          less={stepQuantity(item.quantity, -1)}
          more={stepQuantity(item.quantity, 1)}
          onChange={handleQuantity}
          value={item.quantity}
        />
        <TextField
          addon="R$"
          error={errors[itemFieldKey(item.draftId, "chargedUnitPrice")]}
          id={`${prefix}-charged`}
          inputMode="decimal"
          label="Preço cobrado"
          maxLength={22}
          onChange={handleCharged}
          placeholder="49,90"
          value={item.chargedUnitPrice}
        />
        <TextField
          addon="R$"
          className="col-span-2 sm:col-span-1"
          error={errors[itemFieldKey(item.draftId, "listedUnitPrice")]}
          id={`${prefix}-listed`}
          inputMode="decimal"
          label="Preço de tabela"
          maxLength={22}
          onChange={handleListed}
          placeholder="59,90"
          value={item.listedUnitPrice}
        />
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <FieldDescription
          className="min-w-0"
          role={priceHint ? "note" : undefined}
        >
          {priceHint ?? "Preços por unidade."}
          {summaryLine?.negotiationText ? (
            <span className="mt-0.5 block text-warning">
              {summaryLine.negotiationText}
            </span>
          ) : null}
        </FieldDescription>
        {summaryLine ? (
          <span className="shrink-0 font-semibold tabular-nums">
            {summaryLine.lineTotalText}
          </span>
        ) : null}
      </div>
    </fieldset>
  );
}
