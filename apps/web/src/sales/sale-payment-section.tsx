import PlusIcon from "lucide-react/dist/esm/icons/plus";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { useCallback, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { todayOr } from "@/ui/date-values";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@/ui/field";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { Separator } from "@/ui/separator";
import {
  CatalogNotice,
  DateField,
  describedBy,
  FieldTexts,
  INSTALLMENT_PLAN_LABEL,
  INSTALLMENT_PLAN_OPTIONS,
  INSTALLMENT_PLAN_PLACEHOLDER,
  SelectField,
  TextField,
} from "./sale-fields";
import {
  ADJUSTMENT_KINDS,
  type AdjustmentDraft,
  adjustmentFieldKey,
  type CatalogView,
  type ChoiceOption,
  formFieldKeys,
  MAX_SALE_ADJUSTMENTS,
  joinSaleDate,
  NO_PROFILE_CHOICE,
  OFFLINE_SALE_DATE_NOTE,
  SALE_DATE_HINT,
  SALE_METHOD_CARDS,
  type SaleFormState,
  saleExtrasSummary,
  splitSaleDate,
  timeOfDay,
} from "./sale-form-model";

/** The errors that live inside the closed line of date and adjustments. */
function isExtrasErrorKey(key: string): boolean {
  return (
    key === formFieldKeys.occurredAt ||
    key === formFieldKeys.adjustments ||
    key.startsWith("adjustment:")
  );
}

const adjustmentKindOptions: ChoiceOption[] = ADJUSTMENT_KINDS.map(
  ([id, label]) => ({ id, label })
);
const adjustmentTypeOptions: ChoiceOption[] = [
  { id: "fixed", label: "Valor fixo (R$)" },
  { id: "percentage", label: "Percentual (%)" },
];
const noProfileOption: ChoiceOption = {
  id: NO_PROFILE_CHOICE,
  label: "Sem perfil de pagamento",
};

/* -------------------------------------------------------------------------- */
/* Adjustments                                                                */
/* -------------------------------------------------------------------------- */

interface AdjustmentEditorProps {
  adjustment: AdjustmentDraft;
  /** Off while the sale is locked: the <fieldset disabled> turns off the trigger, this tells the Select. */
  disabled: boolean;
  error: string | undefined;
  index: number;
  onChange: (
    draftId: string,
    changes: Partial<Omit<AdjustmentDraft, "draftId">>
  ) => void;
  onRemove: (draftId: string) => void;
}

function AdjustmentEditor({
  adjustment,
  disabled,
  error,
  index,
  onChange,
  onRemove,
}: AdjustmentEditorProps) {
  const prefix = `sale-adjustment-${adjustment.draftId}`;
  const percentageAllowed =
    adjustment.kind === "discount" || adjustment.kind === "surcharge";
  const percentage = adjustment.valueType === "percentage";
  const handleKind = useCallback(
    (value: string) =>
      onChange(adjustment.draftId, {
        kind: value as AdjustmentDraft["kind"],
      }),
    [adjustment.draftId, onChange]
  );
  const handleType = useCallback(
    (value: string) =>
      onChange(adjustment.draftId, {
        valueType: value as AdjustmentDraft["valueType"],
      }),
    [adjustment.draftId, onChange]
  );
  const handleValue = useCallback(
    (value: string) => onChange(adjustment.draftId, { value }),
    [adjustment.draftId, onChange]
  );
  const handleRemove = useCallback(
    () => onRemove(adjustment.draftId),
    [adjustment.draftId, onRemove]
  );
  return (
    <fieldset className="grid min-w-0 gap-3 rounded-lg border border-border p-3">
      <legend className="sr-only">Ajuste {index + 1}</legend>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-muted-foreground text-support">
          Ajuste {index + 1}
        </span>
        <Button
          aria-label={`Remover ajuste ${index + 1}`}
          className="text-muted-foreground hover:text-destructive"
          onClick={handleRemove}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          disabled={disabled}
          id={`${prefix}-kind`}
          label="Tipo de ajuste"
          onChange={handleKind}
          options={adjustmentKindOptions}
          placeholder="Escolha o tipo"
          value={adjustment.kind}
        />
        {percentageAllowed ? (
          <SelectField
            disabled={disabled}
            id={`${prefix}-type`}
            label="Como informar"
            onChange={handleType}
            options={adjustmentTypeOptions}
            placeholder="Escolha"
            value={adjustment.valueType}
          />
        ) : null}
        <TextField
          addon={percentage ? "%" : "R$"}
          error={error}
          hint={
            percentage
              ? "Em pontos percentuais: 2,5 = 2,5%. Incide sobre o subtotal e não compõe com outros ajustes."
              : undefined
          }
          id={`${prefix}-value`}
          inputMode="decimal"
          label={percentage ? "Percentual (%)" : "Valor (R$)"}
          maxLength={22}
          onChange={handleValue}
          placeholder={percentage ? "2,5" : "15,00"}
          value={adjustment.value}
        />
      </div>
    </fieldset>
  );
}

interface AdjustmentsProps {
  adjustments: readonly AdjustmentDraft[];
  disabled: boolean;
  errors: Record<string, string>;
  onAdd: () => void;
  onChange: AdjustmentEditorProps["onChange"];
  onRemove: (draftId: string) => void;
}

function Adjustments({
  adjustments,
  disabled,
  errors,
  onAdd,
  onChange,
  onRemove,
}: AdjustmentsProps) {
  return (
    <FieldSet className="gap-3">
      <legend className="font-medium text-sm">
        Desconto, acréscimo ou frete
      </legend>
      {adjustments.length === 0 ? (
        <p className="text-muted-foreground text-support">
          Nenhum ajuste nesta venda.
        </p>
      ) : null}
      {adjustments.map((adjustment, index) => (
        <AdjustmentEditor
          adjustment={adjustment}
          disabled={disabled}
          error={errors[adjustmentFieldKey(adjustment.draftId)]}
          index={index}
          key={adjustment.draftId}
          onChange={onChange}
          onRemove={onRemove}
        />
      ))}
      <FieldError>{errors[formFieldKeys.adjustments]}</FieldError>
      <Button
        className="self-start"
        disabled={adjustments.length >= MAX_SALE_ADJUSTMENTS}
        onClick={onAdd}
        type="button"
        variant="outline"
      >
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        Adicionar ajuste
      </Button>
    </FieldSet>
  );
}

/* -------------------------------------------------------------------------- */
/* Date                                                                       */
/* -------------------------------------------------------------------------- */

interface SaleDateProps {
  error: string | undefined;
  /** Without a connection the sale is dated when it is kept: no field, the note in its place. */
  offline: boolean;
  onChange: (value: string) => void;
  value: string;
}

/**
 * The optional commercial date and time: the day on the DatePicker of src/ui (never after today) and the time typed
 * beside it; empty means now. Picking a day with no time fills in the time of now, which the person can change.
 */
function SaleDate({ error, offline, onChange, value }: SaleDateProps) {
  const { day, time } = splitSaleDate(value);
  const handleDay = useCallback(
    (next: string) =>
      onChange(
        joinSaleDate(next, time === "" && next !== "" ? timeOfDay(new Date()) : time)
      ),
    [onChange, time]
  );
  const handleTime = useCallback(
    (next: string) => onChange(joinSaleDate(day, next)),
    [day, onChange]
  );
  const handleNow = useCallback(() => {
    onChange("");
    document.getElementById("sale-occurred-day")?.focus();
  }, [onChange]);
  if (offline) {
    return (
      <Field>
        <FieldTitle>Data e hora da venda</FieldTitle>
        <p className="text-muted-foreground text-support" role="note">
          {OFFLINE_SALE_DATE_NOTE}
        </p>
      </Field>
    );
  }
  return (
    <FieldSet className="gap-3">
      <legend className="font-medium text-sm">
        Data e hora da venda (opcional)
      </legend>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-4">
        <DateField
          error={error}
          id="sale-occurred-day"
          label="Dia"
          max={todayOr(undefined)}
          onChange={handleDay}
          value={day}
        />
        <TextField
          className="w-28"
          id="sale-occurred-time"
          inputMode="numeric"
          label="Hora"
          maxLength={5}
          onChange={handleTime}
          placeholder="14:30"
          value={time}
        />
        {value === "" ? null : (
          <Button
            className="self-end"
            onClick={handleNow}
            type="button"
            variant="outline"
          >
            Usar agora
          </Button>
        )}
      </div>
      <FieldDescription>{SALE_DATE_HINT}</FieldDescription>
    </FieldSet>
  );
}

interface SaleExtrasProps {
  adjustments: AdjustmentsProps;
  date: SaleDateProps;
  /** A date or an adjustment with an error keeps the section open, so the focus can reach it. */
  hasError: boolean;
  summary: string;
}

/** Date and adjustments, closed in one line ("Agora · Sem ajuste · Alterar"): most counter sales use neither. */
function SaleExtras({ adjustments, date, hasError, summary }: SaleExtrasProps) {
  const [open, setOpen] = useState(false);
  const handleOpenChange = useCallback((next: boolean) => setOpen(next), []);
  const expanded = open || hasError;
  return (
    <Collapsible onOpenChange={handleOpenChange} open={expanded}>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-muted-foreground" id="sale-extras-summary">
          {summary}
        </p>
        {hasError ? null : (
          <CollapsibleTrigger
            aria-describedby="sale-extras-summary"
            render={
              <Button
                className="shrink-0"
                size="sm"
                type="button"
                variant="link"
              />
            }
          >
            {expanded ? "Fechar" : "Alterar"}
            <span className="sr-only"> data e ajustes</span>
          </CollapsibleTrigger>
        )}
      </div>
      <CollapsiblePanel className="grid gap-5 pt-4">
        <SaleDate {...date} />
        <Adjustments {...adjustments} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

/* -------------------------------------------------------------------------- */
/* Payment                                                                    */
/* -------------------------------------------------------------------------- */

interface PaymentSectionProps {
  disabled: boolean;
  errors: Record<string, string>;
  form: SaleFormState;
  /** Without a connection there are no payment profiles to choose from, and no typed date. */
  offline: boolean;
  onAcknowledgeReview: () => void;
  onAddAdjustment: () => void;
  onAdjustmentChange: AdjustmentEditorProps["onChange"];
  onAnticipationChange: (checked: boolean) => void;
  onDateChange: (value: string) => void;
  onInstallmentPlanChange: (value: string) => void;
  onInstallmentsChange: (value: string) => void;
  onMethodChange: (value: string) => void;
  onProfileChange: (value: string) => void;
  onRemoveAdjustment: (draftId: string) => void;
  onRetry: () => void;
  profileOptions: readonly ChoiceOption[];
  profilesView: CatalogView;
  /** "Um pagamento só, no valor total…", said under the methods. */
  singlePaymentText: string;
}

export function PaymentSection({
  disabled,
  errors,
  form,
  offline,
  onAcknowledgeReview,
  onAddAdjustment,
  onAdjustmentChange,
  onAnticipationChange,
  onDateChange,
  onInstallmentPlanChange,
  onInstallmentsChange,
  onMethodChange,
  onProfileChange,
  onRemoveAdjustment,
  onRetry,
  profileOptions,
  profilesView: profilesState,
  singlePaymentText,
}: PaymentSectionProps) {
  const card = form.payment.method === "credit_card";
  const options = [noProfileOption, ...profileOptions];
  const methodError = errors[formFieldKeys.method];
  const handleMethod = useCallback(
    (value: unknown) => onMethodChange(typeof value === "string" ? value : ""),
    [onMethodChange]
  );
  const handleAnticipation = useCallback(
    (checked: boolean) => onAnticipationChange(checked),
    [onAnticipationChange]
  );
  return (
    <Card>
      <fieldset
        aria-labelledby="sale-payment-title"
        className="grid min-w-0 gap-4"
        disabled={disabled}
      >
        <CardHeader>
          <CardTitle aria-level={2} id="sale-payment-title" role="heading">
            Pagamento
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field>
            <RadioGroup
              aria-describedby={describedBy(
                "sale-method",
                methodError,
                singlePaymentText
              )}
              aria-invalid={methodError ? true : undefined}
              aria-label="Método de pagamento"
              className="grid-cols-1 md:grid-cols-3 min-[22rem]:grid-cols-2"
              disabled={disabled}
              id="sale-method"
              onValueChange={handleMethod}
              value={form.payment.method === "" ? null : form.payment.method}
            >
              {SALE_METHOD_CARDS.map(([method, label]) => (
                <FieldLabel
                  className="has-data-disabled:opacity-50"
                  htmlFor={`sale-method-${method}`}
                  key={method}
                >
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>{label}</FieldTitle>
                    </FieldContent>
                    <RadioGroupItem
                      id={`sale-method-${method}`}
                      value={method}
                    />
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
            <FieldTexts
              error={methodError}
              hint={singlePaymentText}
              id="sale-method"
            />
          </Field>
          {card ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                error={errors[formFieldKeys.installments]}
                id="sale-installments"
                inputMode="numeric"
                label="Número de parcelas"
                maxLength={10}
                onChange={onInstallmentsChange}
                value={form.payment.installments}
              />
              <SelectField
                disabled={disabled}
                error={errors[formFieldKeys.installmentPlan]}
                id="sale-plan"
                label={INSTALLMENT_PLAN_LABEL}
                onChange={onInstallmentPlanChange}
                options={INSTALLMENT_PLAN_OPTIONS}
                placeholder={INSTALLMENT_PLAN_PLACEHOLDER}
                value={form.payment.installmentPlan}
              />
            </div>
          ) : null}
          <Field orientation="horizontal">
            <Checkbox
              aria-describedby="sale-anticipation-hint"
              checked={form.payment.anticipationRequested}
              className="data-disabled:opacity-50"
              disabled={disabled || !card}
              id="sale-anticipation"
              onCheckedChange={handleAnticipation}
            />
            <FieldContent>
              <FieldLabel htmlFor="sale-anticipation">
                Pretendo antecipar este recebimento
              </FieldLabel>
              <p
                className="text-muted-foreground text-support"
                id="sale-anticipation-hint"
              >
                {card
                  ? "Só registra a intenção. Não confirma a antecipação."
                  : "Só para cartão de crédito."}
              </p>
            </FieldContent>
          </Field>
          <Separator />
          <SelectField
            disabled={disabled}
            error={errors[formFieldKeys.profile]}
            hint="Define taxas e prazo estimados. Sem perfil, ficam desconhecidos."
            id="sale-profile"
            label="Perfil de pagamento"
            onChange={onProfileChange}
            options={options}
            placeholder="Escolha uma opção"
            value={form.profile.choice}
          />
          {offline ? (
            <p className="-mt-3 text-muted-foreground text-support" role="note">
              Sem conexão: estes são os perfis da última vez com conexão. Se o
              perfil mudar até o servidor confirmar a venda, ela é recusada e
              você pode reenviá-la sem perfil em Pendências.
            </p>
          ) : null}
          <CatalogNotice
            onRetry={onRetry}
            view={
              // "Sem perfil" already chosen in a store without profiles: the field says it, no paragraph
              profilesState.kind === "empty" &&
              form.profile.choice === NO_PROFILE_CHOICE
                ? null
                : profilesState
            }
          />
          {form.profile.reviewNotice ? (
            <Alert role="alert" variant="warning">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription className="grid justify-items-start gap-2">
                <p className="mb-0!">{form.profile.reviewNotice}</p>
                {form.profile.choice === "" ? null : (
                  <Button
                    onClick={onAcknowledgeReview}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Revisei a prévia atualizada
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          <Separator />
          <SaleExtras
            adjustments={{
              adjustments: form.adjustments,
              disabled,
              errors,
              onAdd: onAddAdjustment,
              onChange: onAdjustmentChange,
              onRemove: onRemoveAdjustment,
            }}
            date={{
              error: errors[formFieldKeys.occurredAt],
              offline,
              onChange: onDateChange,
              value: form.occurredAtLocal,
            }}
            hasError={Object.keys(errors).some(isExtrasErrorKey)}
            summary={saleExtrasSummary(form, offline)}
          />
        </CardContent>
      </fieldset>
    </Card>
  );
}
