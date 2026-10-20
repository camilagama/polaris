import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
  ProductVariantOptionName,
} from "@polaris/contracts";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { orpcClient } from "../lib/orpc";
import { isDraftChanged, useReportUnsentWork } from "../lib/unsent-work";
import { ProductVariantPriceSection } from "./product-variant-price-section";
import "./product-variants-panel.css";

const optionChoices: ReadonlyArray<
  readonly [ProductVariantOptionName, string]
> = [
  ["model", "Modelo"],
  ["color", "Cor"],
  ["size", "Tamanho"],
];

const emptyValueLines: Record<ProductVariantOptionName, string> = {
  color: "",
  model: "",
  size: "",
};
const optionValueLineBreak = /\r?\n/;

interface VariantDraft {
  values: Partial<Record<ProductVariantOptionName, string | undefined>>;
}

interface ProductVariantsPanelProps {
  onClose: () => void;
  onProductUpdated: (product: ProductReadModel) => void;
  organizationId: string;
  product: ProductReadModel;
}

interface ProductVariantOptionCheckboxProps {
  checked: boolean;
  disabled: boolean;
  label: string;
  name: ProductVariantOptionName;
  onToggle: (name: ProductVariantOptionName, checked: boolean) => void;
}

interface ProductOptionValuesFieldProps {
  disabled: boolean;
  lines: string;
  name: ProductVariantOptionName;
  onChange: (name: ProductVariantOptionName, value: string) => void;
}

interface ProductVariantValueSelectProps {
  disabled: boolean;
  index: number;
  name: ProductVariantOptionName;
  onChange: (
    index: number,
    name: ProductVariantOptionName,
    value: string
  ) => void;
  options: string[];
  productId: string;
  value: string;
}

interface ProductVariantCombinationRowProps {
  index: number;
  isPending: boolean;
  onRemove: (index: number) => void;
  onValueChange: (
    index: number,
    name: ProductVariantOptionName,
    value: string
  ) => void;
  optionNames: ProductVariantOptionName[];
  optionValues: Record<ProductVariantOptionName, string[]>;
  productId: string;
  variant: VariantDraft;
}

interface ProductVariantsConfigurationFormProps {
  configuration: ProductVariantConfigurationReadModel;
  onConfigured: (
    configuration: ProductVariantConfigurationReadModel,
    product: ProductReadModel
  ) => void;
  onConflict: () => void;
  organizationId: string;
  product: ProductReadModel;
}

function rpcErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function variantErrorMessage(error: unknown): string {
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return "Não foi possível carregar ou salvar as variantes.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  if (code === "BAD_REQUEST") {
    return "Revise os valores e as combinações informadas.";
  }
  if (code === "NOT_FOUND") {
    return "O produto não existe mais nesta organização.";
  }
  if (code === "CONFLICT") {
    return "O produto mudou ou as variantes já foram configuradas. Atualize a lista.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O catálogo está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível carregar ou salvar as variantes. Tente novamente.";
}

function variantSkuErrorMessage(error: unknown): string {
  if (rpcErrorCode(error) === "CONFLICT") {
    return "O SKU já está em uso nesta organização ou o produto mudou. Atualize as variantes antes de tentar novamente.";
  }
  return variantErrorMessage(error);
}

function parseOptionValues(lines: string): string[] {
  return lines
    .split(optionValueLineBreak)
    .map((value) => value.trim())
    .filter(Boolean);
}

function optionLabel(name: ProductVariantOptionName): string {
  return optionChoices.find(([optionName]) => optionName === name)?.[1] ?? name;
}

function optionValuesError(values: string[]): string | null {
  if (values.length === 0) {
    return "Informe ao menos um valor, um por linha.";
  }
  if (
    new Set(values.map((value) => value.toLowerCase())).size !== values.length
  ) {
    return "Remova valores repetidos nesta opção.";
  }
  return null;
}

function selectedOptionNames(
  selectedOptions: ProductVariantOptionName[]
): ProductVariantOptionName[] {
  return optionChoices
    .map(([name]) => name)
    .filter((name) => selectedOptions.includes(name));
}

