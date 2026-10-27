import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { focusLater } from "../lib/focus";
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
  duplicateSkuMessage,
  isDuplicateSkuError,
  type ProductVariantReadModel,
  variantLabel,
  variantSkuErrorMessage,
} from "./product-variants-model";

/** The SKU another variant already has, said at the field of the variant that was typed (U-14). */
interface SkuFieldError {
  text: string;
  variantId: string;
}

interface SkuRowProps {
  disabled: boolean;
  /** Set when this row is the one whose SKU was refused as a duplicate. */
  error: string | undefined;
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
  error,
  label,
  onDraftChange,
  onSave,
  variant,
}: SkuRowProps) {
  const [sku, setSku] = useState(variant.sku ?? "");
  // a SKU saved from elsewhere (the warning's "Limpar SKU … da variante padrão") shows in the field: that button clears
  // it; a reload of the variants draws the rows again, so nothing typed is kept across one anyway
  const [savedSku, setSavedSku] = useState(variant.sku);
  if (savedSku !== variant.sku) {
    setSavedSku(variant.sku);
    setSku(variant.sku ?? "");
  }
  const inputRef = useRef<HTMLInputElement>(null);
  useReportUnsentWork(sku !== (variant.sku ?? ""));
  // the refused SKU is said at this field, and the focus goes to it (the row is disabled while the save is in flight)
  useEffect(() => {
    if (error) {
      focusLater(() => inputRef.current?.focus());
    }
  }, [error]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const answered = await onSave(variant.id, sku);
      if (answered !== undefined) {
        setSku(answered ?? "");
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
      error={
        error
          ? { id: `product-variant-sku-${variant.id}-error`, text: error }
          : undefined
      }
      onSubmit={handleSubmit}
    >
      <ProductTextField
        disabled={disabled}
        error={error}
        errorOutside
        id={`product-variant-sku-${variant.id}`}
        inputRef={inputRef}
        label={`SKU · ${label}`}
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
  const [fieldError, setFieldError] = useState<SkuFieldError | null>(null);

  const handleSave = useCallback(
    async (variantId: string, sku: string) => {
      setIsPending(true);
      setOutcome(null);
      setFieldError(null);
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
        if (isDuplicateSkuError(error)) {
          setFieldError({ text: duplicateSkuMessage(sku), variantId });
          return;
        }
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
    setFieldError(null);
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
              error={
                fieldError?.variantId === variant.id
                  ? fieldError.text
                  : undefined
              }
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
