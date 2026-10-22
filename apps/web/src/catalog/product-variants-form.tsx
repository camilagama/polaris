import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
  ProductVariantOptionName,
} from "@polaris/contracts";
import CirclePlusIcon from "lucide-react/dist/esm/icons/circle-plus";
import { type FormEvent, useCallback, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { FieldLegend, FieldSet } from "@/ui/field";
import { Label } from "@/ui/label";
import { orpcClient } from "../lib/orpc";
import { rpcErrorCode } from "../lib/rpc-error";
import { isDraftChanged, useReportUnsentWork } from "../lib/unsent-work";
import { SelectField } from "../sales/sale-fields";
import { ProductTextAreaField } from "./product-fields";
import {
  emptyValueLines,
  MAX_VARIANTS,
  optionChoices,
  optionLabel,
  optionValuesError,
  parseOptionValues,
  productOptionValues,
  selectedOptionNames,
  type VariantDraft,
  validateVariantDrafts,
  variantErrorMessage,
} from "./product-variants-model";

interface OptionCheckboxProps {
  checked: boolean;
  disabled: boolean;
  label: string;
  name: ProductVariantOptionName;
  onToggle: (name: ProductVariantOptionName, checked: boolean) => void;
}

function OptionCheckbox({
  checked,
  disabled,
  label,
  name,
  onToggle,
}: OptionCheckboxProps) {
  const handleChange = useCallback(
    (next: boolean) => onToggle(name, next),
    [name, onToggle]
  );
  return (
    <Label className="min-h-ctl-md">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={handleChange}
      />
      {label}
    </Label>
  );
}

interface OptionValuesFieldProps {
  disabled: boolean;
  lines: string;
  name: ProductVariantOptionName;
  onChange: (name: ProductVariantOptionName, value: string) => void;
}

function OptionValuesField({
  disabled,
  lines,
  name,
  onChange,
}: OptionValuesFieldProps) {
  const handleChange = useCallback(
    (value: string) => onChange(name, value),
    [name, onChange]
  );
  return (
    <ProductTextAreaField
      disabled={disabled}
      error={optionValuesError(parseOptionValues(lines)) ?? undefined}
      hint="Um valor por linha; a caixa digitada é preservada."
      id={`product-variant-values-${name}`}
      label={`Valores de ${optionLabel(name)}`}
      onChange={handleChange}
      value={lines}
    />
  );
}

interface CombinationRowProps {
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

function CombinationRow({
  index,
  isPending,
  onRemove,
  onValueChange,
  optionNames,
  optionValues,
  productId,
  variant,
}: CombinationRowProps) {
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  const handleChange = useCallback(
    (name: ProductVariantOptionName) => (value: string) =>
      onValueChange(index, name, value),
    [index, onValueChange]
  );
  return (
    <li className="grid gap-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge>Combinação {index + 1}</Badge>
        <Button
          aria-label={`Remover combinação ${index + 1}`}
          disabled={isPending}
          onClick={handleRemove}
          size="sm"
          type="button"
          variant="ghost"
        >
          Remover
        </Button>
      </div>
      <div className="grid gap-3 min-[30rem]:grid-cols-2">
        {optionNames.map((name) => (
          <SelectField
            disabled={isPending || optionValues[name].length === 0}
            id={`product-variant-${productId}-${index}-${name}`}
            key={name}
            label={optionLabel(name)}
            onChange={handleChange(name)}
            options={optionValues[name].map((option) => ({
              id: option,
              label: option,
            }))}
            placeholder="Selecione"
            value={variant.values[name] ?? ""}
          />
        ))}
      </div>
    </li>
  );
}

interface ConfigurationFormProps {
  configuration: ProductVariantConfigurationReadModel;
  onConfigured: (
    configuration: ProductVariantConfigurationReadModel,
    product: ProductReadModel
  ) => void;
  onConflict: () => void;
  organizationId: string;
  product: ProductReadModel;
}

/** The first configuration of the options and of the sellable combinations of a product. */
export function ProductVariantConfigurationForm({
  configuration,
  onConflict,
  onConfigured,
  organizationId,
  product,
}: ConfigurationFormProps) {
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
    <form
      className="grid gap-4 border-border border-t px-(--card-spacing) pt-4"
      noValidate
      onSubmit={handleSubmit}
    >
      <div className="grid gap-0.5">
        <h3 className="text-section">Opções e combinações</h3>
        <p className="text-muted-foreground text-support">
          Escolha as opções e cadastre cada combinação vendável; nenhuma é
          criada sozinha.
        </p>
      </div>
      {defaultVariantHasSku ? (
        <Alert variant="warning">
          <AlertDescription>
            Limpe o SKU da variante padrão antes de configurar opções: a
            configuração a substitui.
          </AlertDescription>
        </Alert>
      ) : null}

      <FieldSet>
        <FieldLegend variant="label">Opções do produto</FieldLegend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {optionChoices.map(([name, label]) => (
            <OptionCheckbox
              checked={selectedOptions.includes(name)}
              disabled={isPending}
              key={name}
              label={label}
              name={name}
              onToggle={handleToggleOption}
            />
          ))}
        </div>
      </FieldSet>

      {optionNames.length > 0 ? (
        <div className="grid gap-4 min-[30rem]:grid-cols-2">
          {optionNames.map((name) => (
            <OptionValuesField
              disabled={isPending}
              key={name}
              lines={valueLines[name]}
              name={name}
              onChange={handleValueLinesChange}
            />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-support">
          Marque ao menos uma opção para começar.
        </p>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 className="text-section">Combinações vendáveis</h3>
          <p className="text-muted-foreground text-support">
            Cada combinação leva um valor para cada opção marcada.
          </p>
        </div>
        <Badge aria-live="polite">
          {variants.length}/{MAX_VARIANTS}
        </Badge>
      </div>

      {variants.length > 0 ? (
        <ol className="grid gap-3">
          {variants.map((variant, index) => (
            <CombinationRow
              index={index}
              isPending={isPending}
              // combinations have no identity before they are saved: the position is the key
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
        <p className="text-muted-foreground text-support">
          Nenhuma combinação adicionada.
        </p>
      )}

      {!validation.combinationsAreUnique && variants.length > 1 ? (
        <Alert variant="destructive">
          <AlertDescription>
            Cada combinação precisa ser única.
          </AlertDescription>
        </Alert>
      ) : null}
      {saveError ? (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-3 min-[30rem]:flex-row min-[30rem]:justify-end">
        <Button
          disabled={!validation.canAdd || isPending}
          onClick={handleAddCombination}
          type="button"
          variant="outline"
        >
          <CirclePlusIcon aria-hidden="true" data-icon="inline-start" />
          Adicionar combinação
        </Button>
        <Button
          disabled={!validation.canSubmit || defaultVariantHasSku || isPending}
          type="submit"
        >
          {isPending ? "Salvando…" : "Salvar variantes"}
        </Button>
      </div>
    </form>
  );
}
