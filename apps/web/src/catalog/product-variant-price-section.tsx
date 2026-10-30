import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { commonFailureMessage, rpcErrorCode } from "../lib/rpc-error";
import { useHoldSwap } from "../lib/unsent-work";
import { ProductTextField } from "./product-fields";
import {
  VariantFieldRow,
  VariantSaveNotice,
  type VariantSaveOutcome,
  VariantSection,
} from "./product-variant-parts";
import {
  listPriceFieldText,
  listPriceFromField,
} from "./product-variant-price-model";
import {
  type ProductVariantReadModel,
  variantLabel,
} from "./product-variants-model";

const INVALID_PRICE = "Informe um valor em reais, como 59,90.";

export function priceErrorMessage(error: unknown): string {
  const common = commonFailureMessage(error, undefined, { directWrite: true });
  if (common !== undefined) {
    return common;
  }
  const code = rpcErrorCode(error);
  if (code === "CONFLICT") {
    return "O produto mudou. Atualize as variantes antes de tentar novamente.";
  }
  if (code === "BAD_REQUEST") {
    return INVALID_PRICE;
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta ação.";
  }
  if (code === "UNAUTHORIZED") {
    return "O preço não foi salvo.";
  }
  return "Não foi possível salvar o preço. Tente novamente.";
}

interface PriceRowProps {
  disabled: boolean;
  label: string;
  onDraftChange: () => void;
  onSave: (variantId: string, listPrice: string | null) => Promise<boolean>;
  variant: ProductVariantReadModel;
}

function PriceRow({
  disabled,
  label,
  onDraftChange,
  onSave,
  variant,
}: PriceRowProps) {
  const [text, setText] = useState(listPriceFieldText(variant.listPrice));
  const [invalid, setInvalid] = useState(false);
  // a typed text that differs from the saved price is unsent (a save puts the saved text back)
  useHoldSwap(text !== listPriceFieldText(variant.listPrice));

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const listPrice = listPriceFromField(text);
      if (listPrice === undefined) {
        setInvalid(true);
        return;
      }
      setInvalid(false);
      if (await onSave(variant.id, listPrice)) {
        setText(listPriceFieldText(listPrice));
      }
    },
    [onSave, text, variant.id]
  );
  const handleChange = useCallback(
    (value: string) => {
      setText(value);
      setInvalid(false);
      onDraftChange();
    },
    [onDraftChange]
  );

  return (
    <VariantFieldRow
      buttonLabel="Salvar preço"
      disabled={disabled}
      error={
        invalid
          ? {
              id: `product-variant-price-${variant.id}-error`,
              text: INVALID_PRICE,
            }
          : undefined
      }
      onSubmit={handleSubmit}
    >
      <ProductTextField
        addon="R$"
        disabled={disabled}
        error={invalid ? INVALID_PRICE : undefined}
        errorOutside
        id={`product-variant-price-${variant.id}`}
        inputMode="decimal"
        label={`Preço de tabela · ${label}`}
        onChange={handleChange}
        placeholder="Ex.: 49,90"
        value={text}
      />
    </VariantFieldRow>
  );
}

interface PriceSectionProps {
  configuration: ProductVariantConfigurationReadModel;
  onConflict: () => void;
  onUpdated: (
    configuration: ProductVariantConfigurationReadModel,
    product: ProductReadModel
  ) => void;
  organizationId: string;
  productId: string;
}

/**
 * The optional list price of each variant. It only pre-fills the listed price
 * of a sale item; the price in the sale command stays the economic fact.
 */
export function ProductVariantPriceSection({
  configuration,
  onConflict,
  onUpdated,
  organizationId,
  productId,
}: PriceSectionProps) {
  const [isPending, setIsPending] = useState(false);
  const [outcome, setOutcome] = useState<VariantSaveOutcome | null>(null);

  const handleSave = useCallback(
    async (variantId: string, listPrice: string | null) => {
      setIsPending(true);
      setOutcome(null);
      try {
        const result = await orpcClient.product.setVariantListPrice({
          expectedVersion: configuration.productVersion,
          listPrice,
          organizationId,
          productId,
          variantId,
        });
        onUpdated(result.configuration, result.product);
        setOutcome({
          kind: "saved",
          text: result.changed ? "Preço salvo." : "O preço já está atualizado.",
        });
        return true;
      } catch (error: unknown) {
        setOutcome({
          kind: rpcErrorCode(error) === "CONFLICT" ? "conflict" : "error",
          text: priceErrorMessage(error),
        });
        return false;
      } finally {
        setIsPending(false);
      }
    },
    [configuration.productVersion, onUpdated, organizationId, productId]
  );
  const handleDraftChange = useCallback(() => {
    setOutcome(null);
  }, []);

  return (
    <VariantSection
      help="Opcional: só sugere o valor na venda, que cobra o que for informado nela. Vazio remove."
      id="product-variant-price"
      title="Preço de tabela das variantes"
    >
      <ul aria-label="Preço de tabela das variantes" className="grid gap-3">
        {configuration.variants.map((variant, index) => (
          <li key={`${variant.id}:${variant.listPrice ?? ""}`}>
            <PriceRow
              disabled={isPending}
              label={variantLabel(variant, index)}
              onDraftChange={handleDraftChange}
              onSave={handleSave}
              variant={variant}
            />
          </li>
        ))}
      </ul>
      <VariantSaveNotice onReload={onConflict} outcome={outcome} />
    </VariantSection>
  );
}
