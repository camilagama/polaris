import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/ui/button";
import { FieldDescription } from "@/ui/field";
import { stockEntryHref } from "../inventory/stock-entry-link";
import { focusLater } from "../lib/focus";
import { QuantityStepper, TextField } from "./sale-fields";
import {
  type EvaluationContext,
  type ItemDraft,
  itemFieldKey,
  type SaleSummary,
  type StockView,
  stepQuantity,
  stockLineText,
  stockView,
} from "./sale-form-model";
import { VariantSearch } from "./sale-variant-picker";

type LocalSearch = (query: string) => Promise<{
  entries: readonly InventoryBalanceEntryReadModel[];
  more: boolean;
}>;

interface ItemEditorProps {
  canAdjustStock: boolean;
  canRemove: boolean;
  errors: Record<string, string>;
  index: number;
  item: ItemDraft;
  /** Searches this device's collections instead of the server (no connection). */
  localSearch: LocalSearch | undefined;
  onChange: (draftId: string, changes: Partial<ItemDraft>) => void;
  onPick: (draftId: string, entry: InventoryBalanceEntryReadModel) => void;
  onRemove: (draftId: string) => void;
  organizationId: string;
  priceHint: string | null;
  stock: EvaluationContext["stock"];
  stockWarning: string | undefined;
  /** This line in the summary, once the whole sale adds up. */
  summaryLine: SaleSummary["lines"][number] | undefined;
}

/**
 * One line of the sale. Before a variant is chosen it is only the search; once chosen, the variant is one line with a
 * check, its balance and "Trocar", and the quantity and prices appear under it. "Trocar" opens the search again with
 * the current variant marked among the suggestions, and leaving it without a choice keeps the line as it was.
 */
export function ItemEditor({
  canAdjustStock,
  canRemove,
  errors,
  index,
  item,
  localSearch,
  onChange,
  onPick,
  onRemove,
  organizationId,
  priceHint,
  stock,
  stockWarning,
  summaryLine,
}: ItemEditorProps) {
  const prefix = `sale-item-${item.draftId}`;
  const changeId = `${prefix}-change`;
  const [changing, setChanging] = useState(false);
  const chosen = item.variantId !== "";
  const searching = !chosen || changing;
  const name = chosen ? item.label : `item ${index + 1}`;
  const stockState = chosen
    ? stockView(stock[item.variantId], canAdjustStock)
    : null;
  const pickError =
    errors[itemFieldKey(item.draftId, "product")] ??
    errors[itemFieldKey(item.draftId, "variant")];
  const handlePick = useCallback(
    (entry: InventoryBalanceEntryReadModel) => {
      setChanging(false);
      onPick(item.draftId, entry);
    },
    [item.draftId, onPick]
  );
  const handleChange = useCallback(() => setChanging(true), []);
  const handleCancel = useCallback(() => {
    setChanging(false);
    focusLater(() => document.getElementById(changeId)?.focus());
  }, [changeId]);
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
        <div className="grid min-w-0 flex-1 gap-1">
          {searching ? (
            <VariantSearch
              autoFocus={changing}
              error={pickError}
              id={prefix}
              localSearch={localSearch}
              onCancel={changing ? handleCancel : undefined}
              onPick={handlePick}
              organizationId={organizationId}
              selectedVariantId={changing ? item.variantId : undefined}
            />
          ) : (
            <ChosenVariant
              changeId={changeId}
              item={item}
              offline={localSearch !== undefined}
              onChange={handleChange}
              stockState={stockState}
            />
          )}
          {!searching && stockState?.needsEntry && canAdjustStock ? (
            <a
              className={cn(
                buttonVariants({ size: "sm", variant: "link" }),
                "justify-self-start text-support"
              )}
              href={stockEntryHref(item.variantId)}
            >
              Dar entrada no estoque
              <span className="sr-only"> de {item.label}</span>
            </a>
          ) : null}
        </div>
        {canRemove ? (
          <Button
            aria-label={`Remover ${name}`}
            className="text-muted-foreground hover:text-destructive"
            onClick={handleRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {chosen ? (
        <ChosenItemFields
          errors={errors}
          item={item}
          onCharged={handleCharged}
          onListed={handleListed}
          onQuantity={handleQuantity}
          prefix={prefix}
          priceHint={priceHint}
          stockWarning={stockWarning}
          summaryLine={summaryLine}
        />
      ) : null}
    </fieldset>
  );
}

interface ChosenVariantProps {
  changeId: string;
  item: ItemDraft;
  /** Without a connection the cost on this device is not shown. */
  offline: boolean;
  onChange: () => void;
  stockState: StockView | null;
}

/** "✓ Camiseta · Preta · Saldo 6   Trocar": the chosen variant in one line, the cost under it. */
function ChosenVariant({
  changeId,
  item,
  offline,
  onChange,
  stockState,
}: ChosenVariantProps) {
  const costText = offline ? null : stockState?.costText;
  return (
    <div className="grid gap-0.5">
      <div className="flex items-start gap-2">
        <CircleCheckIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-foreground"
        />
        <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span className="font-medium">{item.label}</span>
          {stockState ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                {" · "}
              </span>
              <span
                className={cn(
                  "text-support",
                  stockState.tone === "warning"
                    ? "text-warning"
                    : "text-muted-foreground"
                )}
                id={`sale-item-${item.draftId}-stock`}
                role="status"
              >
                {stockLineText(stockState)}
              </span>
            </>
          ) : null}
        </p>
        <Button
          className="-my-1 shrink-0 text-support"
          id={changeId}
          onClick={onChange}
          size="sm"
          type="button"
          variant="link"
        >
          Trocar<span className="sr-only"> variante de {item.label}</span>
        </Button>
      </div>
      {costText ? (
        <p className="pl-6 text-muted-foreground text-support">{costText}</p>
      ) : null}
    </div>
  );
}

interface ChosenItemFieldsProps {
  errors: Record<string, string>;
  item: ItemDraft;
  onCharged: (value: string) => void;
  onListed: (value: string) => void;
  onQuantity: (value: string) => void;
  prefix: string;
  priceHint: string | null;
  stockWarning: string | undefined;
  summaryLine: SaleSummary["lines"][number] | undefined;
}

/** Quantity and prices: only once the variant is chosen. */
function ChosenItemFields({
  errors,
  item,
  onCharged,
  onListed,
  onQuantity,
  prefix,
  priceHint,
  stockWarning,
  summaryLine,
}: ChosenItemFieldsProps) {
  return (
    <>
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
          onChange={onQuantity}
          subject={item.label}
          value={item.quantity}
        />
        <TextField
          addon="R$"
          error={errors[itemFieldKey(item.draftId, "chargedUnitPrice")]}
          id={`${prefix}-charged`}
          inputMode="decimal"
          label="Preço cobrado"
          maxLength={22}
          onChange={onCharged}
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
          onChange={onListed}
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
    </>
  );
}
