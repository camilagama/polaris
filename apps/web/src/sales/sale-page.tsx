import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  InventoryBalanceEntryReadModel,
  PaymentProfileReadModel,
} from "@polaris/contracts";
import { browserStorage } from "../lib/current-organization-model";
import { formatBrlAmount } from "../lib/format";
import { useCurrentOrganization } from "../lib/current-organization";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { useNow } from "../lib/use-now";
import "./sale-page.css";
import {
  ADJUSTMENT_KINDS,
  acknowledgeProfileReview,
  attemptAfterFailure,
  cancelDiscard,
  discardLockedSale,
  editSaleForm,
  isFormLocked,
  requestDiscard,
  type AdjustmentDraft,
  addAdjustment,
  addItem,
  adjustmentFieldKey,
  type CatalogView,
  type ChoiceOption,
  canStartSubmission,
  type ConfirmedSaleView,
  confirmSubmission,
  createBlankSaleForm,
  editSaleDate,
  type EvaluationContext,
  evaluateSaleForm,
  failSubmission,
  type FeeLine,
  type FeePreview,
  formFieldKeys,
  SALE_DATE_HINT,
  INSTALLMENT_PLANS,
  idleSubmission,
  isSubmitting,
  type ItemDraft,
  itemFieldKey,
  MAX_SALE_ADJUSTMENTS,
  MAX_SALE_ITEMS,
  NO_PROFILE_CHOICE,
  prepareConfirmation,
  profilesView,
  reconcileProfileReload,
  rejectSubmission,
  removeAdjustment,
  removeItem,
  SALE_METHODS,
  type SaleAttempt,
  type SaleEvaluation,
  type SaleFormState,
  type SaleMethod,
  type SaleSummary,
  type SubmissionState,
  selectPaymentMethod,
  selectProfileChoice,
  startSubmission,
  stockView,
  submitButtonLabel,
  updateAdjustment,
  updateItem,
  updatePayment,
} from "./sale-form-model";
import {
  mergeLastPrices,
  type RememberedPrices,
  readLastPrices,
  suggestionHint,
  suggestPrices,
  withSuggestedPrices,
  writeLastPrices,
} from "./last-prices-model";
import { SaleCustomerDisclosure } from "./sale-customer-panel";
import { saleDetailHref } from "./sale-history-model";
import { SaleSnapshot } from "./sale-snapshot";
import {
  clearedItemChanges,
  itemChangesForEntry,
} from "./sale-variant-picker-model";
import { VariantSearch } from "./sale-variant-picker";
import { useSaleCatalog } from "./use-sale-catalog";

const adjustmentKindOptions: ChoiceOption[] = ADJUSTMENT_KINDS.map(
  ([id, label]) => ({ id, label })
);
const adjustmentTypeOptions: ChoiceOption[] = [
  { id: "fixed", label: "Valor fixo (R$)" },
  { id: "percentage", label: "Percentual (%)" },
];
const methodOptions: ChoiceOption[] = SALE_METHODS.map(([id, label]) => ({
  id,
  label,
}));
const planOptions: ChoiceOption[] = INSTALLMENT_PLANS.map(([id, label]) => ({
  id,
  label,
}));
const noProfileOption: ChoiceOption = {
  id: NO_PROFILE_CHOICE,
  label: "Sem perfil de pagamento (taxas e prazo desconhecidos)",
};

const newId = () => crypto.randomUUID();

/* -------------------------------------------------------------------------- */
/* Small controls                                                             */
/* -------------------------------------------------------------------------- */

interface FieldShellProps {
  children: ReactNode;
  error: string | undefined;
  hint: string | undefined;
  id: string;
  label: string;
}

