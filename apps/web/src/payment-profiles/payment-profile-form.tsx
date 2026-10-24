import PlusIcon from "lucide-react/dist/esm/icons/plus";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2";
import { type FormEvent, useCallback, useId } from "react";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { FieldLegend, FieldSet } from "@/ui/field";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import {
  INSTALLMENT_PLAN_LABEL,
  INSTALLMENT_PLAN_OPTIONS,
  INSTALLMENT_PLAN_PLACEHOLDER,
  SelectField,
  TextField,
} from "../sales/sale-fields";
import {
  decimalInputValue,
  type FeeDraft,
  type FeeMode,
  hasFixed,
  hasPercentage,
  type Method,
  NAME_ID,
  type ProfileDraft,
  type RuleDraft,
  ruleFieldId,
} from "./payment-profile-draft";

/* The form of a payment profile on the components of src/ui (ADR 0103): the name, then one block per rule (method,
   installments, settlement) with a bordered block for each fee; the problems are said at the field. */

export const methods: ReadonlyArray<readonly [Method, string]> = [
  ["pix", "Pix"],
  ["cash", "Dinheiro"],
  ["credit_card", "Cartão de crédito"],
  ["debit_card", "Cartão de débito"],
  ["bank_transfer", "Transferência bancária"],
  ["other", "Outro"],
];
const methodOptions = methods.map(([id, label]) => ({ id, label }));
const feeModeOptions: ReadonlyArray<{ id: FeeMode; label: string }> = [
  { id: "unknown", label: "Desconhecida" },
  { id: "none", label: "Nenhuma" },
  { id: "fixed", label: "Valor fixo" },
  { id: "percentage", label: "Percentual" },
  { id: "fixed_and_percentage", label: "Fixo e percentual" },
];

interface FeeFieldsProps {
  /** The problems of the fields of the form, by the id of the field. */
  errors: Readonly<Record<string, string>>;
  id: string;
  label: string;
  onChange: (value: FeeDraft) => void;
  value: FeeDraft;
}

function FeeFields({ errors, id, label, onChange, value }: FeeFieldsProps) {
  const handleMode = useCallback(
    (mode: string) => onChange({ ...value, mode: mode as FeeMode }),
    [onChange, value]
  );
  const handleFixed = useCallback(
    (fixedAmount: string) => onChange({ ...value, fixedAmount }),
    [onChange, value]
  );
  const handlePercentage = useCallback(
    (text: string) =>
      onChange({ ...value, percentage: decimalInputValue(text) }),
    [onChange, value]
  );
  return (
    <FieldSet className="min-w-0 content-start rounded-lg border p-3" gap="3">
      <FieldLegend className="px-1" space="none" variant="label">
        {label}
      </FieldLegend>
      <SelectField
        hint={
          value.mode === "unknown"
            ? "Desconhecida significa que o valor ainda não foi informado; não equivale a zero."
            : undefined
        }
        id={`${id}-mode`}
        label="Como a taxa é informada"
        onChange={handleMode}
        options={feeModeOptions}
        placeholder="Escolha"
        value={value.mode}
      />
      {hasFixed(value) ? (
        <TextField
          addon="R$"
          error={errors[`${id}-fixed`]}
          id={`${id}-fixed`}
          inputMode="decimal"
          label="Valor fixo por pagamento"
          onChange={handleFixed}
          placeholder="Ex.: 0,50"
          value={value.fixedAmount}
        />
      ) : null}
      {hasPercentage(value) ? (
        <TextField
          addon="%"
          error={errors[`${id}-percentage`]}
          id={`${id}-percentage`}
          inputMode="decimal"
          label="Percentual efetivo sobre o total devido"
          onChange={handlePercentage}
          placeholder="Ex.: 2,99"
          value={value.percentage}
        />
      ) : null}
    </FieldSet>
  );
}

interface RuleEditorProps {
  canRemove: boolean;
  errors: Readonly<Record<string, string>>;
  index: number;
  onRemove: (draftId: string) => void;
  onUpdate: (draftId: string, changes: Partial<RuleDraft>) => void;
  rule: RuleDraft;
}

