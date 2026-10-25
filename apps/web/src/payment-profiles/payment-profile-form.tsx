import PlusIcon from "lucide-react/dist/esm/icons/plus";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2";
import { type FormEvent, type ReactNode, useCallback } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { FieldLegend, FieldSet } from "@/ui/field";
import {
  ConnectionRequiredDialogNotice,
  connectionControlProps,
  connectionDialogReasonId,
} from "../app-shell/connection-required-notice";
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
    <FieldSet className="min-w-0 content-start gap-3 rounded-lg border p-3">
      <FieldLegend className="mb-0 px-1" variant="label">
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
    <FieldSet className="@container min-w-0 gap-4 not-first:border-t not-first:pt-4">
      <FieldLegend className="mb-3" variant="label">
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
  /** What the last action said, drawn by the page: the dialog covers the top of the screen, so it is said inside. */
  feedback: ReactNode;
  /** Where the focus goes when the form closes: the notice, or the control that opened it. */
  finalFocus: () => HTMLElement | boolean;
  onAddRule: () => void;
  onCancel: () => void;
  /** The profile asked for is already on the list: the main button says "Criar mesmo assim". */
  confirmDuplicate: boolean;
  /** The form has finished closing: the draft can be emptied without the form changing under the fade. */
  onClosed: () => void;
  /** Esc and "Fechar": the form closes and what was typed is kept, in memory, for the next opening. */
  onDismiss: () => void;
  /** Offline the submit button says why (the notice's sentence) and nothing leaves. */
  online: boolean;
  onNameChange: (name: string) => void;
  onRemoveRule: (draftId: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUpdateRule: (draftId: string, changes: Partial<RuleDraft>) => void;
  open: boolean;
  pending: boolean;
}

function submitLabel(
  pending: boolean,
  editing: boolean,
  confirmDuplicate: boolean
): string {
  if (pending) {
    return "Salvando…";
  }
  if (confirmDuplicate) {
    return "Criar mesmo assim";
  }
  return editing ? "Salvar alterações" : "Criar perfil";
}

/**
 * The form of a new profile, or of the edit of one, in a dialog (the whole screen on a phone): the name and the
 * rules. Esc and "Fechar" close it and keep what was typed (in memory only: the next opening of the same form brings
 * it back); only "Cancelar" and a saved profile throw it away. Nothing closes while a save is on its way, and a tap
 * on the veil does nothing.
 */
export function PaymentProfileForm({
  confirmDuplicate,
  draft,
  editingName,
  errors,
  feedback,
  finalFocus,
  onAddRule,
  onCancel,
  onClosed,
  onDismiss,
  onNameChange,
  onRemoveRule,
  onSubmit,
  onUpdateRule,
  online,
  open,
  pending,
}: PaymentProfileFormProps) {
  const editing = editingName !== null;
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!(next || pending)) {
        onDismiss();
      }
    },
    [onDismiss, pending]
  );
  const handleOpenChangeComplete = useCallback(
    (next: boolean) => {
      if (!next) {
        onClosed();
      }
    },
    [onClosed]
  );
  return (
    <Dialog
      disablePointerDismissal
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={handleOpenChangeComplete}
      open={open}
    >
      <DialogContent finalFocus={finalFocus} layout="form">
        <DialogForm onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>
              {editing ? "Editar perfil" : "Novo perfil"}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            {feedback}
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
          </DialogBody>
          <ConnectionRequiredDialogNotice online={online} />
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={onCancel}
              type="button"
              variant="outline"
            >
              {editing ? "Cancelar edição" : "Cancelar"}
            </Button>
            <Button
              {...connectionControlProps(online, connectionDialogReasonId)}
              aria-busy={pending || undefined}
              disabled={pending}
              type="submit"
            >
              {submitLabel(pending, editing, confirmDuplicate)}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
