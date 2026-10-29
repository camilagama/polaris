import type {
  ProductReadModel,
  ProductVariantConfigurationReadModel,
  ProductVariantOptionName,
} from "@polaris/contracts";
import CirclePlusIcon from "lucide-react/dist/esm/icons/circle-plus";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { FieldLegend, FieldSet } from "@/ui/field";
import { Label } from "@/ui/label";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { rpcErrorCode } from "../lib/rpc-error";
import { useHoldSwap } from "../lib/unsent-work";
import { SelectField } from "../sales/sale-fields";
import {
  LimitHelp,
  useLimitFocus,
  useLimitHelp,
} from "../subscription/limit-help";
import { isLimitReached } from "../subscription/limit-help-model";
import { ProductTextAreaField } from "./product-fields";
import {
  clearDefaultSkuLabel,
  clearedDefaultSkuNotice,
  emptyConfigurationDraft,
  isConfigurationDraftEmpty,
  MAX_VARIANTS,
  optionChoices,
  optionLabel,
  optionValuesError,
  parseOptionValues,
  productOptionValues,
  selectedOptionNames,
  type VariantConfigurationDraft,
  type VariantDraft,
  validateVariantDrafts,
  VARIANT_LIMIT_REACHED,
  variantErrorMessage,
  variantSkuErrorMessage,
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
  /** What was typed before the dialog closed by Esc, × or the step back; `null` starts empty. */
  draft: VariantConfigurationDraft | null;
  onConfigured: (
    configuration: ProductVariantConfigurationReadModel,
    product: ProductReadModel
  ) => void;
  onConflict: () => void;
  /** Each change of what was typed for the product (`null` when nothing is), for the dialog to keep it while closed. */
  onDraftChange: (
    productId: string,
    draft: VariantConfigurationDraft | null
  ) => void;
  /** The SKU of the default variant was cleared from the warning: the configuration that came back. */
  onSkuCleared: (
    configuration: ProductVariantConfigurationReadModel,
    product: ProductReadModel
  ) => void;
  organizationId: string;
  product: ProductReadModel;
}

