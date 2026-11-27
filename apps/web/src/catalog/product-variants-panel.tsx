import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { withoutRetryAsk } from "@/lib/retry-notice";
import { Alert, AlertDescription } from "@/ui/alert";
import { InsetBlock } from "@/ui/inset-block";
import { RetryButton } from "@/ui/retry-button";
import { Skeleton } from "@/ui/skeleton";
import { focusLater } from "../lib/focus";
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
  /** The variant the address named: its SKU field takes the focus once the variants are shown. */
  focusVariantId: string | null;
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

/** Heights follow `VariantSection` and the SKU and price rows, so the sections that arrive take the place of these. */
function VariantSectionShape({ separated }: { separated: boolean }) {
  return (
    <div
      className={
        separated ? "grid gap-3 border-border border-t pt-4" : "grid gap-3"
      }
      data-variant-shape=""
    >
      <div className="grid gap-1.5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-full" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-ctl-md min-w-0 flex-1 rounded-lg" />
        <Skeleton className="h-ctl-md w-24 rounded-lg" />
      </div>
    </div>
  );
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
          <li key={variant.id}>
            <InsetBlock className="flex items-baseline gap-3 px-3 py-2">
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
            </InsetBlock>
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
  focusVariantId,
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

  // the variant of the address, once: the field is in the page when the variants are shown
  const focused = useRef<boolean>(false);
  useEffect(() => {
    if (focused.current || focusVariantId === null || !configuration) {
      return;
    }
    if (
      !configuration.variants.some((variant) => variant.id === focusVariantId)
    ) {
      return;
    }
    focused.current = true;
    focusLater(() =>
      document.getElementById(`product-variant-sku-${focusVariantId}`)?.focus()
    );
  }, [configuration, focusVariantId]);

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
      <div aria-busy="true" role="status">
        <span className="sr-only">Carregando variantes…</span>
        <div aria-hidden="true" className="grid gap-4">
          <VariantSectionShape separated={false} />
          <VariantSectionShape separated />
        </div>
      </div>
    );
  } else if (loadError) {
    content = (
      <Alert variant="destructive">
        <AlertDescription className="grid justify-items-start gap-2">
          {withoutRetryAsk(loadError)}
          <RetryButton onClick={handleReload} />
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