function productOptionValues(
  valueLines: Record<ProductVariantOptionName, string>
): Record<ProductVariantOptionName, string[]> {
  return {
    color: parseOptionValues(valueLines.color),
    model: parseOptionValues(valueLines.model),
    size: parseOptionValues(valueLines.size),
  };
}

function validateVariantDrafts(
  optionNames: ProductVariantOptionName[],
  optionValues: Record<ProductVariantOptionName, string[]>,
  variants: VariantDraft[]
) {
  const invalidOptions = optionNames.filter((name) =>
    optionValuesError(optionValues[name])
  );
  const completeVariants = variants.every((variant) => {
    const keys = Object.keys(variant.values).filter((name) =>
      optionNames.includes(name as ProductVariantOptionName)
    );
    return (
      keys.length === optionNames.length &&
      optionNames.every((name) => {
        const value = variant.values[name];
        return typeof value === "string" && optionValues[name].includes(value);
      })
    );
  });
  const combinationKeys = variants.map((variant) =>
    JSON.stringify(
      optionNames.map((name) =>
        (variant.values[name] ?? "").trim().toLowerCase()
      )
    )
  );
  const combinationsAreUnique =
    new Set(combinationKeys).size === combinationKeys.length;

  return {
    canAdd:
      optionNames.length > 0 &&
      invalidOptions.length === 0 &&
      variants.length < 50,
    canSubmit:
      optionNames.length > 0 &&
      invalidOptions.length === 0 &&
      variants.length > 0 &&
      variants.length <= 50 &&
      completeVariants &&
      combinationsAreUnique,
    combinationsAreUnique,
    invalidOptions,
  };
}

function ProductVariantOptionCheckbox({
  checked,
  disabled,
  label,
  name,
  onToggle,
}: ProductVariantOptionCheckboxProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onToggle(name, event.currentTarget.checked),
    [name, onToggle]
  );

  return (
    <label className="product-variants-checkbox">
      <input
        checked={checked}
        disabled={disabled}
        onChange={handleChange}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

function ProductOptionValuesField({
  disabled,
  lines,
  name,
  onChange,
}: ProductOptionValuesFieldProps) {
  const fieldId = `product-variant-values-${name}`;
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      onChange(name, event.currentTarget.value),
    [name, onChange]
  );
  const values = parseOptionValues(lines);
  const issue = optionValuesError(values);

  return (
    <div className="product-form-field">
      <label className="field-label" htmlFor={fieldId}>
        Valores de {optionLabel(name)}
      </label>
      <textarea
        aria-describedby={`${fieldId}-help`}
        disabled={disabled}
        id={fieldId}
        onChange={handleChange}
        rows={3}
        value={lines}
      />
      <p className="field-help" id={`${fieldId}-help`}>
        Digite um valor por linha. Espaços externos são removidos; a caixa
        digitada será preservada.
      </p>
      {issue ? (
        <p className="product-variants-field-error" role="alert">
          {issue}
        </p>
      ) : null}
    </div>
  );
}

function ProductVariantValueSelect({
  disabled,
  index,
  name,
  onChange,
  options,
  productId,
  value,
}: ProductVariantValueSelectProps) {
  const fieldId = `product-variant-${productId}-${index}-${name}`;
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onChange(index, name, event.currentTarget.value),
    [index, name, onChange]
  );

  return (
    <div className="product-form-field">
      <label className="field-label" htmlFor={fieldId}>
        {optionLabel(name)}
      </label>
      <select
        disabled={disabled || options.length === 0}
        id={fieldId}
        onChange={handleChange}
        value={value}
      >
        <option value="">Selecione</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

function ProductVariantCombinationRow({
  index,
  isPending,
  onRemove,
  onValueChange,
  optionNames,
  optionValues,
  productId,
  variant,
}: ProductVariantCombinationRowProps) {
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);

  return (
    <li className="product-variants-combination">
      <span className="product-variant-number">{index + 1}</span>
      {optionNames.map((name) => (
        <ProductVariantValueSelect
          disabled={isPending}
          index={index}
          key={name}
          name={name}
          onChange={onValueChange}
          options={optionValues[name]}
          productId={productId}
          value={variant.values[name] ?? ""}
        />
      ))}
      <button
        aria-label={`Remover combinação ${index + 1}`}
        className="quiet-button"
        disabled={isPending}
        onClick={handleRemove}
        type="button"
      >
        Remover
      </button>
    </li>
  );
}

