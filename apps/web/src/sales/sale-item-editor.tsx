import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import CirclePlusIcon from "lucide-react/dist/esm/icons/circle-plus";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/ui/button";
import { CardDescription } from "@/ui/card";
import { FieldDescription } from "@/ui/field";
import { ProductThumbnail } from "../catalog/product-thumbnail";
import { stockEntryHref } from "../inventory/stock-entry-link";
import { useMediaThumbsEnabled } from "../lib/media-thumbs-flag";
import { focusLater } from "../lib/focus";
import { QuantityStepper, TextField } from "./sale-fields";
import {
  type EvaluationContext,
  type ItemDraft,
  itemFieldKey,
  MAX_SALE_ITEMS,
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
  /** The capa of the chosen variant's product; absent until a read that carried it, `null` without an image. */
  cover?: string | null | undefined;
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
  cover,
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
              cover={cover}
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
  cover?: string | null | undefined;
  item: ItemDraft;
  /** Without a connection the cost on this device is not shown. */
  offline: boolean;
  onChange: () => void;
  stockState: StockView | null;
}

/** "✓ Camiseta · Preta · Saldo 6   Trocar": the chosen variant in one line, the cost under it. */
function ChosenVariant({
  changeId,
  cover,
  item,
  offline,
  onChange,
  stockState,
}: ChosenVariantProps) {
  const costText = offline ? null : stockState?.costText;
  const thumbs = useMediaThumbsEnabled();
  return (
    <div className="grid gap-0.5">
      <div
        className={cn("flex gap-2", thumbs ? "items-center" : "items-start")}
      >
        {thumbs ? (
          <ProductThumbnail assetId={cover} name={item.label} size={32} />
        ) : null}
        <CircleCheckIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-foreground",
            thumbs ? "" : "mt-0.5"
          )}
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
          className="shrink-0 text-support"
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
        <p
          className={cn(
            "text-muted-foreground text-support",
            thumbs ? "pl-16" : "pl-6"
          )}
        >
          {costText}
        </p>
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
      <div className="@container">
        <div className="grid @[16.25rem]:grid-cols-[auto_minmax(0,1fr)] @[27rem]:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] grid-cols-1 items-start gap-x-3 gap-y-4 @[16.25rem]:[&>:first-child]:justify-self-auto [&>:first-child]:justify-self-start">
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
            className="@[16.25rem]:col-span-2 @[27rem]:col-span-1"
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

/**
 * "N itens" under "Itens": N counts only the lines with a variant chosen, never the empty line "Adicionar item" opens.
 * The line is always in the DOM (a no-break space while empty) so that the first choice does not push the item below
 * it down.
 */
export function ItemsCount({ chosen }: { chosen: number }) {
  return (
    <CardDescription>
      {chosen > 0 ? `${chosen} ${chosen === 1 ? "item" : "itens"}` : "\u00a0"}
    </CardDescription>
  );
}

/** "Adicionar item" only after the first variant is chosen: before it, the search of the first line is the way in. */
export function AddItemButton({
  chosen,
  onAdd,
  total,
}: {
  chosen: number;
  onAdd: () => void;
  total: number;
}) {
  if (chosen === 0) {
    return null;
  }
  return (
    <Button
      className="w-full sm:w-auto sm:justify-self-start"
      disabled={total >= MAX_SALE_ITEMS}
      onClick={onAdd}
      type="button"
      variant="outline"
    >
      <CirclePlusIcon aria-hidden="true" data-icon="inline-start" />
      Adicionar item
    </Button>
  );
}