function describedBy(
  id: string,
  error: string | undefined,
  hint: string | undefined
): string | undefined {
  const ids = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(
    (value): value is string => value !== null
  );
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function FieldShell({ children, error, hint, id, label }: FieldShellProps) {
  return (
    <div className="sale-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? (
        <p className="sale-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="sale-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface TextFieldProps {
  error?: string | undefined;
  hint?: string | undefined;
  id: string;
  inputMode: "decimal" | "numeric";
  label: string;
  maxLength: number;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  value: string;
}

function TextField({
  error,
  hint,
  id,
  inputMode,
  label,
  maxLength,
  onChange,
  placeholder,
  value,
}: TextFieldProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <FieldShell error={error} hint={hint} id={id} label={label}>
      <input
        aria-describedby={describedBy(id, error, hint)}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        id={id}
        inputMode={inputMode}
        maxLength={maxLength}
        onChange={handleChange}
        placeholder={placeholder}
        value={value}
      />
    </FieldShell>
  );
}

interface SelectFieldProps {
  disabled?: boolean;
  error?: string | undefined;
  hint?: string | undefined;
  id: string;
  label: string;
  onChange: (value: string) => void;
  options: readonly ChoiceOption[];
  placeholder: string;
  value: string;
}

function SelectField({
  disabled,
  error,
  hint,
  id,
  label,
  onChange,
  options,
  placeholder,
  value,
}: SelectFieldProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <FieldShell error={error} hint={hint} id={id} label={label}>
      <select
        aria-describedby={describedBy(id, error, hint)}
        aria-invalid={error ? true : undefined}
        disabled={disabled}
        id={id}
        onChange={handleChange}
        value={value}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

interface CatalogNoticeProps {
  onRetry: () => void;
  view: CatalogView | null;
}

/** Loading, error and empty states of a catalog read; renders nothing when ready. */
function CatalogNotice({ onRetry, view }: CatalogNoticeProps) {
  if (view === null || view.kind === "ready") {
    return null;
  }
  if (view.kind === "loading") {
    return (
      <p className="sale-status" role="status">
        {view.message}
      </p>
    );
  }
  if (view.kind === "error") {
    return (
      <p className="sale-message is-error" role="alert">
        {view.message}{" "}
        <button className="sale-link-button" onClick={onRetry} type="button">
          Tentar novamente
        </button>
      </p>
    );
  }
  return <p className="sale-empty">{view.message}</p>;
}

function optionsOf(view: CatalogView | null): readonly ChoiceOption[] {
  return view?.kind === "ready" ? view.options : [];
}

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

interface ItemEditorProps {
  canRemove: boolean;
  errors: Record<string, string>;
  index: number;
  item: ItemDraft;
  onChange: (draftId: string, changes: Partial<ItemDraft>) => void;
  onClearVariant: (draftId: string) => void;
  onPick: (draftId: string, entry: InventoryBalanceEntryReadModel) => void;
  onRemove: (draftId: string) => void;
  organizationId: string;
  priceHint: string | null;
  stock: EvaluationContext["stock"];
  stockWarning: string | undefined;
}

function ItemEditor({
  canRemove,
  errors,
  index,
  item,
  onChange,
  onClearVariant,
  onPick,
  onRemove,
  organizationId,
  priceHint,
  stock,
  stockWarning,
}: ItemEditorProps) {
  const prefix = `sale-item-${item.draftId}`;
  const chosen = item.variantId !== "";
  const stockState = chosen ? stockView(stock[item.variantId]) : null;
  const pickError =
    errors[itemFieldKey(item.draftId, "product")] ??
    errors[itemFieldKey(item.draftId, "variant")];
  const handlePick = useCallback(
    (entry: InventoryBalanceEntryReadModel) => onPick(item.draftId, entry),
    [item.draftId, onPick]
  );
  const handleClear = useCallback(
    () => onClearVariant(item.draftId),
    [item.draftId, onClearVariant]
  );
  const handleQuantity = useCallback(
    (value: string) => onChange(item.draftId, { quantity: value }),
    [item.draftId, onChange]
  );
  const handleListed = useCallback(
    (value: string) => onChange(item.draftId, { listedUnitPrice: value }),
    [item.draftId, onChange]
  );
  const handleCharged = useCallback(
    (value: string) => onChange(item.draftId, { chargedUnitPrice: value }),
    [item.draftId, onChange]
  );
  const handleRemove = useCallback(
    () => onRemove(item.draftId),
    [item.draftId, onRemove]
  );
  return (
    <fieldset className="sale-item">
      <legend>Item {index + 1}</legend>
      {chosen ? (
        <div className="sale-chosen">
          <p className="sale-chosen-label">{item.label}</p>
          <button
            className="quiet-button sale-chosen-change"
            onClick={handleClear}
            type="button"
          >
            Trocar variante
          </button>
        </div>
      ) : (
        <VariantSearch
          error={pickError}
          id={prefix}
          onPick={handlePick}
          organizationId={organizationId}
        />
      )}
      {stockState ? (
        <p
          className={`sale-stock is-${stockState.tone}`}
          id={`${prefix}-stock`}
          role="status"
        >
          {stockState.text} {stockState.costText}
        </p>
      ) : null}
      {stockWarning ? (
        <p className="sale-message is-warning" role="status">
          {stockWarning}
        </p>
      ) : null}
      <div className="sale-grid is-three">
        <TextField
          error={errors[itemFieldKey(item.draftId, "quantity")]}
          id={`${prefix}-quantity`}
          inputMode="numeric"
          label="Quantidade"
          maxLength={10}
          onChange={handleQuantity}
          value={item.quantity}
        />
        <TextField
          error={errors[itemFieldKey(item.draftId, "listedUnitPrice")]}
          hint="Preço de tabela por unidade."
          id={`${prefix}-listed`}
          inputMode="decimal"
          label="Preço de tabela (R$)"
          maxLength={22}
          onChange={handleListed}
          placeholder="Ex.: 59,90"
          value={item.listedUnitPrice}
        />
        <TextField
          error={errors[itemFieldKey(item.draftId, "chargedUnitPrice")]}
          hint="Preço negociado por unidade."
          id={`${prefix}-charged`}
          inputMode="decimal"
          label="Preço cobrado (R$)"
          maxLength={22}
          onChange={handleCharged}
          placeholder="Ex.: 49,90"
          value={item.chargedUnitPrice}
        />
      </div>
      {priceHint ? (
        <p className="sale-hint" role="note">
          {priceHint}
        </p>
      ) : null}
      {canRemove ? (
        <button className="sale-remove" onClick={handleRemove} type="button">
          Remover item {index + 1}
        </button>
      ) : null}
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/* Adjustments                                                                */
/* -------------------------------------------------------------------------- */

interface AdjustmentEditorProps {
  adjustment: AdjustmentDraft;
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
    <fieldset className="sale-item">
      <legend>Ajuste {index + 1}</legend>
      <div className="sale-grid is-three">
        <SelectField
          id={`${prefix}-kind`}
          label="Tipo de ajuste"
          onChange={handleKind}
          options={adjustmentKindOptions}
          placeholder="Escolha o tipo"
          value={adjustment.kind}
        />
        {percentageAllowed ? (
          <SelectField
            id={`${prefix}-type`}
            label="Como informar"
            onChange={handleType}
            options={adjustmentTypeOptions}
            placeholder="Escolha"
            value={adjustment.valueType}
          />
        ) : null}
        <TextField
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
          placeholder={percentage ? "Ex.: 2,5" : "Ex.: 15,00"}
          value={adjustment.value}
        />
      </div>
      <button className="sale-remove" onClick={handleRemove} type="button">
        Remover ajuste {index + 1}
      </button>
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/* Payment                                                                    */
/* -------------------------------------------------------------------------- */

interface DateSectionProps {
  disabled: boolean;
  error: string | undefined;
  onChange: (value: string) => void;
  value: string;
}

/** The optional commercial date and time; empty means now. */
function DateSection({ disabled, error, onChange, value }: DateSectionProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  const handleClear = useCallback(() => onChange(""), [onChange]);
  return (
    <fieldset className="sale-section" disabled={disabled}>
      <legend>Data e hora da venda</legend>
      <div className="sale-field">
        <label htmlFor="sale-occurred-at">
          Data e hora da venda (opcional)
        </label>
        <input
          aria-describedby={
            error
              ? "sale-occurred-at-error sale-occurred-at-hint"
              : "sale-occurred-at-hint"
          }
          aria-invalid={error ? true : undefined}
          id="sale-occurred-at"
          onChange={handleChange}
          type="datetime-local"
          value={value}
        />
        <p className="sale-hint" id="sale-occurred-at-hint">
          {SALE_DATE_HINT}
        </p>
        {error ? (
          <p className="sale-error" id="sale-occurred-at-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {value === "" ? null : (
        <button className="quiet-button" onClick={handleClear} type="button">
          Usar agora
        </button>
      )}
    </fieldset>
  );
}

interface PaymentSectionProps {
  disabled: boolean;
  errors: Record<string, string>;
  evaluation: SaleEvaluation;
  form: SaleFormState;
  onAcknowledgeReview: () => void;
  onInstallmentPlanChange: (value: string) => void;
  onInstallmentsChange: (value: string) => void;
  onMethodChange: (value: string) => void;
  onProfileChange: (value: string) => void;
  onRetry: () => void;
  profileOptions: readonly ChoiceOption[];
  profilesView: CatalogView;
  onAnticipationChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

function PaymentSection({
  disabled,
  errors,
  evaluation,
  form,
  onAcknowledgeReview,
  onAnticipationChange,
  onInstallmentPlanChange,
  onInstallmentsChange,
  onMethodChange,
  onProfileChange,
  onRetry,
  profileOptions,
  profilesView: profilesState,
}: PaymentSectionProps) {
  const card = form.payment.method === "credit_card";
  const options = [noProfileOption, ...profileOptions];
  return (
    <fieldset className="sale-section" disabled={disabled}>
      <legend>Pagamento</legend>
      <p className="sale-help">
        A venda tem um único pagamento, igual ao total devido
        {evaluation.summary
          ? `: ${formatBrlAmount(evaluation.summary.totalDue)}`
          : ""}
        . Não há pagamento parcial, e o método escolhido não comprova
        liquidação.
      </p>
      <div className="sale-grid">
        <SelectField
          error={errors[formFieldKeys.method]}
          id="sale-method"
          label="Método de pagamento"
          onChange={onMethodChange}
          options={methodOptions}
          placeholder="Escolha o método"
          value={form.payment.method}
        />
        {card ? (
          <TextField
            error={errors[formFieldKeys.installments]}
            id="sale-installments"
            inputMode="numeric"
            label="Número de parcelas"
            maxLength={10}
            onChange={onInstallmentsChange}
            value={form.payment.installments}
          />
        ) : null}
        {card ? (
          <SelectField
            error={errors[formFieldKeys.installmentPlan]}
            id="sale-plan"
            label="Modalidade do parcelamento"
            onChange={onInstallmentPlanChange}
            options={planOptions}
            placeholder="Escolha a modalidade"
            value={form.payment.installmentPlan}
          />
        ) : null}
      </div>
      <div className="sale-check">
        <input
          aria-describedby="sale-anticipation-hint"
          checked={form.payment.anticipationRequested}
          disabled={!card}
          id="sale-anticipation"
          onChange={onAnticipationChange}
          type="checkbox"
        />
        <label htmlFor="sale-anticipation">
          Pretendo antecipar este recebimento
        </label>
      </div>
      <p className="sale-hint" id="sale-anticipation-hint">
        {card
          ? "É uma intenção registrada na venda; não indica que a antecipação ocorreu."
          : "Disponível apenas para cartão de crédito. Sem antecipação, o custo estimado é R$ 0,00."}
      </p>
      <SelectField
        error={errors[formFieldKeys.profile]}
        hint="O perfil define taxas e prazo estimados. Escolha “Sem perfil” se não quiser usar nenhum; nesse caso taxas e prazo ficam desconhecidos."
        id="sale-profile"
        label="Perfil de pagamento"
        onChange={onProfileChange}
        options={options}
        placeholder="Escolha uma opção"
        value={form.profile.choice}
      />
      <CatalogNotice onRetry={onRetry} view={profilesState} />
      {form.profile.reviewNotice ? (
        <div className="sale-message is-warning" role="alert">
          <p>{form.profile.reviewNotice}</p>
          {form.profile.choice === "" ? null : (
            <button
              className="quiet-button"
              onClick={onAcknowledgeReview}
              type="button"
            >
              Revisei a prévia atualizada
            </button>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/* Summary and preview                                                        */
/* -------------------------------------------------------------------------- */

function FeeValue({ line }: { line: FeeLine }) {
  return <dd className={`sale-fee is-${line.tone}`}>{line.text}</dd>;
}

function FeePreviewPanel({ preview }: { preview: FeePreview | null }) {
  return (
    <section aria-labelledby="sale-preview-title" className="sale-preview">
      <h3 id="sale-preview-title">Prévia de taxas e prazo</h3>
      <p className="sale-hint">
        Informativa: o servidor recalcula e registra o snapshot ao confirmar.
      </p>
      {preview ? (
        <dl className="sale-details">
          <div>
            <dt>Perfil de pagamento</dt>
            <dd>{preview.profileText}</dd>
          </div>
          <div>
            <dt>Regra</dt>
            <dd
              className={
                preview.ruleMatched ? undefined : "sale-fee is-unknown"
              }
            >
              {preview.ruleText}
            </dd>
          </div>
          <div>
            <dt>Taxa de processamento</dt>
            <FeeValue line={preview.processing} />
          </div>
          <div>
            <dt>Antecipação</dt>
            <FeeValue line={preview.anticipation} />
          </div>
          <div>
            <dt>Prazo</dt>
            <dd
              className={
                preview.settlementText.startsWith("prazo desconhecido")
                  ? "sale-fee is-unknown"
                  : undefined
              }
            >
              {preview.settlementText}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="sale-empty">
          Complete itens, pagamento e perfil para ver a prévia.
        </p>
      )}
    </section>
  );
}

interface SummaryPanelProps {
  errors: Record<string, string>;
  evaluation: SaleEvaluation;
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  onDiscardRequest: () => void;
  onRefresh: () => void;
  showRequired: boolean;
  submission: SubmissionState;
  summary: SaleSummary | null;
}

function SummaryPanel({
  errors,
  evaluation,
  onDiscardCancel,
  onDiscardConfirm,
  onDiscardRequest,
  onRefresh,
  showRequired,
  submission,
  summary,
}: SummaryPanelProps) {
  const errorCount = Object.keys(errors).length;
  return (
    <aside aria-labelledby="sale-summary-title" className="sale-summary">
      <h2 id="sale-summary-title">Resumo da venda</h2>
      {summary ? (
        <>
          <ul className="sale-lines">
            {summary.lines.map((line) => (
              <li key={line.draftId}>
                <span className="sale-line-label">
                  {line.label || "Item sem variante escolhida"}
                </span>
                <span>
                  {line.quantity} × {line.priceText}
                </span>
                <strong>{line.lineTotalText}</strong>
                {line.negotiationText ? (
                  <small>{line.negotiationText}</small>
                ) : null}
              </li>
            ))}
          </ul>
          <dl aria-live="polite" className="sale-totals">
            {summary.rows.map((row) => (
              <div className={`is-${row.tone}`} key={row.key}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="sale-empty">
          Os totais aparecem quando itens e ajustes estiverem válidos.
        </p>
      )}
      {errors[formFieldKeys.totals] ? (
        <p className="sale-error" role="alert">
          {errors[formFieldKeys.totals]}
        </p>
      ) : null}
      <dl className="sale-details">
        <div>
          <dt>Data e hora da venda</dt>
          <dd>{evaluation.dateText}</dd>
        </div>
        <div>
          <dt>Pagamento</dt>
          <dd>{evaluation.methodText}</dd>
        </div>
        <div>
          <dt>Perfil de pagamento</dt>
          <dd>{evaluation.profileText}</dd>
        </div>
      </dl>
      <FeePreviewPanel preview={evaluation.feePreview} />
      {showRequired && errorCount > 0 ? (
        <p className="sale-message is-error" role="alert">
          Corrija {errorCount} {errorCount === 1 ? "campo" : "campos"} antes de
          confirmar a venda.
        </p>
      ) : null}
      <FailureNotice
        onDiscardCancel={onDiscardCancel}
        onDiscardConfirm={onDiscardConfirm}
        onDiscardRequest={onDiscardRequest}
        onRefresh={onRefresh}
        submission={submission}
      />
      <button
        className="primary-button sale-submit"
        disabled={isSubmitting(submission)}
        type="submit"
      >
        {submitButtonLabel(submission)}
      </button>
    </aside>
  );
}

interface FailureNoticeProps {
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  onDiscardRequest: () => void;
  onRefresh: () => void;
  submission: SubmissionState;
}

/** Shows a failed or locked submission and the actions allowed for it. */
function FailureNotice({
  onDiscardCancel,
  onDiscardConfirm,
  onDiscardRequest,
  onRefresh,
  submission,
}: FailureNoticeProps) {
  if (submission.phase === "failed") {
    return (
      <div className="sale-message is-error" role="alert">
        <p>{submission.failure.message}</p>
        {submission.failure.refreshData ? (
          <button className="quiet-button" onClick={onRefresh} type="button">
            Atualizar dados e revisar a venda
          </button>
        ) : null}
      </div>
    );
  }
  if (submission.phase !== "locked") {
    return null;
  }
  return (
    <div className="sale-message is-error sale-locked" role="alert">
      <p>{submission.failure.message}</p>
      {submission.confirmingDiscard ? (
        <>
          <p>
            <strong>Esta venda pode já ter sido registrada.</strong> Se você
            descartá-la e digitar a venda de novo, ela pode ficar duplicada.
            Descarte só se tiver verificado que ela não foi registrada.
          </p>
          <div className="sale-actions">
            <button
              className="danger-button"
              onClick={onDiscardConfirm}
              type="button"
            >
              Sim, descartar e começar outra
            </button>
            <button
              className="quiet-button"
              onClick={onDiscardCancel}
              type="button"
            >
              Voltar
            </button>
          </div>
        </>
      ) : (
        <button
          className="quiet-button"
          onClick={onDiscardRequest}
          type="button"
        >
          Descartar esta venda e começar outra
        </button>
      )}
    </div>
  );
}

interface ConfirmedPanelProps {
  organizationId: string;
  panelRef: RefObject<HTMLElement | null>;
  sale: ConfirmedSaleView;
}

function ConfirmedSalePanel({
  organizationId,
  panelRef,
  sale,
}: ConfirmedPanelProps) {
  return (
    <section
      aria-labelledby="sale-confirmed-title"
      className="sale-confirmed"
      ref={panelRef}
      tabIndex={-1}
    >
      <h2 id="sale-confirmed-title" role="status">
        {sale.headline}
      </h2>
      <SaleSnapshot sale={sale} />
      <p className="sale-hint">
        <a href={saleDetailHref(sale.saleId)}>
          Ver detalhes e histórico da venda
        </a>
      </p>
      <p className="sale-hint">
        O formulário abaixo foi reiniciado para uma nova venda.
      </p>
      <SaleCustomerDisclosure
        key={sale.saleId}
        organizationId={organizationId}
        saleId={sale.saleId}
      />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

function focusFirstInvalidField() {
  window.requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>('.sale-page [aria-invalid="true"]')
      ?.focus();
  });
}

/** Re-evaluating the form every minute keeps "now" honest on a form left open. */
const CLOCK_TICK_MS = 60_000;

export function SalePage() {
  const { organizationId } = useCurrentOrganization();
  const now = useNow(CLOCK_TICK_MS);
  const [lastPrices, setLastPrices] = useState<RememberedPrices>(() =>
    readLastPrices(browserStorage(), organizationId)
  );
  const [form, setForm] = useState<SaleFormState>(() =>
    createBlankSaleForm(newId)
  );
  const [submission, setSubmission] = useState<SubmissionState>(idleSubmission);
  const [showRequired, setShowRequired] = useState(false);
  const attemptRef = useRef<SaleAttempt | null>(null);
  const inFlightRef = useRef<boolean>(false);
  const confirmedRef = useRef<HTMLElement | null>(null);

  const handleProfilesLoaded = useCallback(
    (profiles: PaymentProfileReadModel[]) => {
      setForm((current) => reconcileProfileReload(current, profiles));
    },
    []
  );
  const catalog = useSaleCatalog(organizationId, handleProfilesLoaded);
  const { refresh, resetStock, seedStock } = catalog;

  const activeProfiles = useMemo(
    () => (catalog.profiles.status === "ready" ? catalog.profiles.value : []),
    [catalog.profiles]
  );
  const profilesState = profilesView(catalog.profiles);
  const evaluation = useMemo(
    () =>
      evaluateSaleForm(
        form,
        { profiles: activeProfiles, stock: catalog.stock },
        { now, showRequired }
      ),
    [activeProfiles, catalog.stock, form, now, showRequired]
  );

  useEffect(() => {
    if (submission.phase === "confirmed") {
      confirmedRef.current?.focus();
    }
  }, [submission.phase]);

  const handleRefresh = useCallback(() => {
    refresh(
      form.items
        .map((item) => item.variantId)
        .filter((variantId) => variantId !== "")
    );
  }, [form.items, refresh]);

  const editForm = useCallback(
    (edit: (current: SaleFormState) => SaleFormState) =>
      setForm((current) => editSaleForm(submission, current, edit)),
    [submission]
  );
  const handleItemChange = useCallback(
    (draftId: string, changes: Partial<ItemDraft>) =>
      editForm((current) => updateItem(current, draftId, changes)),
    [editForm]
  );
  const handleClearVariant = useCallback(
    (draftId: string) => {
      editForm((current) => updateItem(current, draftId, clearedItemChanges));
      focusLater(() =>
        document.getElementById(`sale-item-${draftId}-search`)?.focus()
      );
    },
    [editForm]
  );
  const handlePickVariant = useCallback(
    (draftId: string, entry: InventoryBalanceEntryReadModel) => {
      seedStock([entry]);
      const suggestion = suggestPrices(lastPrices, entry.variantId);
      editForm((current) => {
        const item = current.items.find(
          (candidate) => candidate.draftId === draftId
        );
        const prices = item ? withSuggestedPrices(item, suggestion) : null;
        return updateItem(current, draftId, {
          ...itemChangesForEntry(entry),
          ...(prices
            ? {
                chargedUnitPrice: prices.chargedUnitPrice,
                listedUnitPrice: prices.listedUnitPrice,
              }
            : {}),
        });
      });
      focusLater(() =>
        document.getElementById(`sale-item-${draftId}-quantity`)?.focus()
      );
    },
    [editForm, lastPrices, seedStock]
  );
  const handleAddItem = useCallback(
    () => editForm((current) => addItem(current, newId())),
    [editForm]
  );
  const handleRemoveItem = useCallback(
    (draftId: string) => editForm((current) => removeItem(current, draftId)),
    [editForm]
  );
  const handleAddAdjustment = useCallback(
    () => editForm((current) => addAdjustment(current, newId())),
    [editForm]
  );
  const handleAdjustmentChange = useCallback(
    (draftId: string, changes: Partial<Omit<AdjustmentDraft, "draftId">>) =>
      editForm((current) => updateAdjustment(current, draftId, changes)),
    [editForm]
  );
  const handleRemoveAdjustment = useCallback(
    (draftId: string) =>
      editForm((current) => removeAdjustment(current, draftId)),
    [editForm]
  );
  const handleDateChange = useCallback(
    (value: string) => editForm((current) => editSaleDate(current, value)),
    [editForm]
  );
  const handleMethodChange = useCallback(
    (value: string) =>
      editForm((current) =>
        selectPaymentMethod(current, value as SaleMethod | "")
      ),
    [editForm]
  );
  const handleInstallmentsChange = useCallback(
    (value: string) =>
      editForm((current) => updatePayment(current, { installments: value })),
    [editForm]
  );
  const handlePlanChange = useCallback(
    (value: string) =>
      editForm((current) =>
        updatePayment(current, {
          installmentPlan: value as "" | "issuer" | "merchant",
        })
      ),
    [editForm]
  );
  const handleAnticipationChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { checked } = event.target;
      editForm((current) =>
        updatePayment(current, { anticipationRequested: checked })
      );
    },
    [editForm]
  );
  const handleProfileChange = useCallback(
    (value: string) =>
      editForm((current) =>
        selectProfileChoice(current, value, activeProfiles)
      ),
    [activeProfiles, editForm]
  );
  const handleAcknowledgeReview = useCallback(
    () =>
      editForm((current) => acknowledgeProfileReview(current, activeProfiles)),
    [activeProfiles, editForm]
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (inFlightRef.current) {
        return;
      }
      setShowRequired(true);
      // The clock is read at the click, not taken from the last render.
      const submittedAt = new Date();
      const fresh = evaluateSaleForm(
        form,
        { profiles: activeProfiles, stock: catalog.stock },
        { now: submittedAt, showRequired: true }
      );
      const { body } = fresh;
      if (body === null || !canStartSubmission(submission, fresh)) {
        focusFirstInvalidField();
        return;
      }
      const prepared = prepareConfirmation({
        occurredAtOverride: fresh.occurredAtOverride,
        body,
        createId: newId,
        now: submittedAt,
        organizationId,
        previousAttempt: attemptRef.current,
      });
      if (!prepared.ok) {
        setSubmission(rejectSubmission(prepared.message));
        return;
      }
      attemptRef.current = prepared.attempt;
      inFlightRef.current = true;
      setSubmission(startSubmission(submission));
      try {
        const sale = await orpcClient.sale.confirm(prepared.request);
        attemptRef.current = null;
        const remembered = mergeLastPrices(
          lastPrices,
          sale.items,
          sale.sale.occurredOn
        );
        setLastPrices(remembered);
        writeLastPrices(browserStorage(), organizationId, remembered);
        setSubmission(confirmSubmission(sale));
        setForm(createBlankSaleForm(newId));
        setShowRequired(false);
        resetStock();
      } catch (error) {
        const failed = failSubmission(error);
        attemptRef.current = attemptAfterFailure(failed, prepared.attempt);
        setSubmission(failed);
      } finally {
        inFlightRef.current = false;
      }
    },
    [
      activeProfiles,
      catalog.stock,
      form,
      lastPrices,
      organizationId,
      resetStock,
      submission,
    ]
  );
  const handleDiscardRequest = useCallback(
    () => setSubmission((current) => requestDiscard(current)),
    []
  );
  const handleDiscardCancel = useCallback(
    () => setSubmission((current) => cancelDiscard(current)),
    []
  );
  const handleDiscardConfirm = useCallback(() => {
    const discarded = discardLockedSale(submission, newId);
    if (discarded === null) {
      return;
    }
    attemptRef.current = discarded.attempt;
    setForm(discarded.form);
    setSubmission(discarded.submission);
    setShowRequired(false);
    resetStock();
  }, [resetStock, submission]);
  const handleSubmitEvent = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      handleSubmit(event).catch(() => undefined);
    },
    [handleSubmit]
  );

  const locked = isFormLocked(submission);
  const profileOptions = optionsOf(profilesState);
  return (
    <div className="sale-page">
      <section className="categories-heading">
        <div>
          <p className="categories-eyebrow">Vendas</p>
          <h1>Nova venda</h1>
          <p className="categories-intro-copy">
            Monte a venda inteira e confirme uma única vez. Nada é salvo como
            rascunho: a venda só existe depois de confirmada pelo servidor.
          </p>
        </div>
      </section>
      {submission.phase === "confirmed" ? (
        <ConfirmedSalePanel
          key={submission.sale.saleId}
          organizationId={organizationId}
          panelRef={confirmedRef}
          sale={submission.sale}
        />
      ) : null}
      <form
        aria-label="Nova venda"
        className="sale-workspace"
        noValidate
        onSubmit={handleSubmitEvent}
      >
        <div className="sale-main">
          <fieldset className="sale-section" disabled={locked}>
            <legend>Itens da venda</legend>
            <div className="sale-toolbar">
              <p className="sale-help">
                Informe os preços: o catálogo não tem preço. A diferença entre
                tabela e cobrado é a negociação do item e já entra no subtotal.
              </p>
              <button
                className="quiet-button"
                onClick={handleRefresh}
                type="button"
              >
                Atualizar estoque e perfis
              </button>
            </div>
            {form.items.map((item, index) => (
              <ItemEditor
                canRemove={form.items.length > 1}
                errors={evaluation.errors}
                index={index}
                item={item}
                key={item.draftId}
                onChange={handleItemChange}
                onClearVariant={handleClearVariant}
                onPick={handlePickVariant}
                onRemove={handleRemoveItem}
                organizationId={organizationId}
                priceHint={suggestionHint(lastPrices, item)}
                stock={catalog.stock}
                stockWarning={evaluation.stockWarnings[item.draftId]}
              />
            ))}
            <button
              className="quiet-button"
              disabled={form.items.length >= MAX_SALE_ITEMS}
              onClick={handleAddItem}
              type="button"
            >
              Adicionar item
            </button>
          </fieldset>
          <fieldset className="sale-section" disabled={locked}>
            <legend>Ajustes da venda</legend>
            <p className="sale-help">
              Desconto, acréscimo, frete e sobretaxa de pagamento. Percentuais
              usam o mesmo subtotal e o total de descontos não pode
              ultrapassá-lo.
            </p>
            {form.adjustments.length === 0 ? (
              <p className="sale-empty">Nenhum ajuste nesta venda.</p>
            ) : null}
            {form.adjustments.map((adjustment, index) => (
              <AdjustmentEditor
                adjustment={adjustment}
                error={
                  evaluation.errors[adjustmentFieldKey(adjustment.draftId)]
                }
                index={index}
                key={adjustment.draftId}
                onChange={handleAdjustmentChange}
                onRemove={handleRemoveAdjustment}
              />
            ))}
            {evaluation.errors[formFieldKeys.adjustments] ? (
              <p className="sale-error" role="alert">
                {evaluation.errors[formFieldKeys.adjustments]}
              </p>
            ) : null}
            <button
              className="quiet-button"
              disabled={form.adjustments.length >= MAX_SALE_ADJUSTMENTS}
              onClick={handleAddAdjustment}
              type="button"
            >
              Adicionar ajuste
            </button>
          </fieldset>
          <DateSection
            disabled={locked}
            error={evaluation.errors[formFieldKeys.occurredAt]}
            onChange={handleDateChange}
            value={form.occurredAtLocal}
          />
          <PaymentSection
            disabled={locked}
            errors={evaluation.errors}
            evaluation={evaluation}
            form={form}
            onAcknowledgeReview={handleAcknowledgeReview}
            onAnticipationChange={handleAnticipationChange}
            onInstallmentPlanChange={handlePlanChange}
            onInstallmentsChange={handleInstallmentsChange}
            onMethodChange={handleMethodChange}
            onProfileChange={handleProfileChange}
            onRetry={handleRefresh}
            profileOptions={profileOptions}
            profilesView={profilesState}
          />
        </div>
        <SummaryPanel
          errors={evaluation.errors}
          evaluation={evaluation}
          onDiscardCancel={handleDiscardCancel}
          onDiscardConfirm={handleDiscardConfirm}
          onDiscardRequest={handleDiscardRequest}
          onRefresh={handleRefresh}
          showRequired={showRequired}
          submission={submission}
          summary={evaluation.summary}
        />
      </form>
    </div>
  );
}
