import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { type ChangeEvent, useCallback } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Field, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupTextarea } from "@/ui/input-group";
import {
  describedBy,
  FieldTexts,
  QuantityStepper,
  SelectField,
  TextField,
} from "../sales/sale-fields";
import {
  type StockCommandState,
  type StockFailure,
  type StockFieldName,
  stepStockQuantity,
  stockConsequence,
  stockSummary,
  validateStockDraft,
  valuationApplies,
  WRITE_OFF_REASONS,
} from "./stock-command-model";
import { unitsText } from "./stock-target";

/** The fields of a stock command on the components of src/ui (ADR 0103), the sale screen's fields included. */

const FIELD_SUFFIX: Readonly<Record<StockFieldName, string>> = {
  occurredOn: "date",
  physicalQuantity: "physical",
  quantity: "quantity",
  reasonCode: "reason",
  reasonNote: "note",
  unitCost: "unit-cost",
  valuationUnitCost: "valuation",
};

/** The id of a field's control: the page focuses the first invalid one by it. */
export const stockFieldId = (prefix: string, field: StockFieldName) =>
  `${prefix}-${FIELD_SUFFIX[field]}`;

const REASON_OPTIONS = WRITE_OFF_REASONS.map(([code, label]) => ({
  id: code,
  label,
}));

interface NoteFieldProps {
  disabled: boolean;
  error: string | undefined;
  id: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}

function NoteField({
  disabled,
  error,
  id,
  label,
  onChange,
  value,
}: NoteFieldProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <Field className="min-w-0 md:col-span-2" data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup className="h-auto items-stretch">
        <InputGroupTextarea
          aria-describedby={describedBy(id, error, undefined)}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          id={id}
          onChange={handleChange}
          rows={3}
          value={value}
        />
      </InputGroup>
      <FieldTexts error={error} hint={undefined} id={id} />
    </Field>
  );
}

interface EditFieldsProps {
  /** The form is off: reviewing, sending or locked. The choice list is not a native control, so it is told. */
  disabled: boolean;
  errors: Partial<Record<StockFieldName, string>>;
  onChange: (field: StockFieldName, value: string) => void;
  prefix: string;
  state: StockCommandState;
}

