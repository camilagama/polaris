import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import MinusIcon from "lucide-react/dist/esm/icons/minus";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { type ChangeEvent, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { Field, FieldDescription, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupInput } from "@/ui/input-group";
import { describedBy, FieldTexts, TextField } from "./sale-fields";
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

interface QuantityStepperProps {
  error: string | undefined;
  id: string;
  onChange: (value: string) => void;
  value: string;
}

/**
 * − field +. The field is 64 px wide (Petković C-1): with touch each button has a 48 px area, 6 px past each
 * side, and 52 px of the field stay free between the two areas, so a thumb on the number never hits − or +.
 * The buttons are named without the word "quantidade", so the label of the field names the field only.
 */
function QuantityStepper({ error, id, onChange, value }: QuantityStepperProps) {
  const less = stepQuantity(value, -1);
  const more = stepQuantity(value, 1);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  const handleLess = useCallback(() => {
    if (less !== null) {
      onChange(less);
    }
  }, [less, onChange]);
  const handleMore = useCallback(() => {
    if (more !== null) {
      onChange(more);
    }
  }, [more, onChange]);
  return (
    <Field className="w-auto" data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>Quantidade</FieldLabel>
      {/* the field has its own label: the group is only layout (role="none"), no nameless "group" to announce */}
      <ButtonGroup role="none">
        <Button
          aria-label="Menos uma unidade"
          disabled={less === null}
          onClick={handleLess}
          size="icon"
          type="button"
          variant="outline"
        >
          <MinusIcon aria-hidden="true" />
        </Button>
        <InputGroup className="w-16">
          <InputGroupInput
            aria-describedby={describedBy(id, error, undefined)}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            className="px-1 text-center tabular-nums"
            id={id}
            inputMode="numeric"
            maxLength={10}
            onChange={handleChange}
            value={value}
          />
        </InputGroup>
        <Button
          aria-label="Mais uma unidade"
          disabled={more === null}
          onClick={handleMore}
          size="icon"
          type="button"
          variant="outline"
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </ButtonGroup>
      <FieldTexts error={error} hint={undefined} id={id} />
    </Field>
  );
}

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
                className="justify-self-start text-support"
                onClick={handleClear}
                size="sm"
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