function ProductVariantConfigurationForm({
  configuration,
  onConflict,
  onConfigured,
  organizationId,
  product,
}: ProductVariantsConfigurationFormProps) {
  const [selectedOptions, setSelectedOptions] = useState<
    ProductVariantOptionName[]
  >([]);
  const [valueLines, setValueLines] = useState(emptyValueLines);
  const [variants, setVariants] = useState<VariantDraft[]>([]);
  const [isPending, setIsPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // picked options, typed values or combinations that were not saved yet
  useReportUnsentWork(
    selectedOptions.length > 0 ||
      variants.length > 0 ||
      isDraftChanged(valueLines, emptyValueLines)
  );
  const optionNames = selectedOptionNames(selectedOptions);
  const optionValues = productOptionValues(valueLines);
  const validation = validateVariantDrafts(optionNames, optionValues, variants);
  const defaultVariantHasSku = configuration.variants.some(
    (variant) => variant.isDefault && variant.sku !== null
  );

  const handleToggleOption = useCallback(
    (name: ProductVariantOptionName, isSelected: boolean) => {
      setSelectedOptions((current) => {
        if (isSelected) {
          return current.includes(name) ? current : [...current, name];
        }
        return current.filter((option) => option !== name);
      });
      setVariants((current) =>
        current.map((variant) => {
          const values = { ...variant.values };
          if (isSelected) {
            values[name] = "";
          } else {
            delete values[name];
          }
          return { values };
        })
      );
      setSaveError(null);
    },
    []
  );

  const handleValueLinesChange = useCallback(
    (name: ProductVariantOptionName, value: string) => {
      setValueLines((current) => ({ ...current, [name]: value }));
      setSaveError(null);
    },
    []
  );

  const handleAddCombination = useCallback(() => {
    if (!validation.canAdd) {
      return;
    }
    const values: VariantDraft["values"] = {};
    for (const name of optionNames) {
      values[name] = "";
    }
    setVariants((current) => [...current, { values }]);
    setSaveError(null);
  }, [optionNames, validation.canAdd]);

  const handleValueChange = useCallback(
    (index: number, name: ProductVariantOptionName, value: string) => {
      setVariants((current) =>
        current.map((variant, variantIndex) => {
          if (variantIndex !== index) {
            return variant;
          }
          return { values: { ...variant.values, [name]: value } };
        })
      );
      setSaveError(null);
    },
    []
  );

  const handleRemoveCombination = useCallback((index: number) => {
    setVariants((current) =>
      current.filter((_, variantIndex) => variantIndex !== index)
    );
    setSaveError(null);
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!validation.canSubmit || defaultVariantHasSku) {
        return;
      }

      setIsPending(true);
      setSaveError(null);
      try {
        const result = await orpcClient.product.configureVariants({
          expectedVersion: configuration.productVersion,
          id: product.id,
          options: optionNames.map((name) => ({
            name,
            values: optionValues[name],
          })),
          organizationId,
          variants: variants.map((variant) => ({ values: variant.values })),
        });
        onConfigured(result.configuration, result.product);
      } catch (error: unknown) {
        setSaveError(variantErrorMessage(error));
        if (rpcErrorCode(error) === "CONFLICT") {
          onConflict();
        }
      } finally {
        setIsPending(false);
      }
    },
    [
      configuration.productVersion,
      defaultVariantHasSku,
      onConflict,
      onConfigured,
      optionNames,
      optionValues,
      organizationId,
      product.id,
      validation.canSubmit,
      variants,
    ]
  );

  return (
    <form className="product-variants-form" onSubmit={handleSubmit}>
      <p className="product-variants-help">
        Escolha as opções e cadastre cada combinação vendável. O sistema não
        cria combinações automaticamente.
      </p>
      {defaultVariantHasSku ? (
        <p className="product-variants-field-error" role="status">
          Limpe o SKU da variante padrão acima antes de configurar opções; essa
          configuração substituirá a variante padrão.
        </p>
      ) : null}

      <fieldset className="product-variants-option-picker">
        <legend>Opções do produto</legend>
        <div className="product-variants-option-choices">
          {optionChoices.map(([name, label]) => (
            <ProductVariantOptionCheckbox
              checked={selectedOptions.includes(name)}
              disabled={isPending}
              key={name}
              label={label}
              name={name}
              onToggle={handleToggleOption}
            />
          ))}
        </div>
      </fieldset>

      {optionNames.length > 0 ? (
        <div className="product-variants-values-grid">
          {optionNames.map((name) => (
            <ProductOptionValuesField
              disabled={isPending}
              key={name}
              lines={valueLines[name]}
              name={name}
              onChange={handleValueLinesChange}
            />
          ))}
        </div>
      ) : (
        <p className="product-variants-help">
          Selecione pelo menos uma opção para começar.
        </p>
      )}

      <div className="product-variants-combinations-heading">
        <div>
          <h3>Combinações vendáveis</h3>
          <p className="field-help">
            Cada combinação precisa de um valor para cada opção selecionada.
          </p>
        </div>
        <span aria-live="polite" className="category-count">
          {variants.length}/50
        </span>
      </div>

      {variants.length > 0 ? (
        <ol className="product-variants-combinations">
          {variants.map((variant, index) => (
            <ProductVariantCombinationRow
              index={index}
              isPending={isPending}
              key={index}
              onRemove={handleRemoveCombination}
              onValueChange={handleValueChange}
              optionNames={optionNames}
              optionValues={optionValues}
              productId={product.id}
              variant={variant}
            />
          ))}
        </ol>
      ) : (
        <p className="product-variants-empty">Nenhuma combinação adicionada.</p>
      )}

      <div className="product-variants-actions">
        <button
          className="quiet-button"
          disabled={!validation.canAdd || isPending}
          onClick={handleAddCombination}
          type="button"
        >
          Adicionar combinação
        </button>
        <button
          className="primary-button"
          disabled={!validation.canSubmit || defaultVariantHasSku || isPending}
          type="submit"
        >
          {isPending ? "Salvando…" : "Salvar variantes"}
        </button>
      </div>

      {!validation.combinationsAreUnique && variants.length > 1 ? (
        <p className="product-variants-field-error" role="alert">
          Cada combinação precisa ser única.
        </p>
      ) : null}
      {saveError ? (
        <p className="categories-message is-error" role="alert">
          {saveError}
        </p>
      ) : null}
    </form>
  );
}

