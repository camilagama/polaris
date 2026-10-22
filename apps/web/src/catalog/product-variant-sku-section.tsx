import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import { type FormEvent, useCallback, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { rpcErrorCode } from "../lib/rpc-error";
import { useReportUnsentWork } from "../lib/unsent-work";
import { ProductTextField } from "./product-fields";
import {
  VariantFieldRow,
  VariantSaveNotice,
  type VariantSaveOutcome,
  VariantSection,
} from "./product-variant-parts";
import {
  type ProductVariantReadModel,
  variantLabel,
  variantSkuErrorMessage,
} from "./product-variants-model";

interface SkuRowProps {
  disabled: boolean;
  label: string;
  onDraftChange: () => void;
  onSave: (
    variantId: string,
    sku: string
  ) => Promise<string | null | undefined>;
  variant: ProductVariantReadModel;
}

function SkuRow({
  disabled,
  label,
  onDraftChange,
  onSave,
  variant,
}: SkuRowProps) {
  const [sku, setSku] = useState(variant.sku ?? "");
  useReportUnsentWork(sku !== (variant.sku ?? ""));

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const savedSku = await onSave(variant.id, sku);
      if (savedSku !== undefined) {
        setSku(savedSku ?? "");
      }
    },
    [onSave, sku, variant.id]
  );
  const handleChange = useCallback(
    (value: string) => {
      setSku(value);
      onDraftChange();
    },
    [onDraftChange]
  );

  return (
    <VariantFieldRow
      buttonLabel="Salvar SKU"
      disabled={disabled}
      onSubmit={handleSubmit}
    >
      <ProductTextField
        disabled={disabled}
        id={`product-variant-sku-${variant.id}`}
        label={`SKU — ${label}`}
        onChange={handleChange}
        value={sku}
      />
    </VariantFieldRow>
  );
}

interface SkuSectionProps {
  configuration: ProductVariantConfigurationReadModel;
  onConflict: () => void;
  onUpdated: (
    configuration: ProductVariantConfigurationReadModel,
    product: ProductReadModel
  ) => void;
  organizationId: string;
  productId: string;
}

export function ProductVariantSkuSection({
  configuration,
  onConflict,
  onUpdated,
  organizationId,
  productId,
}: SkuSectionProps) {
  const [isPending, setIsPending] = useState(false);
  const [outcome, setOutcome] = useState<VariantSaveOutcome | null>(null);

  const handleSave = useCallback(
    async (variantId: string, sku: string) => {
      setIsPending(true);
      setOutcome(null);
      try {
        const result = await orpcClient.product.setVariantSku({
          expectedVersion: configuration.productVersion,
          organizationId,
          productId,
          sku,
          variantId,
        });
        onUpdated(result.configuration, result.product);
        setOutcome({
          kind: "saved",
          text: result.changed ? "SKU salvo." : "O SKU já está atualizado.",
        });
        return (
          result.configuration.variants.find(
            (variant) => variant.id === variantId
          )?.sku ?? null
        );
      } catch (error: unknown) {
        setOutcome({
          kind: rpcErrorCode(error) === "CONFLICT" ? "conflict" : "error",
          text: variantSkuErrorMessage(error),
        });
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
      help="O SKU é opcional; vazio limpa o código, e o mesmo valor não vale para dois."
      id="product-variant-sku"
      title="SKU das variantes"
    >
      <ul aria-label="SKU das variantes" className="grid gap-3">
        {configuration.variants.map((variant, index) => (
          <li key={variant.id}>
            <SkuRow
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
