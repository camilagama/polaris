import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { focusLater } from "../lib/focus";
import { useSettledText } from "./sale-summary-panel";
import { useStoreToday } from "../lib/use-store-today";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
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
import { HelpTip } from "@/ui/help-tip";
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
  MAX_KEYED_METHODS,
  methodForKey,
  useMethodKeysEnabled,
} from "./payment-method-keys";
import {
  ADJUSTMENT_KINDS,
  type AdjustmentDraft,
  adjustmentFieldKey,
  type CatalogView,
  type ChoiceOption,
  formFieldKeys,
  joinSaleDate,
  MAX_SALE_ADJUSTMENTS,
  NO_PROFILE_CHOICE,
  OFFLINE_SALE_DATE_NOTE,
  SALE_DATE_HINT,
  SALE_METHOD_CARDS,
  type PaymentDraft,
  type ProfileSelectionDraft,
  type SaleFormState,
  type SplitEvaluation,
  saleExtrasSummary,
  saleTimeIsWellFormed,
  sharedProfileReview,
  splitSaleDate,
  timeOfDay,
} from "./sale-form-model";
import {
  type CashAdjust,
  changeText,
  fieldTextOfCents,
  SHARED_PROFILE_REVIEW_MESSAGE,
  SINGLE_PAYMENT_HELP,
  SPLIT_END_LABEL,
  SPLIT_PAYMENT_HELP,
  SPLIT_START_LABEL,
  type SplitBalance,
  splitBalanceSentence,
} from "./sale-split-model";

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
      <div className="@container">
        <div className="grid @[26.5rem]:grid-cols-3 gap-3">
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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

interface SaleDateProps {
  error: string | undefined;
  /** Without a connection the sale is dated when it is kept: no field, the note in its place. */
  offline: boolean;
  onChange: (value: string) => void;
  /** The store's zone: the last chosen day is the store's today, not the device's. */
  timezone: string | null;
  value: string;
}

/**
 * The optional commercial date and time: the day on the DatePicker of src/ui (never after today) and the time typed
 * beside it; empty means now. Picking a day with no time fills in the time of now, which the person can change.
 */