type ProductVariantReadModel =
  ProductVariantConfigurationReadModel["variants"][number];

interface ProductVariantSkuRowProps {
  disabled: boolean;
  label: string;
  onDraftChange: () => void;
  onSave: (
    variantId: string,
    sku: string
  ) => Promise<string | null | undefined>;
  variant: ProductVariantReadModel;
}

function ProductVariantSkuRow({
  disabled,
  label,
  onDraftChange,
  onSave,
  variant,
}: ProductVariantSkuRowProps) {
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
    (event: ChangeEvent<HTMLInputElement>) => {
      setSku(event.currentTarget.value);
      onDraftChange();
    },
    [onDraftChange]
  );

  return (
    <form className="product-variant-sku-row" onSubmit={handleSubmit}>
      <label className="product-form-field">
        <span>SKU — {label}</span>
        <input
          autoComplete="off"
          disabled={disabled}
          onChange={handleChange}
          type="text"
          value={sku}
        />
      </label>
      <button className="quiet-button" disabled={disabled} type="submit">
        Salvar SKU
      </button>
    </form>
  );
}

function ProductVariantSkuSection({
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
  const labels = new Map(optionChoices.map(([name, label]) => [name, label]));

  const handleSave = useCallback(
    async (variantId: string, sku: string) => {
      setIsPending(true);
      setMessage(null);
      setNeedsReload(false);
      try {
        const result = await orpcClient.product.setVariantSku({
          expectedVersion: configuration.productVersion,
          organizationId,
          productId,
          sku,
          variantId,
        });
        onUpdated(result.configuration, result.product);
        setMessage(result.changed ? "SKU salvo." : "O SKU já está atualizado.");
        return (
          result.configuration.variants.find(
            (variant) => variant.id === variantId
          )?.sku ?? null
        );
      } catch (error: unknown) {
        const code = rpcErrorCode(error);
        setMessage(variantSkuErrorMessage(error));
        setNeedsReload(code === "CONFLICT");
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
      <h3>SKU das variantes</h3>
      <p className="product-variants-help">
        O SKU é opcional. Deixe o campo vazio para limpar o código; valores
        repetidos na organização são rejeitados.
      </p>
      <ul aria-label="SKU das variantes" className="product-variant-sku-list">
        {configuration.variants.map((variant, index) => {
          const label =
            variant.isDefault && variant.values.length === 0
              ? "Variante padrão"
              : variant.values
                  .map(
                    (value) =>
                      `${labels.get(value.optionName) ?? value.optionName}: ${value.optionValueName}`
                  )
                  .join(" · ") || `Variante ${index + 1}`;
          return (
            <li key={variant.id}>
              <ProductVariantSkuRow
                disabled={isPending}
                label={label}
                onDraftChange={handleDraftChange}
                onSave={handleSave}
                variant={variant}
              />
            </li>
          );
        })}
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

function VariantConfigurationView({
  configuration,
}: {
  configuration: ProductVariantConfigurationReadModel;
}) {
  const labels = new Map(optionChoices.map(([name, label]) => [name, label]));

  return (
    <div className="product-variants-summary">
      <p className="product-variants-count" role="status">
        {configuration.variants.length} de 50 variantes
      </p>
      <ul aria-label="Variantes cadastradas" className="product-variant-list">
        {configuration.variants.map((variant, index) => (
          <li className="product-variant-row" key={variant.id}>
            <span className="product-variant-number">{index + 1}</span>
            <span className="product-variant-values">
              {variant.values
                .map(
                  (value) =>
                    `${labels.get(value.optionName) ?? value.optionName}: ${value.optionValueName}`
                )
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      <p className="product-variants-help">
        Esta etapa permite a configuração inicial. Edição ou remoção aguarda as
        regras de preservação dos IDs usados por SKU e estoque.
      </p>
    </div>
  );
}

export function ProductVariantsPanel({
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
          setLoadError(variantErrorMessage(error));
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

  let content: ReactNode;
  if (isLoading) {
    content = (
      <p className="product-variants-message" role="status">
        Carregando variantes…
      </p>
    );
  } else if (loadError) {
    content = (
      <div className="product-variants-message">
        <p className="categories-message is-error" role="alert">
          {loadError}
        </p>
        <button className="quiet-button" onClick={handleReload} type="button">
          Tentar novamente
        </button>
      </div>
    );
  } else if (configuration?.configured) {
    content = <VariantConfigurationView configuration={configuration} />;
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
  } else {
    content = null;
  }

  return (
    <section
      aria-labelledby="product-variants-heading"
      className="product-form-panel product-variants-panel"
    >
      <div className="product-form-heading">
        <div>
          <p className="categories-eyebrow">Variantes</p>
          <h2 id="product-variants-heading">{product.name}</h2>
        </div>
        <button className="quiet-button" onClick={onClose} type="button">
          Fechar
        </button>
      </div>
      {notice ? (
        <p className="categories-message is-success" role="status">
          {notice}
        </p>
      ) : null}
      {!(isLoading || loadError) && configuration ? (
        <ProductVariantSkuSection
          configuration={configuration}
          onConflict={handleConflict}
          onUpdated={handleSkuUpdated}
          organizationId={organizationId}
          productId={product.id}
        />
      ) : null}
      {!(isLoading || loadError) && configuration ? (
        <ProductVariantPriceSection
          configuration={configuration}
          onConflict={handleConflict}
          onUpdated={handleSkuUpdated}
          organizationId={organizationId}
          productId={product.id}
        />
      ) : null}
      {content}
    </section>
  );
}
