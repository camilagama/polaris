import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
  ProductVariantOptionName,
} from "@polaris/contracts";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { rpcErrorCode } from "../lib/rpc-error";
import { useReportUnsentWork } from "../lib/unsent-work";
import {
  listPriceFieldText,
  listPriceFromField,
} from "./product-variant-price-model";
import "./product-variants-panel.css";

const optionLabels: Record<ProductVariantOptionName, string> = {
  color: "Cor",
  model: "Modelo",
  size: "Tamanho",
};

type VariantReadModel =
  ProductVariantConfigurationReadModel["variants"][number];

function variantLabel(variant: VariantReadModel, index: number): string {
  if (variant.isDefault && variant.values.length === 0) {
    return "Variante padrão";
  }
  return (
    variant.values
      .map(
        (value) =>
          `${optionLabels[value.optionName] ?? value.optionName}: ${value.optionValueName}`
      )
      .join(" · ") || `Variante ${index + 1}`
  );
}

function priceErrorMessage(error: unknown): string {
  const code = rpcErrorCode(error);
  if (code === "CONFLICT") {
    return "O produto mudou. Atualize as variantes antes de tentar novamente.";
  }
  if (code === "BAD_REQUEST") {
    return "Informe um valor em reais, como 59,90.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta ação.";
  }
  if (code === "UNAUTHORIZED") {
    return "O preço não foi salvo.";
  }
  return "Não foi possível salvar o preço. Tente novamente.";
}

function VariantPriceRow({
  disabled,
  label,
  onDraftChange,
  onSave,
  variant,
}: {
  disabled: boolean;
  label: string;
  onDraftChange: () => void;
  onSave: (variantId: string, listPrice: string | null) => Promise<boolean>;
  variant: VariantReadModel;
}) {
  const [text, setText] = useState(listPriceFieldText(variant.listPrice));
  const [invalid, setInvalid] = useState(false);
  // a typed text that differs from the saved price is unsent (a save puts the saved text back)
  useReportUnsentWork(text !== listPriceFieldText(variant.listPrice));

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
    (event: ChangeEvent<HTMLInputElement>) => {
      setText(event.currentTarget.value);
      setInvalid(false);
      onDraftChange();
    },
    [onDraftChange]
  );

  return (
    <form className="product-variant-sku-row" onSubmit={handleSubmit}>
      <label className="product-form-field">
        <span>Preço de tabela — {label}</span>
        <input
          aria-invalid={invalid}
          autoComplete="off"
          disabled={disabled}
          inputMode="decimal"
          onChange={handleChange}
          placeholder="Sem preço de tabela"
          type="text"
          value={text}
        />
        {invalid ? (
          <span className="product-variants-field-error" role="alert">
            Informe um valor em reais, como 59,90.
          </span>
        ) : null}
      </label>
      <button className="quiet-button" disabled={disabled} type="submit">
        Salvar preço
      </button>
    </form>
  );
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
}: {
  configuration: ProductVariantConfigurationReadModel;
  onConflict: () => void;
  onUpdated: (
    configuration: ProductVariantConfigurationReadModel,
    product: ProductReadModel
  ) => void;
  organizationId: string;
  productId: string;
}) {
  const [isPending, setIsPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);

  const handleSave = useCallback(
    async (variantId: string, listPrice: string | null) => {
      setIsPending(true);
      setMessage(null);
      setNeedsReload(false);
      try {
        const result = await orpcClient.product.setVariantListPrice({
          expectedVersion: configuration.productVersion,
          listPrice,
          organizationId,
          productId,
          variantId,
        });
        onUpdated(result.configuration, result.product);
        setMessage(
          result.changed ? "Preço salvo." : "O preço já está atualizado."
        );
        return true;
      } catch (error: unknown) {
        setMessage(priceErrorMessage(error));
        setNeedsReload(rpcErrorCode(error) === "CONFLICT");
        return false;
      } finally {
        setIsPending(false);
      }
    },
    [configuration.productVersion, onUpdated, organizationId, productId]
  );
  const handleDraftChange = useCallback(() => {
    setMessage(null);
    setNeedsReload(false);
  }, []);

  return (
    <div className="product-variant-sku-section">
      <h3>Preço de tabela das variantes</h3>
      <p className="product-variants-help">
        O preço de tabela é opcional e só sugere o valor na venda; o preço
        cobrado continua sendo o informado em cada venda. Deixe vazio para
        remover.
      </p>
      <ul
        aria-label="Preço de tabela das variantes"
        className="product-variant-sku-list"
      >
        {configuration.variants.map((variant, index) => (
          <li key={`${variant.id}:${variant.listPrice ?? ""}`}>
            <VariantPriceRow
              disabled={isPending}
              label={variantLabel(variant, index)}
              onDraftChange={handleDraftChange}
              onSave={handleSave}
              variant={variant}
            />
          </li>
        ))}
      </ul>
      {message ? (
        <p
          className={
            needsReload
              ? "product-variants-field-error"
              : "product-variants-help"
          }
          role={needsReload ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
      {needsReload ? (
        <button className="quiet-button" onClick={onConflict} type="button">
          Atualizar variantes
        </button>
      ) : null}
    </div>
  );
}
