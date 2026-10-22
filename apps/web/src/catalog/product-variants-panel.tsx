import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
} from "@polaris/contracts";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/card";
import { orpcClient } from "../lib/orpc";
import { ProductVariantPriceSection } from "./product-variant-price-section";
import { ProductVariantSkuSection } from "./product-variant-sku-section";
import { ProductVariantConfigurationForm } from "./product-variants-form";
import {
  MAX_VARIANTS,
  optionLabel,
  variantErrorMessage,
} from "./product-variants-model";

interface ProductVariantsPanelProps {
  /** Where the focus goes when the panel opens: the title, which names what the person is about to edit. */
  headingRef?: Ref<HTMLDivElement>;
  onClose: () => void;
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

export function ProductVariantsPanel({
  headingRef,
  onClose,
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
      <CardContent>
        <p className="text-muted-foreground text-support" role="status">
          Carregando variantes…
        </p>
      </CardContent>
    );
  } else if (loadError) {
    content = (
      <CardContent>
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {loadError}
            <Button
              onClick={handleReload}
              size="sm"
              type="button"
              variant="link"
            >
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      </CardContent>
    );
  } else if (configuration?.configured) {
    content = <ConfiguredVariants configuration={configuration} />;
  } else if (configuration) {
    content = (
      <ProductVariantConfigurationForm
        configuration={configuration}
        onConfigured={handleConfigured}
        onConflict={handleConflict}
        organizationId={organizationId}
        product={product}
      />
    );
  }

  return (
    <Card aria-labelledby="product-variants-heading" role="region">
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] items-center">
        <div
          className="grid gap-0.5 outline-none"
          ref={headingRef}
          tabIndex={-1}
        >
          <CardTitle
            aria-level={2}
            className="[overflow-wrap:anywhere]"
            id="product-variants-heading"
            role="heading"
          >
            {product.name}
          </CardTitle>
          <CardDescription>Variantes</CardDescription>
        </div>
        <Button onClick={onClose} size="sm" type="button" variant="ghost">
          Fechar
        </Button>
      </CardHeader>
      {notice ? (
        <CardContent>
          <Alert>
            <CircleCheckIcon aria-hidden="true" />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        </CardContent>
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
    </Card>
  );
}