function RuleEditor({
  canRemove,
  errors,
  index,
  onRemove,
  onUpdate,
  rule,
}: RuleEditorProps) {
  const handleMethod = useCallback(
    (method: string) => onUpdate(rule.draftId, { method: method as Method }),
    [onUpdate, rule.draftId]
  );
  const handleInstallments = useCallback(
    (installments: string) => onUpdate(rule.draftId, { installments }),
    [onUpdate, rule.draftId]
  );
  const handlePlan = useCallback(
    (plan: string) =>
      onUpdate(rule.draftId, {
        installmentPlan: plan as RuleDraft["installmentPlan"],
      }),
    [onUpdate, rule.draftId]
  );
  const handleSettlement = useCallback(
    (expectedSettlementDays: string) =>
      onUpdate(rule.draftId, { expectedSettlementDays }),
    [onUpdate, rule.draftId]
  );
  const handleProcessing = useCallback(
    (processingFee: FeeDraft) => onUpdate(rule.draftId, { processingFee }),
    [onUpdate, rule.draftId]
  );
  const handleAnticipation = useCallback(
    (anticipationFee: FeeDraft) => onUpdate(rule.draftId, { anticipationFee }),
    [onUpdate, rule.draftId]
  );
  const handleRemove = useCallback(
    () => onRemove(rule.draftId),
    [onRemove, rule.draftId]
  );
  const credit = rule.method === "credit_card";
  return (
    <FieldSet className="@container min-w-0 not-first:border-t not-first:pt-4">
      <FieldLegend space="loose" variant="label">
        Regra {index + 1}
      </FieldLegend>
      <div className="grid @md:grid-cols-2 gap-4">
        <SelectField
          id={ruleFieldId(rule, "method")}
          label="Método"
          onChange={handleMethod}
          options={methodOptions}
          placeholder="Escolha"
          value={rule.method}
        />
        {credit ? (
          <>
            <TextField
              error={errors[ruleFieldId(rule, "installments")]}
              id={ruleFieldId(rule, "installments")}
              inputMode="numeric"
              label="Número de parcelas"
              maxLength={10}
              onChange={handleInstallments}
              value={rule.installments}
            />
            <SelectField
              id={ruleFieldId(rule, "plan")}
              label={INSTALLMENT_PLAN_LABEL}
              onChange={handlePlan}
              options={INSTALLMENT_PLAN_OPTIONS}
              placeholder={INSTALLMENT_PLAN_PLACEHOLDER}
              value={rule.installmentPlan}
            />
          </>
        ) : null}
        <TextField
          error={errors[ruleFieldId(rule, "settlement")]}
          hint="Estimativa em dias. Não confirma o recebimento."
          id={ruleFieldId(rule, "settlement")}
          inputMode="numeric"
          label="Prazo esperado de recebimento (dias)"
          maxLength={10}
          onChange={handleSettlement}
          placeholder="Não informado"
          value={rule.expectedSettlementDays}
        />
      </div>
      <div className="grid @xl:grid-cols-2 gap-3">
        <FeeFields
          errors={errors}
          id={ruleFieldId(rule, "processing")}
          label="Taxa de processamento"
          onChange={handleProcessing}
          value={rule.processingFee}
        />
        <FeeFields
          errors={errors}
          id={ruleFieldId(rule, "anticipation")}
          label="Taxa de antecipação"
          onChange={handleAnticipation}
          value={rule.anticipationFee}
        />
      </div>
      {canRemove ? (
        <div>
          <Button
            onClick={handleRemove}
            size="sm"
            type="button"
            variant="destructive"
          >
            <Trash2Icon aria-hidden="true" data-icon="inline-start" />
            Remover regra {index + 1}
          </Button>
        </div>
      ) : null}
    </FieldSet>
  );
}

interface PaymentProfileFormProps {
  draft: ProfileDraft;
  editingName: string | null;
  /** The problems of the fields, by the id of the field. */
  errors: Readonly<Record<string, string>>;
  onAddRule: () => void;
  onCancel: () => void;
  /** Offline the submit button says why (the notice's sentence) and nothing leaves. */
  online: boolean;
  onNameChange: (name: string) => void;
  onRemoveRule: (draftId: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUpdateRule: (draftId: string, changes: Partial<RuleDraft>) => void;
  pending: boolean;
}

function submitLabel(pending: boolean, editing: boolean): string {
  if (pending) {
    return "Salvando…";
  }
  return editing ? "Salvar alterações" : "Criar perfil";
}

/** The form of a new profile, or of the edit of one: the name and the rules. */
export function PaymentProfileForm({
  draft,
  editingName,
  errors,
  onAddRule,
  onCancel,
  onNameChange,
  onRemoveRule,
  onSubmit,
  onUpdateRule,
  online,
  pending,
}: PaymentProfileFormProps) {
  const headingId = useId();
  const editing = editingName !== null;
  return (
    <Card aria-labelledby={headingId} role="region">
      <form className="grid gap-4" noValidate onSubmit={onSubmit}>
        <CardHeader layout="row">
          <CardTitle aria-level={2} id={headingId} role="heading">
            {editing ? "Editar perfil" : "Novo perfil"}
          </CardTitle>
          {editing ? (
            <Button
              disabled={pending}
              onClick={onCancel}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancelar edição
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4">
          <TextField
            error={errors[NAME_ID]}
            id={NAME_ID}
            label="Nome do perfil"
            maxLength={100}
            onChange={onNameChange}
            value={draft.name}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-section">Regras de pagamento</h3>
            <Button
              id="payment-add-rule"
              onClick={onAddRule}
              size="sm"
              type="button"
              variant="outline"
            >
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              Adicionar regra
            </Button>
          </div>
          <div className="grid gap-4">
            {draft.rules.map((rule, index) => (
              <RuleEditor
                canRemove={draft.rules.length > 1}
                errors={errors}
                index={index}
                key={rule.draftId}
                onRemove={onRemoveRule}
                onUpdate={onUpdateRule}
                rule={rule}
              />
            ))}
          </div>
        </CardContent>
        <CardContent className="flex flex-col-reverse gap-3 min-[30rem]:flex-row min-[30rem]:justify-end">
          <Button
            {...connectionControlProps(online)}
            aria-busy={pending || undefined}
            disabled={pending}
            type="submit"
          >
            {submitLabel(pending, editing)}
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}