function SaleDate({
  error,
  offline,
  onChange,
  timezone,
  value,
}: SaleDateProps) {
  const { day, time } = splitSaleDate(value);
  const today = useStoreToday(timezone);
  const handleDay = useCallback(
    (next: string) =>
      onChange(
        joinSaleDate(
          next,
          time === "" && next !== "" ? timeOfDay(new Date()) : time
        )
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
  const timeAtFault =
    error !== undefined && ISO_DAY.test(day) && !saleTimeIsWellFormed(time);
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
          disabledReason="Só até hoje"
          error={timeAtFault ? undefined : error}
          id="sale-occurred-day"
          label="Dia"
          max={today}
          onChange={handleDay}
          today={today}
          value={day}
        />
        <TextField
          className="w-28"
          error={timeAtFault ? error : undefined}
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

interface SplitStartProps {
  /** Why it is off ("Dividir precisa de internet"), or null. */
  blocker: string | null;
  onStart: () => void;
  /** Without a connection the reason stays on the screen; with no item it shows when the person presses the button. */
  reasonVisible: boolean;
}

/**
 * "Dividir pagamento": a text button in the closed line, so a sale paid in one go gains no field. Off, it stays
 * focusable and says why (aria-disabled with the reason as its description).
 */
function SplitStart({
  blocker,
  children,
  onStart,
  reasonVisible,
}: SplitStartProps & { children: ReactNode }) {
  const reasonId = useId();
  const [reasonShown, setReasonShown] = useState(false);
  useEffect(() => {
    if (blocker === null) {
      setReasonShown(false);
    }
  }, [blocker]);
  const handleClick = useCallback(() => {
    if (blocker === null) {
      onStart();
      return;
    }
    setReasonShown(true);
  }, [blocker, onStart]);
  const shown = reasonVisible || reasonShown;
  return (
    <>
      <ExtrasActions>
        <Button
          aria-describedby={blocker === null ? undefined : reasonId}
          aria-disabled={blocker === null ? undefined : true}
          className="shrink-0 aria-disabled:opacity-50"
          id="sale-split-start"
          onClick={handleClick}
          size="sm"
          type="button"
          variant="link"
        >
          {SPLIT_START_LABEL}
        </Button>
        {children}
      </ExtrasActions>
      {blocker === null ? null : (
        <span
          className={
            shown ? "basis-full text-muted-foreground text-support" : "sr-only"
          }
          id={reasonId}
          role={shown ? "note" : undefined}
        >
          {blocker}
        </span>
      )}
    </>
  );
}

/**
 * "Dividir pagamento" and "Alterar" wrap together, under the summary, never one per line: their touch areas would
 * overlap. The vertical gap keeps them apart if they ever wrap between themselves.
 */
function ExtrasActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-3">
      {children}
    </div>
  );
}

interface SaleExtrasProps {
  adjustments: AdjustmentsProps;
  date: SaleDateProps;
  /** A date or an adjustment with an error keeps the section open, so the focus can reach it. */
  hasError: boolean;
  /** "Dividir pagamento", beside "Alterar"; null while the sale is already paid in parts. */
  split: SplitStartProps | null;
  summary: string;
}

/** Date and adjustments, closed in one line ("Agora · Sem ajuste · Alterar"): most counter sales use neither. */
function SaleExtras({
  adjustments,
  date,
  hasError,
  split,
  summary,
}: SaleExtrasProps) {
  // a cart restored on a remount (the draft) shows the date or the adjustments it already has
  const [open, setOpen] = useState(
    () => adjustments.adjustments.length > 0 || date.value !== ""
  );
  const handleOpenChange = useCallback((next: boolean) => setOpen(next), []);
  const expanded = open || hasError;
  const trigger = hasError ? null : (
    <CollapsibleTrigger
      aria-describedby="sale-extras-summary"
      render={
        <Button className="shrink-0" size="sm" type="button" variant="link" />
      }
    >
      {expanded ? "Fechar" : "Alterar"}
      <span className="sr-only"> data e ajustes</span>
    </CollapsibleTrigger>
  );
  return (
    <Collapsible onOpenChange={handleOpenChange} open={expanded}>
      <div className="flex flex-wrap items-center justify-end gap-x-3">
        <p
          className="me-auto min-w-0 text-muted-foreground"
          id="sale-extras-summary"
        >
          {summary}
        </p>
        {split === null ? (
          <ExtrasActions>{trigger}</ExtrasActions>
        ) : (
          <SplitStart {...split}>{trigger}</SplitStart>
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

const methodOptions: ChoiceOption[] = SALE_METHOD_CARDS.map(([id, label]) => ({
  id,
  label,
}));

/* -------------------------------------------------------------------------- */
/* Split payment: the parts                                                   */
/* -------------------------------------------------------------------------- */

export interface SplitHandlers {
  onAcknowledgeSecondReview: () => void;
  onAction: (cents: bigint) => void;
  onEnd: () => void;
  onFirstAmountChange: (value: string) => void;
  onSecondAmountChange: (value: string) => void;
  onSecondAnticipationChange: (checked: boolean) => void;
  onSecondInstallmentPlanChange: (value: string) => void;
  onSecondInstallmentsChange: (value: string) => void;
  onSecondMethodChange: (value: string) => void;
  onSecondProfileChange: (value: string) => void;
  onStart: () => void;
}

interface PartFieldsProps {
  /** The text of the amount field; for the rest, what the rest is now. */
  amount: string;
  /** Under the amount: "O restante" while part 2 follows the total, "Troco: R$ X" after "Ajustar para". */
  amountHint: string | undefined;
  disabled: boolean;
  errors: Record<string, string>;
  keys: {
    amount: string;
    installmentPlan: string;
    installments: string;
    method: string;
    profile: string;
  };
  onAcknowledgeReview: () => void;
  onAmountChange: (value: string) => void;
  onAnticipationChange: (checked: boolean) => void;
  onInstallmentPlanChange: (value: string) => void;
  onInstallmentsChange: (value: string) => void;
  onMethodChange: (value: string) => void;
  onProfileChange: (value: string) => void;
  ordinal: 1 | 2;
  payment: PaymentDraft;
  profile: ProfileSelectionDraft;
  profileOptions: readonly ChoiceOption[];
  /** Off when both parts wait on the same profile: one warning for the two comes after the parts. */
  showReview: boolean;
}

/** One part: method in a list, amount, the credit fields only for credit, and the profile last. */
function PartFields({
  amount,
  amountHint,
  disabled,
  errors,
  keys,
  onAcknowledgeReview,
  onAmountChange,
  onAnticipationChange,
  onInstallmentPlanChange,
  onInstallmentsChange,
  onMethodChange,
  onProfileChange,
  ordinal,
  payment,
  profile,
  profileOptions,
  showReview,
}: PartFieldsProps) {
  const prefix = `sale-part-${ordinal}`;
  const card = payment.method === "credit_card";
  return (
    <fieldset className="grid min-w-0 gap-4 rounded-lg border border-border p-3">
      <legend className="px-1 font-medium text-sm">Parte {ordinal}</legend>
      <div className="@container">
        <div className="grid @[24.5rem]:grid-cols-2 gap-4">
          <SelectField
            disabled={disabled}
            error={errors[keys.method]}
            id={`${prefix}-method`}
            label="Método"
            onChange={onMethodChange}
            options={methodOptions}
            placeholder="Escolha o método"
            value={payment.method}
          />
          <TextField
            addon="R$"
            error={errors[keys.amount]}
            hint={amountHint}
            id={`${prefix}-amount`}
            inputMode="decimal"
            label="Valor"
            maxLength={22}
            onChange={onAmountChange}
            placeholder="0,00"
            value={amount}
          />
        </div>
      </div>
      {card ? (
        <>
          <div className="@container">
            <div className="grid @[24.5rem]:grid-cols-2 gap-4">
              <TextField
                error={errors[keys.installments]}
                id={`${prefix}-installments`}
                inputMode="numeric"
                label="Número de parcelas"
                maxLength={10}
                onChange={onInstallmentsChange}
                value={payment.installments}
              />
              <SelectField
                disabled={disabled}
                error={errors[keys.installmentPlan]}
                id={`${prefix}-plan`}
                label={INSTALLMENT_PLAN_LABEL}
                onChange={onInstallmentPlanChange}
                options={INSTALLMENT_PLAN_OPTIONS}
                placeholder={INSTALLMENT_PLAN_PLACEHOLDER}
                value={payment.installmentPlan}
              />
            </div>
          </div>
          <Field orientation="horizontal">
            <Checkbox
              aria-describedby={`${prefix}-anticipation-hint`}
              checked={payment.anticipationRequested}
              id={`${prefix}-anticipation`}
              onCheckedChange={onAnticipationChange}
            />
            <FieldContent>
              <FieldLabel htmlFor={`${prefix}-anticipation`}>
                Pretendo antecipar este recebimento
              </FieldLabel>
              <p
                className="text-muted-foreground text-support"
                id={`${prefix}-anticipation-hint`}
              >
                Só registra a intenção. Não confirma a antecipação.
              </p>
            </FieldContent>
          </Field>
        </>
      ) : null}
      <SelectField
        disabled={disabled}
        error={errors[keys.profile]}
        id={`${prefix}-profile`}
        label="Perfil de pagamento"
        onChange={onProfileChange}
        options={[noProfileOption, ...profileOptions]}
        placeholder="Escolha uma opção"
        value={profile.choice}
      />
      {showReview && profile.reviewNotice ? (
        <ReviewNotice
          buttonLabel={`Revisei a prévia da parte ${ordinal}`}
          notice={profile.reviewNotice}
          onAcknowledge={profile.choice === "" ? null : onAcknowledgeReview}
        />
      ) : null}
    </fieldset>
  );
}

function ReviewNotice({
  buttonLabel,
  notice,
  onAcknowledge,
}: {
  buttonLabel: string;
  notice: string;
  onAcknowledge: (() => void) | null;
}) {
  return (
    <Alert role="alert" variant="warning">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="grid justify-items-start gap-2">
        <p className="mb-0!">{notice}</p>
        {onAcknowledge === null ? null : (
          <Button
            className="h-auto min-h-ctl-sm max-w-full whitespace-normal py-1.5 text-left"
            onClick={onAcknowledge}
            size="sm"
            type="button"
            variant="outline"
          >
            {buttonLabel}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

const balanceIcons = {
  closed: CircleCheckIcon,
  over: TriangleAlertIcon,
  short: CircleAlertIcon,
} as const;

interface SplitStatusProps {
  balance: SplitBalance | null;
  onAction: (cents: bigint) => void;
  onCashAdjust: (adjust: CashAdjust) => void;
  totalChangedNotice: string | null;
}

/**
 * "Falta R$ X", "Passou R$ X" or "Fechou: R$ X", with an icon (never color alone) and the button that closes the
 * difference: "Ajustar para R$ X" on the cash part when the extra is change, "Pôr/Tirar da parte 2" otherwise. It
 * takes the focus when a confirmation meets parts that do not close the total. The text wraps, never cut.
 */
function SplitStatus({
  balance,
  onAction,
  onCashAdjust,
  totalChangedNotice,
}: SplitStatusProps) {
  const sentence =
    balance === null
      ? ""
      : [splitBalanceSentence(balance), totalChangedNotice]
          .filter(Boolean)
          .join(". ");
  const announced = useSettledText(sentence);
  const Icon = balance === null ? null : balanceIcons[balance.kind];
  const action = balance?.cashAdjust ?? balance?.action ?? null;
  const handleAction = useCallback(() => {
    if (balance?.cashAdjust) {
      onCashAdjust(balance.cashAdjust);
    } else if (balance?.action) {
      onAction(balance.action.amount);
    }
  }, [balance, onAction, onCashAdjust]);
  return (
    <div
      className="focus-ring grid min-w-0 gap-2 rounded-lg empty:hidden"
      data-split-balance={balance?.kind}
      id="sale-split-balance"
      tabIndex={-1}
    >
      <p aria-atomic="true" aria-live="polite" className="sr-only">
        {announced}
      </p>
      {balance === null || Icon === null ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <p
            className={
              balance.kind === "closed"
                ? "flex min-w-0 items-start gap-2 text-muted-foreground"
                : "flex min-w-0 items-start gap-2 font-medium text-warning"
            }
          >
            <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="[overflow-wrap:anywhere]">{balance.text}</span>
          </p>
          {action === null ? null : (
            <Button
              className="h-auto min-h-ctl-sm max-w-full whitespace-normal py-1.5 text-left"
              onClick={handleAction}
              size="sm"
              type="button"
              variant="outline"
            >
              {action.label}
            </Button>
          )}
        </div>
      )}
      {balance?.hint ? (
        <p className="text-muted-foreground text-support">{balance.hint}</p>
      ) : null}
      {balance !== null &&
      balance.kind !== "closed" &&
      totalChangedNotice !== null ? (
        <p className="text-muted-foreground text-support">
          {totalChangedNotice}
        </p>
      ) : null}
    </div>
  );
}

interface SplitEndProps {
  onEnd: () => void;
}

/** "Voltar a um pagamento só", with a short confirmation: part 2 leaves the sale. */
function SplitEnd({ onEnd }: SplitEndProps) {
  const [confirming, setConfirming] = useState(false);
  const handleAsk = useCallback(() => {
    setConfirming(true);
    focusLater(() => document.getElementById("sale-split-end-keep")?.focus());
  }, []);
  const handleKeep = useCallback(() => {
    setConfirming(false);
    focusLater(() => document.getElementById("sale-split-end")?.focus());
  }, []);
  if (!confirming) {
    return (
      <Button
        className="justify-self-start"
        id="sale-split-end"
        onClick={handleAsk}
        size="sm"
        type="button"
        variant="link"
      >
        {SPLIT_END_LABEL}
      </Button>
    );
  }
  return (
    <div className="grid justify-items-start gap-2 rounded-lg border border-border p-3">
      <p className="mb-0" id="sale-split-end-question">
        Voltar a um pagamento só? A parte 2 sai da venda.
      </p>
      <div className="flex min-w-0 flex-wrap gap-2">
        <Button
          aria-describedby="sale-split-end-question"
          className="h-auto min-h-ctl-sm max-w-full whitespace-normal py-1.5 text-left"
          onClick={onEnd}
          size="sm"
          type="button"
          variant="outline"
        >
          {SPLIT_END_LABEL}
        </Button>
        <Button
          className="h-auto min-h-ctl-sm max-w-full whitespace-normal py-1.5 text-left"
          id="sale-split-end-keep"
          onClick={handleKeep}
          size="sm"
          type="button"
          variant="outline"
        >
          Manter as duas partes
        </Button>
      </div>
    </div>
  );
}

interface SplitPartsProps {
  disabled: boolean;
  errors: Record<string, string>;
  evaluation: SplitEvaluation | null;
  form: SaleFormState;
  handlers: SplitHandlers;
  onAcknowledgeReview: () => void;
  onAnticipationChange: (checked: boolean) => void;
  onInstallmentPlanChange: (value: string) => void;
  onInstallmentsChange: (value: string) => void;
  onMethodChange: (value: string) => void;
  onProfileChange: (value: string) => void;
  profileOptions: readonly ChoiceOption[];
}

/** The two parts, the state line and the way back to one payment. */
function SplitParts({
  disabled,
  errors,
  evaluation,
  form,
  handlers,
  onAcknowledgeReview,
  onAnticipationChange,
  onInstallmentPlanChange,
  onInstallmentsChange,
  onMethodChange,
  onProfileChange,
  profileOptions,
}: SplitPartsProps) {
  const { split } = form;
  // "Troco: R$ X" lives on the screen only, and is said only while the cash part still holds the amount it was set to
  // and the parts still close the total
  const [change, setChange] = useState<{
    cents: bigint;
    part: 1 | 2;
    text: string;
  } | null>(null);
  const {
    onAction,
    onFirstAmountChange,
    onSecondAmountChange,
    onAcknowledgeSecondReview,
  } = handlers;
  const handleFirstAmount = useCallback(
    (value: string) => {
      setChange((current) => (current?.part === 1 ? null : current));
      onFirstAmountChange(value);
    },
    [onFirstAmountChange]
  );
  const handleSecondAmount = useCallback(
    (value: string) => {
      setChange((current) => (current?.part === 2 ? null : current));
      onSecondAmountChange(value);
    },
    [onSecondAmountChange]
  );
  const handleCashAdjust = useCallback(
    (adjust: CashAdjust) => {
      const text = fieldTextOfCents(adjust.amount);
      if (adjust.part === 1) {
        onFirstAmountChange(text);
      } else {
        onSecondAmountChange(text);
      }
      setChange({ cents: adjust.change, part: adjust.part, text });
    },
    [onFirstAmountChange, onSecondAmountChange]
  );
  const handleAction = useCallback(
    (cents: bigint) => {
      setChange((current) => (current?.part === 2 ? null : current));
      onAction(cents);
    },
    [onAction]
  );
  const handleAcknowledgeBoth = useCallback(
    () => onAcknowledgeReview(),
    [onAcknowledgeReview]
  );
  if (split === null) {
    return null;
  }
  const shared = sharedProfileReview(form);
  const restCents = evaluation?.balance?.second ?? null;
  const secondAmount =
    split.second.amount ??
    (restCents === null ? "" : fieldTextOfCents(restCents));
  const parts = {
    1: { amount: split.firstAmount, method: form.payment.method },
    2: { amount: split.second.amount, method: split.second.payment.method },
  } as const;
  const hintOf = (part: 1 | 2): string | undefined =>
    change?.part === part &&
    parts[part].amount === change.text &&
    parts[part].method === "cash" &&
    evaluation?.balance?.kind === "closed"
      ? changeText(change.cents)
      : undefined;
  return (
    <div className="grid gap-4">
      <PartFields
        amount={split.firstAmount}
        amountHint={hintOf(1)}
        disabled={disabled}
        errors={errors}
        keys={{
          amount: formFieldKeys.firstAmount,
          installmentPlan: formFieldKeys.installmentPlan,
          installments: formFieldKeys.installments,
          method: formFieldKeys.method,
          profile: formFieldKeys.profile,
        }}
        onAcknowledgeReview={onAcknowledgeReview}
        onAmountChange={handleFirstAmount}
        onAnticipationChange={onAnticipationChange}
        onInstallmentPlanChange={onInstallmentPlanChange}
        onInstallmentsChange={onInstallmentsChange}
        onMethodChange={onMethodChange}
        onProfileChange={onProfileChange}
        ordinal={1}
        payment={form.payment}
        profile={form.profile}
        profileOptions={profileOptions}
        showReview={!shared}
      />
      <PartFields
        amount={secondAmount}
        amountHint={
          hintOf(2) ?? (split.second.amount === null ? "O restante" : undefined)
        }
        disabled={disabled}
        errors={errors}
        keys={{
          amount: formFieldKeys.secondAmount,
          installmentPlan: formFieldKeys.secondInstallmentPlan,
          installments: formFieldKeys.secondInstallments,
          method: formFieldKeys.secondMethod,
          profile: formFieldKeys.secondProfile,
        }}
        onAcknowledgeReview={onAcknowledgeSecondReview}
        onAmountChange={handleSecondAmount}
        onAnticipationChange={handlers.onSecondAnticipationChange}
        onInstallmentPlanChange={handlers.onSecondInstallmentPlanChange}
        onInstallmentsChange={handlers.onSecondInstallmentsChange}
        onMethodChange={handlers.onSecondMethodChange}
        onProfileChange={handlers.onSecondProfileChange}
        ordinal={2}
        payment={split.second.payment}
        profile={split.second.profile}
        profileOptions={profileOptions}
        showReview={!shared}
      />
      {shared ? (
        <ReviewNotice
          buttonLabel="Revisei a prévia das duas partes"
          notice={SHARED_PROFILE_REVIEW_MESSAGE}
          onAcknowledge={handleAcknowledgeBoth}
        />
      ) : null}
      <SplitStatus
        balance={evaluation?.balance ?? null}
        onAction={handleAction}
        onCashAdjust={handleCashAdjust}
        totalChangedNotice={evaluation?.totalChangedNotice ?? null}
      />
      <SplitEnd onEnd={handlers.onEnd} />
    </div>
  );
}

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
  /** The state line under the methods ("Igual à última venda neste aparelho."); empty when there is none. */
  singlePaymentText: string;
  split: {
    /** Why "Dividir pagamento" is off, or null. */
    blocker: string | null;
    evaluation: SplitEvaluation | null;
    handlers: SplitHandlers;
  };
  /** The store's zone (null when the store has none), for the day the date field stops at. */
  timezone: string | null;
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
  split,
  timezone,
}: PaymentSectionProps) {
  const splitOn = form.split !== null;
  const card = form.payment.method === "credit_card";
  const options = [noProfileOption, ...profileOptions];
  const handleMethod = useCallback(
    (value: unknown) => onMethodChange(typeof value === "string" ? value : ""),
    [onMethodChange]
  );
  const keysEnabled = useMethodKeysEnabled();
  const handleMethodKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!keysEnabled || disabled || splitOn) {
        return;
      }
      const picked = methodForKey(event, SALE_METHOD_CARDS);
      if (picked === null) {
        return;
      }
      event.preventDefault();
      onMethodChange(picked[0]);
      const radios =
        event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
      radios[SALE_METHOD_CARDS.indexOf(picked)]?.focus();
    },
    [disabled, keysEnabled, onMethodChange, splitOn]
  );
  const handleAnticipation = useCallback(
    (checked: boolean) => onAnticipationChange(checked),
    [onAnticipationChange]
  );
  return (
    <Card className="gap-4">
      {/* outside the fieldset: a locked sale disables its controls, not the (i) that explains them */}
      <CardHeader>
        <div className="flex items-center gap-1">
          <CardTitle aria-level={2} id="sale-payment-title" role="heading">
            Pagamento
          </CardTitle>
          <HelpTip about="Pagamento" className="-my-1">
            {splitOn ? SPLIT_PAYMENT_HELP : SINGLE_PAYMENT_HELP}
          </HelpTip>
        </div>
      </CardHeader>
      <fieldset
        aria-labelledby="sale-payment-title"
        className="grid min-w-0 gap-4"
        disabled={disabled}
      >
        <CardContent className="grid gap-5">
          {splitOn ? (
            <SplitParts
              disabled={disabled}
              errors={errors}
              evaluation={split.evaluation}
              form={form}
              handlers={split.handlers}
              onAcknowledgeReview={onAcknowledgeReview}
              onAnticipationChange={handleAnticipation}
              onInstallmentPlanChange={onInstallmentPlanChange}
              onInstallmentsChange={onInstallmentsChange}
              onMethodChange={onMethodChange}
              onProfileChange={onProfileChange}
              profileOptions={profileOptions}
            />
          ) : (
            <SinglePayment
              card={card}
              disabled={disabled}
              errors={errors}
              form={form}
              keysEnabled={keysEnabled}
              onAnticipationChange={handleAnticipation}
              onInstallmentPlanChange={onInstallmentPlanChange}
              onInstallmentsChange={onInstallmentsChange}
              onMethod={handleMethod}
              onMethodKey={handleMethodKey}
              onProfileChange={onProfileChange}
              options={options}
              singlePaymentText={singlePaymentText}
            />
          )}
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
          {!splitOn && form.profile.reviewNotice ? (
            <ReviewNotice
              buttonLabel="Revisei a prévia atualizada"
              notice={form.profile.reviewNotice}
              onAcknowledge={
                form.profile.choice === "" ? null : onAcknowledgeReview
              }
            />
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
              timezone,
              value: form.occurredAtLocal,
            }}
            hasError={Object.keys(errors).some(isExtrasErrorKey)}
            split={
              splitOn
                ? null
                : {
                    blocker: split.blocker,
                    onStart: split.handlers.onStart,
                    reasonVisible: offline,
                  }
            }
            summary={saleExtrasSummary(form, offline)}
          />
        </CardContent>
      </fieldset>
    </Card>
  );
}

interface SinglePaymentProps {
  card: boolean;
  disabled: boolean;
  errors: Record<string, string>;
  form: SaleFormState;
  keysEnabled: boolean;
  onAnticipationChange: (checked: boolean) => void;
  onInstallmentPlanChange: (value: string) => void;
  onInstallmentsChange: (value: string) => void;
  onMethod: (value: unknown) => void;
  onMethodKey: (event: KeyboardEvent<HTMLDivElement>) => void;
  onProfileChange: (value: string) => void;
  options: readonly ChoiceOption[];
  singlePaymentText: string;
}

/** The sale paid in one go: the six method cards (keys 1 to 6), credit, anticipation and the profile. */
function SinglePayment({
  card,
  disabled,
  errors,
  form,
  keysEnabled,
  onAnticipationChange,
  onInstallmentPlanChange,
  onInstallmentsChange,
  onMethod,
  onMethodKey,
  onProfileChange,
  options,
  singlePaymentText,
}: SinglePaymentProps) {
  const methodError = errors[formFieldKeys.method];
  return (
    <>
      <Field className="@container">
        <RadioGroup
          aria-describedby={describedBy(
            "sale-method",
            methodError,
            singlePaymentText
          )}
          aria-invalid={methodError ? true : undefined}
          aria-label="Método de pagamento"
          className="@[18.5rem]:grid-cols-2 @[26.5rem]:grid-cols-3 grid-cols-1"
          disabled={disabled}
          id="sale-method"
          onKeyDown={onMethodKey}
          onValueChange={onMethod}
          value={form.payment.method === "" ? null : form.payment.method}
        >
          {SALE_METHOD_CARDS.map(([method, label], index) => (
            <FieldLabel
              className="has-data-disabled:opacity-50"
              htmlFor={`sale-method-${method}`}
              key={method}
            >
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>
                    {keysEnabled && index < MAX_KEYED_METHODS ? (
                      <span
                        aria-hidden="true"
                        className="@min-[21rem]:@max-[26.5rem]:inline-flex @min-[32rem]:inline-flex hidden h-4 min-w-4 items-center justify-center rounded-sm border px-1 font-sans text-muted-foreground text-xs leading-none"
                        data-method-key={index + 1}
                      >
                        {index + 1}
                      </span>
                    ) : null}
                    <span>{label}</span>
                  </FieldTitle>
                </FieldContent>
                <RadioGroupItem
                  aria-keyshortcuts={
                    keysEnabled && index < MAX_KEYED_METHODS
                      ? String(index + 1)
                      : undefined
                  }
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
        <div className="@container">
          <div className="grid @[24.5rem]:grid-cols-2 gap-4">
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
        </div>
      ) : null}
      <Field orientation="horizontal">
        <Checkbox
          aria-describedby="sale-anticipation-hint"
          checked={form.payment.anticipationRequested}
          className="data-disabled:opacity-50"
          disabled={disabled || !card}
          id="sale-anticipation"
          onCheckedChange={onAnticipationChange}
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
    </>
  );
}
