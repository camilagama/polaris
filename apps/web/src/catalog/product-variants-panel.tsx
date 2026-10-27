import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { orpcClient } from "../lib/orpc";
import { ProductVariantPriceSection } from "./product-variant-price-section";
import { ProductVariantSkuSection } from "./product-variant-sku-section";
import { ProductVariantConfigurationForm } from "./product-variants-form";
import {
  MAX_VARIANTS,
  optionLabel,
  type VariantConfigurationDraft,
  variantErrorMessage,
} from "./product-variants-model";

interface ProductVariantsPanelProps {
  /** What was typed in the configuration before the dialog closed by Esc, × or the step back. */
  configurationDraft: VariantConfigurationDraft | null;
  onConfigurationDraftChange: (
    productId: string,
    draft: VariantConfigurationDraft | null
  ) => void;
  onProductUpdated: (product: ProductReadModel) => void;
  organizationId: string;
  product: ProductReadModel;
}

function ConfiguredVariants({
  configuration,
}: {
  configuration: ProductVariantConfigurationReadModel;
}) {
  return (
    <section
      aria-labelledby="product-variants-configured-title"
      className="grid gap-3 border-border border-t px-(--card-spacing) pt-4"
    >
      <div className="grid gap-0.5">
        <h3 className="text-section" id="product-variants-configured-title">
          Variantes cadastradas
        </h3>
        <p className="text-muted-foreground text-support" role="status">
          {configuration.variants.length} de {MAX_VARIANTS} variantes. Por
          enquanto só a configuração inicial; editar ou remover vem depois.
        </p>
      </div>
      <ul aria-label="Variantes cadastradas" className="grid gap-2">
        {configuration.variants.map((variant, index) => (
          <li
            className="flex items-baseline gap-3 rounded-lg bg-muted px-3 py-2"
            key={variant.id}
          >
            <span className="text-muted-foreground text-support tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {variant.values
                .map(
                  (value) =>
                    `${optionLabel(value.optionName)}: ${value.optionValueName}`
                )
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The tab "Variantes" of the product dialog: the SKU and the price of each variant, and the first configuration of the
 * options. Each part saves by its own button, as before the dialog; the dialog's title names the product.
 */
export function ProductVariantsPanel({
  configurationDraft,
  onConfigurationDraftChange,
  onProductUpdated,
  organizationId,
  product,
}: ProductVariantsPanelProps) {
  const [configuration, setConfiguration] =
    useState<ProductVariantConfigurationReadModel | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let current = true;
    setIsLoading(true);
    setLoadError(null);
    orpcClient.product
      .getVariants({ id: product.id, organizationId })
      .then((result) => {
        if (current) {
          setConfiguration(result);
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setLoadError(variantErrorMessage(error, "as variantes"));
        }
      })
      .finally(() => {
        if (current) {
          setIsLoading(false);
        }
      });

    return () => {
      current = false;
    };
  }, [organizationId, product.id, reloadVersion]);

  // configured meanwhile (another device, or the read after a conflict): a draft of the first configuration is moot
  const configured = configuration?.configured === true;
  useEffect(() => {
    if (configured && configurationDraft !== null) {
      onConfigurationDraftChange(product.id, null);
    }
  }, [configurationDraft, configured, onConfigurationDraftChange, product.id]);

  const handleReload = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  const handleConflict = useCallback(() => {
    handleReload();
    onProductUpdated(product);
  }, [handleReload, onProductUpdated, product]);

  const handleConfigured = useCallback(
    (
      resultConfiguration: ProductVariantConfigurationReadModel,
      updatedProduct: ProductReadModel
    ) => {
      setConfiguration(resultConfiguration);
      setNotice("Variantes configuradas e salvas.");
      onProductUpdated(updatedProduct);
    },
    [onProductUpdated]
  );

  const handleSkuUpdated = useCallback(
    (
      resultConfiguration: ProductVariantConfigurationReadModel,
      updatedProduct: ProductReadModel
    ) => {
      setConfiguration(resultConfiguration);
      onProductUpdated(updatedProduct);
    },
    [onProductUpdated]
  );

  const ready = !(isLoading || loadError) && configuration;
  let content: ReactNode = null;
  if (isLoading) {
    content = (
      <p className="text-muted-foreground text-support" role="status">
        Carregando variantes…
      </p>
    );
  } else if (loadError) {
    content = (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {loadError}
          <Button onClick={handleReload} size="sm" type="button" variant="link">
            Tentar novamente
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (configuration?.configured) {
    content = <ConfiguredVariants configuration={configuration} />;
  } else if (configuration) {
    content = (
      <ProductVariantConfigurationForm
        configuration={configuration}
        draft={configurationDraft}
        onConfigured={handleConfigured}
        onConflict={handleConflict}
        onDraftChange={onConfigurationDraftChange}
        onSkuCleared={handleSkuUpdated}
        organizationId={organizationId}
        product={product}
      />
    );
  }

  // no card around it: the sections keep their rules between them, without the side spacing of a card
  return (
    <div className="grid gap-4 [--card-spacing:0px] [&>:first-child]:border-t-0 [&>:first-child]:pt-0">
      {notice ? (
        <Alert>
          <CircleCheckIcon aria-hidden="true" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {ready ? (
        <>
          <ProductVariantSkuSection
            configuration={configuration}
            onConflict={handleConflict}
            onUpdated={handleSkuUpdated}
            organizationId={organizationId}
            productId={product.id}
          />
          <ProductVariantPriceSection
            configuration={configuration}
            onConflict={handleConflict}
            onUpdated={handleSkuUpdated}
            organizationId={organizationId}
            productId={product.id}
          />
        </>
      ) : null}
      {content}
    </div>
  );
}
