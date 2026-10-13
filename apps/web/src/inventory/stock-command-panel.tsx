import type { InventoryBalanceReadModel } from "@polaris/contracts";
import type { WriteOffReasonCode } from "@polaris/domain/inventory/write-off-stock";
import {
  type ChangeEvent,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { orpcClient } from "../lib/orpc";
import {
  backToStockEditing,
  canCloseStock,
  cancelDiscardStock,
  discardLockedStock,
  editStockField,
  firstInvalidStockField,
  mapStockError,
  prepareStockSubmission,
  requestDiscardStock,
  retargetStock,
  reviewStock,
  STOCK_ACTION_LABELS,
  STOCK_FIELD_ORDER,
  type StockAction,
  type StockCommandState,
  type StockFailure,
  type StockFieldName,
  type StockResult,
  startStockCommand,
  stockActionBlock,
  stockConsequence,
  stockFailed,
  stockSubmitLabel,
  stockSucceeded,
  stockSummary,
  validateStockDraft,
  valuationApplies,
  visibleStockIssues,
  WRITE_OFF_REASONS,
} from "./stock-command-model";
import { costText, type StockTarget, unitsText } from "./stock-target";

const newId = () => crypto.randomUUID();

interface StockCommandPanelProps {
  action: StockAction;
  organizationId: string;
  /** The panel was closed; the page restores focus to the row's button. */
  onClose: () => void;
  /** The server answered with a newer balance for this variant. */
  onBalance: (
    balance: InventoryBalanceReadModel,
    updatedAt: string | null
  ) => void;
  /** The variant or its product changed under the screen. */
  onReloadList: () => void;
  target: StockTarget;
  today: string;
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                     */
/* -------------------------------------------------------------------------- */

interface FieldProps {
  disabled: boolean;
  error: string | undefined;
  hint?: string | undefined;
  id: string;
  inputRef: (element: HTMLElement | null) => void;
  label: string;
}

function describedBy(
  id: string,
  error: string | undefined,
  hint: string | undefined
) {
  const ids = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(
    (value): value is string => value !== null
  );
  return ids.length > 0 ? ids.join(" ") : undefined;
}

interface TextFieldProps extends FieldProps {
  inputMode: "decimal" | "numeric" | undefined;
  maxLength: number;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  type?: "date" | "text";
  value: string;
}

function TextField({
  disabled,
  error,
  hint,
  id,
  inputMode,
  inputRef,
  label,
  maxLength,
  onChange,
  placeholder,
  type = "text",
  value,
}: TextFieldProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <div className="stock-field">
      <label htmlFor={id}>{label}</label>
      <input
        aria-describedby={describedBy(id, error, hint)}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        disabled={disabled}
        id={id}
        inputMode={inputMode}
        maxLength={type === "date" ? undefined : maxLength}
        onChange={handleChange}
        placeholder={placeholder}
        ref={inputRef}
        type={type}
        value={value}
      />
      {hint ? (
        <p className="stock-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="stock-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface ReasonFieldsProps {
  disabled: boolean;
  noteError: string | undefined;
  onNoteChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  prefix: string;
  reasonCode: WriteOffReasonCode | "";
  reasonError: string | undefined;
  reasonNote: string;
  registerRef: (field: StockFieldName) => (element: HTMLElement | null) => void;
}

function ReasonFields({
  disabled,
  noteError,
  onNoteChange,
  onReasonChange,
  prefix,
  reasonCode,
  reasonError,
  reasonNote,
  registerRef,
}: ReasonFieldsProps) {
  const handleReason = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onReasonChange(event.target.value),
    [onReasonChange]
  );
  const handleNote = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      onNoteChange(event.target.value),
    [onNoteChange]
  );
  return (
    <>
      <div className="stock-field">
        <label htmlFor={`${prefix}-reason`}>Motivo da baixa</label>
        <select
          aria-describedby={reasonError ? `${prefix}-reason-error` : undefined}
          aria-invalid={reasonError ? true : undefined}
          disabled={disabled}
          id={`${prefix}-reason`}
          onChange={handleReason}
          ref={registerRef("reasonCode")}
          value={reasonCode}
        >
          <option value="">Escolha o motivo</option>
          {WRITE_OFF_REASONS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        {reasonError ? (
          <p className="stock-error" id={`${prefix}-reason-error`} role="alert">
            {reasonError}
          </p>
        ) : null}
      </div>
      <div className="stock-field">
        <label htmlFor={`${prefix}-note`}>
          {reasonCode === "other"
            ? "Observação (obrigatória para “Outro”)"
            : "Observação (opcional)"}
        </label>
        <textarea
          aria-describedby={noteError ? `${prefix}-note-error` : undefined}
          aria-invalid={noteError ? true : undefined}
          disabled={disabled}
          id={`${prefix}-note`}
          onChange={handleNote}
          ref={registerRef("reasonNote")}
          rows={3}
          value={reasonNote}
        />
        {noteError ? (
          <p className="stock-error" id={`${prefix}-note-error`} role="alert">
            {noteError}
          </p>
        ) : null}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

interface EditFieldsProps {
  disabled: boolean;
  errors: Partial<Record<StockFieldName, string>>;
  onChange: (field: StockFieldName, value: string) => void;
  prefix: string;
  registerRef: (field: StockFieldName) => (element: HTMLElement | null) => void;
  state: StockCommandState;
}

function EditFields({
  disabled,
  errors,
  onChange,
  prefix,
  registerRef,
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

  return (
    <div className="stock-fields">
      {draft.action === "receive" ? (
        <>
          <TextField
            disabled={disabled}
            error={errors.quantity}
            id={`${prefix}-quantity`}
            inputMode="numeric"
            inputRef={registerRef("quantity")}
            label="Quantidade recebida"
            maxLength={10}
            onChange={handleQuantity}
            value={draft.quantity}
          />
          <TextField
            disabled={disabled}
            error={errors.unitCost}
            hint="Custo de cada unidade, em reais. Obrigatório: ele alimenta o custo médio."
            id={`${prefix}-unit-cost`}
            inputMode="decimal"
            inputRef={registerRef("unitCost")}
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
          <TextField
            disabled={disabled}
            error={errors.physicalQuantity}
            hint={`Saldo no sistema: ${unitsText(target.quantity)}. Informe o que você contou de verdade.`}
            id={`${prefix}-physical`}
            inputMode="numeric"
            inputRef={registerRef("physicalQuantity")}
            label="Quantidade contada"
            maxLength={10}
            onChange={handlePhysical}
            value={draft.physicalQuantity}
          />
          {valuationApplies(target) ? (
            <TextField
              disabled={disabled}
              error={errors.valuationUnitCost}
              hint="Opcional. O custo desta variante é desconhecido; informe um custo unitário para estabelecê-lo (só vale com quantidade contada maior que zero)."
              id={`${prefix}-valuation`}
              inputMode="decimal"
              inputRef={registerRef("valuationUnitCost")}
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
          <TextField
            disabled={disabled}
            error={errors.quantity}
            hint={`Saldo atual: ${unitsText(target.quantity)}.`}
            id={`${prefix}-quantity`}
            inputMode="numeric"
            inputRef={registerRef("quantity")}
            label="Quantidade a baixar"
            maxLength={10}
            onChange={handleQuantity}
            value={draft.quantity}
          />
          <ReasonFields
            disabled={disabled}
            noteError={errors.reasonNote}
            onNoteChange={handleReasonNote}
            onReasonChange={handleReasonCode}
            prefix={prefix}
            reasonCode={draft.reasonCode}
            reasonError={errors.reasonCode}
            reasonNote={draft.reasonNote}
            registerRef={registerRef}
          />
        </>
      ) : null}
      <TextField
        disabled={disabled}
        error={errors.occurredOn}
        hint="Dia em que aconteceu, no calendário da organização."
        id={`${prefix}-date`}
        inputMode={undefined}
        inputRef={registerRef("occurredOn")}
        label="Data"
        maxLength={10}
        onChange={handleDate}
        type="date"
        value={draft.occurredOn}
      />
    </div>
  );
}

interface FailureNoticeProps {
  failure: StockFailure;
}

function FailureNotice({ failure }: FailureNoticeProps) {
  return (
    <div className="stock-message is-error" role="alert">
      <p>{failure.message}</p>
    </div>
  );
}

interface LockedNoticeProps {
  confirmingDiscard: boolean;
  failure: StockFailure;
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  onDiscardRequest: () => void;
}

function LockedNotice({
  confirmingDiscard,
  failure,
  onDiscardCancel,
  onDiscardConfirm,
  onDiscardRequest,
}: LockedNoticeProps) {
  return (
    <div className="stock-message is-error" role="alert">
      <p>{failure.message}</p>
      {confirmingDiscard ? (
        <>
          <p>
            <strong>Este movimento pode já ter sido registrado.</strong> Se você
            descartar e refizer, ele pode ficar duplicado. Descarte só depois de
            conferir o saldo e o histórico.
          </p>
          <div className="stock-actions-row">
            <button
              className="danger-button"
              onClick={onDiscardConfirm}
              type="button"
            >
              Sim, descartar e recomeçar
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
          Descartar esta tentativa
        </button>
      )}
    </div>
  );
}

interface ConfirmationProps {
  state: StockCommandState;
}

function Confirmation({ state }: ConfirmationProps) {
  const { body } = validateStockDraft(state.draft, state.target, state.today);
  if (body === null) {
    return null;
  }
  return (
    <>
      <dl className="stock-summary">
        {stockSummary(body, state.target).map((line) => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      <p className="stock-message is-warning">
        {stockConsequence(state.action)}
      </p>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

function useFieldRefs() {
  const refs = useRef(new Map<StockFieldName, HTMLElement>());
  const register = useCallback(
    (field: StockFieldName) => (element: HTMLElement | null) => {
      if (element) {
        refs.current.set(field, element);
      } else {
        refs.current.delete(field);
      }
    },
    []
  );
  const focus = useCallback((field: StockFieldName | null) => {
    if (field !== null) {
      refs.current.get(field)?.focus();
    }
  }, []);
  return { focus, register };
}

interface ActionsProps {
  confirming: boolean;
  label: string;
  locked: boolean;
  onBack: () => void;
  onClose: () => void;
  onConfirm: () => void;
  onReview: () => void;
  submitting: boolean;
  blocked: boolean;
  closable: boolean;
}

function Actions({
  blocked,
  closable,
  confirming,
  label,
  locked,
  onBack,
  onClose,
  onConfirm,
  onReview,
  submitting,
}: ActionsProps) {
  return (
    <div className="stock-actions-row">
      {confirming ? (
        <>
          <button
            className="primary-button"
            disabled={submitting}
            onClick={onConfirm}
            type="button"
          >
            {label}
          </button>
          {locked ? null : (
            <button className="quiet-button" onClick={onBack} type="button">
              Voltar
            </button>
          )}
        </>
      ) : (
        <button
          className="primary-button"
          disabled={blocked}
          onClick={onReview}
          type="button"
        >
          Revisar
        </button>
      )}
      {closable ? (
        <button className="quiet-button" onClick={onClose} type="button">
          {confirming ? "Cancelar" : "Fechar"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * One stock command on one variant, in two steps: fill in and review, then
 * confirm. An unknown outcome locks the attempt and a retry resends the same
 * command ID, so the server never records the movement twice.
 */
export function StockCommandPanel({
  action,
  onBalance,
  onClose,
  onReloadList,
  organizationId,
  target,
  today,
}: StockCommandPanelProps) {
  const [state, setState] = useState(() =>
    startStockCommand(action, target, today)
  );
  const inFlight = useRef<boolean>(false);
  const statusRef: RefObject<HTMLDivElement | null> = useRef(null);
  const panelRef: RefObject<HTMLElement | null> = useRef(null);
  const { focus, register } = useFieldRefs();
  const prefix = `stock-${target.variantId}-${action}`;
  const labels = STOCK_ACTION_LABELS[action];

  useEffect(() => {
    // Opening the panel moves focus into it: the first field, or the panel
    // itself when the action is blocked and no field can take focus.
    if (stockActionBlock(action, target) === null) {
      focus(STOCK_FIELD_ORDER[action][0] ?? null);
    } else {
      panelRef.current?.focus();
    }
  }, [action, focus, target]);

  useEffect(() => {
    if (state.submission.phase === "success") {
      statusRef.current?.focus();
    }
  }, [state.submission.phase]);

  const handleChange = useCallback((field: StockFieldName, value: string) => {
    setState((current) => editStockField(current, field, value));
  }, []);

  const handleReview = useCallback(() => {
    const next = reviewStock(state);
    setState(next);
    if (next.step !== "confirming") {
      const { issues } = validateStockDraft(
        next.draft,
        next.target,
        next.today
      );
      window.requestAnimationFrame(() =>
        focus(firstInvalidStockField(next.action, issues))
      );
    }
  }, [focus, state]);
  const handleBack = useCallback(
    () => setState((current) => backToStockEditing(current)),
    []
  );
  const handleDiscardRequest = useCallback(
    () => setState((current) => requestDiscardStock(current)),
    []
  );
  const handleDiscardCancel = useCallback(
    () => setState((current) => cancelDiscardStock(current)),
    []
  );
  const handleDiscardConfirm = useCallback(() => {
    const fresh = discardLockedStock(state);
    if (fresh !== null) {
      setState(fresh);
    }
  }, [state]);

  const refreshBalance = useCallback(async () => {
    try {
      const balance = await orpcClient.inventory.getBalance({
        organizationId,
        variantId: target.variantId,
      });
      setState((current) => retargetStock(current, balance));
      onBalance(balance, null);
    } catch {
      // The message already says to revise; the list keeps its last read.
    }
  }, [onBalance, organizationId, target.variantId]);

  const handleConfirm = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    const prepared = prepareStockSubmission({
      createId: newId,
      organizationId,
      state,
    });
    setState(prepared.state);
    if (!prepared.ok) {
      return;
    }
    inFlight.current = true;
    try {
      const { call } = prepared;
      let result: StockResult & { movement: { createdAt: string } };
      if (call.action === "receive") {
        result = await orpcClient.inventory.receiveStock(call.input);
      } else if (call.action === "count") {
        result = await orpcClient.inventory.inventoryCount(call.input);
      } else {
        result = await orpcClient.inventory.writeOffStock(call.input);
      }
      setState((current) => stockSucceeded(current, result));
      onBalance(
        result.balance,
        result.replayed ? null : result.movement.createdAt
      );
    } catch (error) {
      setState((current) => stockFailed(current, error));
      const failure = mapStockError(state.action, error);
      if (failure.refreshBalance) {
        refreshBalance().catch(() => undefined);
      }
      if (failure.reloadList) {
        onReloadList();
      }
    } finally {
      inFlight.current = false;
    }
  }, [onBalance, onReloadList, organizationId, refreshBalance, state]);
  const handleConfirmEvent = useCallback(() => {
    handleConfirm().catch(() => undefined);
  }, [handleConfirm]);
  const handleSubmitForm = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (state.step === "confirming" || state.submission.phase === "locked") {
        handleConfirmEvent();
      } else {
        handleReview();
      }
    },
    [handleConfirmEvent, handleReview, state.step, state.submission.phase]
  );

  const block = stockActionBlock(action, state.target);
  const issues = visibleStockIssues(state);
  const errors: Partial<Record<StockFieldName, string>> = {};
  for (const found of issues) {
    errors[found.field] ??= found.message;
  }
  const { submission } = state;
  const locked = submission.phase === "locked";
  const confirming = state.step === "confirming" || locked;
  const submitting = submission.phase === "submitting";

  if (submission.phase === "success") {
    return (
      <section aria-labelledby={`${prefix}-title`} className="stock-panel">
        <h3 id={`${prefix}-title`}>{labels.title}</h3>
        <div
          className="stock-message is-success"
          ref={statusRef}
          role="status"
          tabIndex={-1}
        >
          <p>{submission.message}</p>
          <p className="stock-hint">
            Saldo: {unitsText(submission.balance.quantity)} · custo médio:{" "}
            {costText(submission.balance.movingAverageCost)}
          </p>
        </div>
        <div className="stock-actions-row">
          <button className="primary-button" onClick={onClose} type="button">
            Fechar
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={`${prefix}-title`}
      className="stock-panel"
      ref={panelRef}
      tabIndex={-1}
    >
      <h3 id={`${prefix}-title`}>{labels.title}</h3>
      <p className="stock-hint">
        {state.target.productName} — {state.target.variantText}. Saldo atual:{" "}
        {unitsText(state.target.quantity)} · custo médio:{" "}
        {costText(state.target.movingAverageCost)}.
      </p>
      {state.target.archived ? (
        <p className="stock-message is-warning" role="note">
          Produto arquivado: o estoque ainda pode ser ajustado, mas ele não
          aparece para venda.
        </p>
      ) : null}
      {block ? (
        <p className="stock-message is-warning" role="note">
          {block}
        </p>
      ) : null}
      <form noValidate onSubmit={handleSubmitForm}>
        <fieldset
          className="stock-form"
          disabled={block !== null || locked || confirming || submitting}
        >
          <legend className="visually-hidden">{labels.title}</legend>
          <EditFields
            disabled={false}
            errors={errors}
            onChange={handleChange}
            prefix={prefix}
            registerRef={register}
            state={state}
          />
        </fieldset>
        {confirming ? <Confirmation state={state} /> : null}
        {submission.phase === "failed" ? (
          <FailureNotice failure={submission.failure} />
        ) : null}
        {submission.phase === "locked" ? (
          <LockedNotice
            confirmingDiscard={submission.confirmingDiscard}
            failure={submission.failure}
            onDiscardCancel={handleDiscardCancel}
            onDiscardConfirm={handleDiscardConfirm}
            onDiscardRequest={handleDiscardRequest}
          />
        ) : null}
        <Actions
          blocked={block !== null}
          closable={canCloseStock(state)}
          confirming={confirming}
          label={stockSubmitLabel(state)}
          locked={locked}
          onBack={handleBack}
          onClose={onClose}
          onConfirm={handleConfirmEvent}
          onReview={handleReview}
          submitting={submitting}
        />
      </form>
    </section>
  );
}