export function EditFields({
  disabled,
  errors,
  onChange,
  prefix,
  state,
}: EditFieldsProps) {
  const { draft, target } = state;
  const handleQuantity = useCallback(
    (value: string) => onChange("quantity", value),
    [onChange]
  );
  const handleUnitCost = useCallback(
    (value: string) => onChange("unitCost", value),
    [onChange]
  );
  const handlePhysical = useCallback(
    (value: string) => onChange("physicalQuantity", value),
    [onChange]
  );
  const handleValuation = useCallback(
    (value: string) => onChange("valuationUnitCost", value),
    [onChange]
  );
  const handleDate = useCallback(
    (value: string) => onChange("occurredOn", value),
    [onChange]
  );
  const handleReasonCode = useCallback(
    (value: string) => onChange("reasonCode", value),
    [onChange]
  );
  const handleReasonNote = useCallback(
    (value: string) => onChange("reasonNote", value),
    [onChange]
  );
  const id = (field: StockFieldName) => stockFieldId(prefix, field);

  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      {draft.action === "receive" ? (
        <>
          <QuantityStepper
            error={errors.quantity}
            id={id("quantity")}
            label="Quantidade recebida"
            less={stepStockQuantity(draft.quantity, -1, 1)}
            more={stepStockQuantity(draft.quantity, 1, 1)}
            onChange={handleQuantity}
            value={draft.quantity}
          />
          <TextField
            error={errors.unitCost}
            hint="Em reais, por unidade. Obrigatório: alimenta o custo médio."
            id={id("unitCost")}
            inputMode="decimal"
            label="Custo unitário (R$)"
            maxLength={26}
            onChange={handleUnitCost}
            placeholder="Ex.: 12,50"
            value={draft.unitCost}
          />
        </>
      ) : null}
      {draft.action === "count" ? (
        <>
          <QuantityStepper
            error={errors.physicalQuantity}
            hint={`Saldo no sistema: ${unitsText(target.quantity)}. Informe o que você contou.`}
            id={id("physicalQuantity")}
            label="Quantidade contada"
            less={stepStockQuantity(draft.physicalQuantity, -1, 0)}
            more={stepStockQuantity(draft.physicalQuantity, 1, 0)}
            onChange={handlePhysical}
            value={draft.physicalQuantity}
          />
          {valuationApplies(target) ? (
            <TextField
              error={errors.valuationUnitCost}
              hint="Opcional. Estabelece o custo desta variante, hoje desconhecido; só vale com quantidade contada maior que zero."
              id={id("valuationUnitCost")}
              inputMode="decimal"
              label="Custo unitário para valoração (R$)"
              maxLength={26}
              onChange={handleValuation}
              placeholder="Ex.: 12,50"
              value={draft.valuationUnitCost}
            />
          ) : null}
        </>
      ) : null}
      {draft.action === "write_off" ? (
        <>
          <QuantityStepper
            error={errors.quantity}
            hint={`Saldo atual: ${unitsText(target.quantity)}.`}
            id={id("quantity")}
            label="Quantidade a baixar"
            less={stepStockQuantity(draft.quantity, -1, 1)}
            more={stepStockQuantity(draft.quantity, 1, 1)}
            onChange={handleQuantity}
            value={draft.quantity}
          />
          <SelectField
            disabled={disabled}
            error={errors.reasonCode}
            id={id("reasonCode")}
            label="Motivo da baixa"
            onChange={handleReasonCode}
            options={REASON_OPTIONS}
            placeholder="Escolha o motivo"
            value={draft.reasonCode}
          />
          <NoteField
            disabled={disabled}
            error={errors.reasonNote}
            id={id("reasonNote")}
            label={
              draft.reasonCode === "other"
                ? "Observação (obrigatória para “Outro”)"
                : "Observação (opcional)"
            }
            onChange={handleReasonNote}
            value={draft.reasonNote}
          />
        </>
      ) : null}
      <TextField
        error={errors.occurredOn}
        hint="Dia do movimento, no horário da loja."
        id={id("occurredOn")}
        label="Data"
        onChange={handleDate}
        type="date"
        value={draft.occurredOn}
      />
    </div>
  );
}

export function FailureNotice({ failure }: { failure: StockFailure }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{failure.message}</AlertDescription>
    </Alert>
  );
}

interface LockedNoticeProps {
  confirmingDiscard: boolean;
  failure: StockFailure;
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
}

/**
 * The outcome is unknown: the attempt is locked and only a retry (same command ID) or a discard goes on. The notice
 * says what happened; the safe retry and, last, the discard are buttons of the panel's row of actions, so the safe
 * one is read and reached first. The second step of the discard (the question) is the notice's own.
 */
export function LockedNotice({
  confirmingDiscard,
  failure,
  onDiscardCancel,
  onDiscardConfirm,
}: LockedNoticeProps) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="grid justify-items-start gap-3">
        <p>{failure.message}</p>
        {confirmingDiscard ? (
          <>
            <p>
              <strong>Este movimento pode já ter sido registrado.</strong> Se
              você descartar e refizer, ele pode ficar duplicado. Descarte só
              depois de conferir o saldo e o histórico.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={onDiscardConfirm}
                type="button"
                variant="destructive"
              >
                Sim, descartar e recomeçar
              </Button>
              <Button onClick={onDiscardCancel} type="button" variant="outline">
                Voltar
              </Button>
            </div>
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** What is about to be recorded, and what recording it means. */
export function Confirmation({ state }: { state: StockCommandState }) {
  const { body } = validateStockDraft(state.draft, state.target, state.today);
  if (body === null) {
    return null;
  }
  return (
    <>
      <dl className="grid gap-2 rounded-md border bg-card p-3 text-support sm:grid-cols-2">
        {stockSummary(body, state.target).map((line) => (
          <div className="grid gap-0.5" key={line.label}>
            <dt className="text-muted-foreground">{line.label}</dt>
            <dd className="font-medium [overflow-wrap:anywhere]">
              {line.value}
            </dd>
          </div>
        ))}
      </dl>
      <Alert variant="warning">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertDescription>{stockConsequence(state.action)}</AlertDescription>
      </Alert>
    </>
  );
}