/** The first configuration of the options and of the sellable combinations of a product. */
export function ProductVariantConfigurationForm({
  configuration,
  draft,
  onConflict,
  onConfigured,
  onDraftChange,
  onSkuCleared,
  organizationId,
  product,
}: ConfigurationFormProps) {
  const initial = draft ?? emptyConfigurationDraft;
  const [selectedOptions, setSelectedOptions] = useState<
    ProductVariantOptionName[]
  >(initial.selectedOptions);
  const [valueLines, setValueLines] = useState(initial.valueLines);
  const [variants, setVariants] = useState<VariantDraft[]>(initial.variants);
  const [isPending, setIsPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // the plan's limit refused the save (L1 of the corte 1.6): the way to the Pro goes with the text, which takes the focus
  const limitHelp = useLimitHelp();
  const saveErrorRef = useRef<HTMLDivElement>(null);
  const focusLimit = useLimitFocus(saveErrorRef);
  // a failure of the warning's button, said under the warning
  const [clearError, setClearError] = useState<string | null>(null);
  // what the warning's button did, said after it: the SKU that was erased
  const [clearedNotice, setClearedNotice] = useState<string | null>(null);
  // picked options, typed values or combinations that were not saved yet
  const unsaved = !isConfigurationDraftEmpty({
    selectedOptions,
    valueLines,
    variants,
  });
  useHoldSwap(unsaved);
  // the dialog keeps what was typed while it is closed by Esc, × or the step back, as it keeps the data
  useEffect(() => {
    onDraftChange(
      product.id,
      unsaved ? { selectedOptions, valueLines, variants } : null
    );
  }, [
    onDraftChange,
    product.id,
    selectedOptions,
    unsaved,
    valueLines,
    variants,
  ]);
  const optionNames = selectedOptionNames(selectedOptions);
  const optionValues = productOptionValues(valueLines);
  const validation = validateVariantDrafts(optionNames, optionValues, variants);
  // a value over its limit keeps the save reachable and off, reading the message of each field that has one
  const tooLongReason =
    validation.tooLongOptions.length > 0
      ? validation.tooLongOptions
          .map((name) => `product-variant-values-${name}-error`)
          .join(" ")
      : undefined;
  const defaultVariant = configuration.variants.find(
    (variant) => variant.isDefault
  );
  const defaultVariantHasSku =
    defaultVariant !== undefined && defaultVariant.sku !== null;
  const defaultSku = defaultVariant?.sku ?? null;

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
      setClearedNotice(null);
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
        // saved: nothing typed is left to keep
        onDraftChange(product.id, null);
        onConfigured(result.configuration, result.product);
      } catch (error: unknown) {
        setSaveError(variantErrorMessage(error));
        if (isLimitReached(error)) {
          // nothing changed on the server: the form stays as typed, with the way to the Pro
          limitHelp.show("variants");
          focusLimit();
        } else if (rpcErrorCode(error) === "CONFLICT") {
          onConflict();
        }
      } finally {
        setIsPending(false);
      }
    },
    [
      configuration.productVersion,
      defaultVariantHasSku,
      focusLimit,
      limitHelp.show,
      onConflict,
      onConfigured,
      onDraftChange,
      optionNames,
      optionValues,
      organizationId,
      product.id,
      validation.canSubmit,
      variants,
    ]
  );

  /** The warning's way out: the SKU of the default variant is cleared (saved empty), and its field takes the focus. */
  const handleClearDefaultSku = useCallback(async () => {
    if (!defaultVariant || isPending) {
      return;
    }
    const clearedSku = defaultVariant.sku;
    setIsPending(true);
    setClearError(null);
    setClearedNotice(null);
    try {
      const result = await orpcClient.product.setVariantSku({
        expectedVersion: configuration.productVersion,
        organizationId,
        productId: product.id,
        sku: "",
        variantId: defaultVariant.id,
      });
      onSkuCleared(result.configuration, result.product);
      if (clearedSku) {
        setClearedNotice(clearedDefaultSkuNotice(clearedSku));
      }
      focusLater(() =>
        document
          .getElementById(`product-variant-sku-${defaultVariant.id}`)
          ?.focus()
      );
    } catch (error: unknown) {
      setClearError(variantSkuErrorMessage(error));
      // the variants are read again (and this form drawn again, from the kept draft): the warning comes back to try
      if (rpcErrorCode(error) === "CONFLICT") {
        onConflict();
      }
    } finally {
      setIsPending(false);
    }
  }, [
    configuration.productVersion,
    defaultVariant,
    isPending,
    onConflict,
    onSkuCleared,
    organizationId,
    product.id,
  ]);

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
      {defaultVariantHasSku && selectedOptions.length > 0 ? (
        <Alert variant="warning">
          <AlertDescription className="grid justify-items-start gap-2">
            Limpe o SKU da variante padrão antes de configurar opções: a
            configuração a substitui.
            <Button
              className="h-auto min-h-ctl-sm whitespace-normal py-1.5 text-start [overflow-wrap:anywhere]"
              disabled={isPending}
              onClick={handleClearDefaultSku}
              size="sm"
              type="button"
              variant="outline"
            >
              {clearDefaultSkuLabel(defaultSku ?? "")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {clearedNotice ? (
        <Alert>
          <AlertDescription>{clearedNotice}</AlertDescription>
        </Alert>
      ) : null}
      {clearError ? (
        <Alert variant="destructive">
          <AlertDescription>{clearError}</AlertDescription>
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
        <Alert ref={saveErrorRef} tabIndex={-1} variant="destructive">
          <AlertDescription>
            {saveError}
            <LimitHelp
              help={limitHelp.help}
              shown={saveError === VARIANT_LIMIT_REACHED}
            />
          </AlertDescription>
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
          aria-describedby={tooLongReason}
          aria-disabled={tooLongReason ? true : undefined}
          disabled={
            !tooLongReason &&
            (!validation.canSubmit || defaultVariantHasSku || isPending)
          }
          type="submit"
        >
          {isPending ? "Salvando…" : "Salvar variantes"}
        </Button>
      </div>
    </form>
  );
}
