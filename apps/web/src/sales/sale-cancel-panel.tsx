import { type ChangeEvent, useCallback, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import "../catalog/categories-page.css";
import "./sale-page.css";
import "./sale-cancel-panel.css";
import { OperationFailureNotice } from "./operation-failure-notice";
import {
  backToCancelEditing,
  CANCELLATION_EXPLANATION,
  CANCELLATION_REASONS,
  type CancelDraft,
  type CancelDraftErrors,
  cancelDiscardCancel,
  cancelFailed,
  cancellationReasonLabel,
  cancelSubmitLabel,
  cancelSuccessMessage,
  closeCancel,
  discardLockedCancel,
  editCancelNote,
  editCancelReason,
  initialCancelState,
  isCancelDraftChanged,
  isCancelLocked,
  mapCancelError,
  noteCounterText,
  openCancel,
  prepareCancelSubmission,
  requestDiscardCancel,
  reviewCancel,
  type SaleNotice,
  visibleCancelErrors,
} from "./sale-cancellation-model";

const newId = () => crypto.randomUUID();

interface CancelPanelProps {
  /** Called when the sale changed on the server: reload it and show the notice. */
  onSaleChanged: (notice: SaleNotice) => void;
  organizationId: string;
  saleId: string;
}

interface CancelFieldsProps {
  disabled: boolean;
  draft: CancelDraft;
  errors: CancelDraftErrors;
  onNoteChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onReasonChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}

function CancelFields({
  disabled,
  draft,
  errors,
  onNoteChange,
  onReasonChange,
}: CancelFieldsProps) {
  return (
    <fieldset className="sale-cancel-fields" disabled={disabled}>
      <legend>Motivo do cancelamento (opcional)</legend>
      <div className="sale-field">
        <label htmlFor="sale-cancel-reason">Motivo</label>
        <select
          aria-describedby={
            errors.reason ? "sale-cancel-reason-error" : undefined
          }
          aria-invalid={errors.reason ? true : undefined}
          id="sale-cancel-reason"
          onChange={onReasonChange}
          value={draft.reasonCode}
        >
          <option value="">Sem motivo informado</option>
          {CANCELLATION_REASONS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        {errors.reason ? (
          <p className="sale-error" id="sale-cancel-reason-error" role="alert">
            {errors.reason}
          </p>
        ) : null}
      </div>
      {draft.reasonCode === "" ? null : (
        <div className="sale-field">
          <label htmlFor="sale-cancel-note">
            {draft.reasonCode === "other"
              ? "Observação (obrigatória para “Outro”)"
              : "Observação (opcional)"}
          </label>
          <textarea
            aria-describedby={
              errors.note ? "sale-cancel-note-error" : "sale-cancel-note-count"
            }
            aria-invalid={errors.note ? true : undefined}
            id="sale-cancel-note"
            onChange={onNoteChange}
            rows={3}
            value={draft.reasonNote}
          />
          <p className="sale-hint" id="sale-cancel-note-count">
            {noteCounterText(draft)}
          </p>
          {errors.note ? (
            <p className="sale-error" id="sale-cancel-note-error" role="alert">
              {errors.note}
            </p>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}

interface CancelActionsProps {
  confirming: boolean;
  label: string;
  locked: boolean;
  onBack: () => void;
  onClose: () => void;
  onConfirm: () => void;
  onReview: () => void;
  submitting: boolean;
}

function CancelActions({
  confirming,
  label,
  locked,
  onBack,
  onClose,
  onConfirm,
  onReview,
  submitting,
}: CancelActionsProps) {
  return (
    <div className="sale-actions">
      {confirming ? (
        <>
          <button
            className="danger-button"
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
        <>
          <button className="primary-button" onClick={onReview} type="button">
            Revisar cancelamento
          </button>
          <button className="quiet-button" onClick={onClose} type="button">
            Não cancelar
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Whole-sale cancellation in two steps. The sale is preserved; stock comes
 * back item by item and the cancellation cannot be undone.
 */
export function SaleCancelPanel({
  onSaleChanged,
  organizationId,
  saleId,
}: CancelPanelProps) {
  const [state, setState] = useState(initialCancelState);
  useReportUnsentWork(isCancelDraftChanged(state));
  const inFlight = useRef<boolean>(false);

  const handleOpen = useCallback(
    () => setState((current) => openCancel(current)),
    []
  );
  const handleClose = useCallback(
    () => setState((current) => closeCancel(current)),
    []
  );
  const handleReasonChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.target;
      setState((current) =>
        editCancelReason(
          current,
          CANCELLATION_REASONS.find(([code]) => code === value)?.[0] ?? ""
        )
      );
    },
    []
  );
  const handleNoteChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const { value } = event.target;
      setState((current) => editCancelNote(current, value));
    },
    []
  );
  const handleReview = useCallback(
    () => setState((current) => reviewCancel(current)),
    []
  );
  const handleBack = useCallback(
    () => setState((current) => backToCancelEditing(current)),
    []
  );
  const handleDiscardRequest = useCallback(
    () => setState((current) => requestDiscardCancel(current)),
    []
  );
  const handleDiscardCancel = useCallback(
    () => setState((current) => cancelDiscardCancel(current)),
    []
  );
  const handleDiscardConfirm = useCallback(() => {
    const discarded = discardLockedCancel(state);
    if (discarded === null) {
      return;
    }
    setState(discarded);
    onSaleChanged({
      message: "Tentativa descartada. Conferimos o estado atual da venda.",
      ok: false,
    });
  }, [onSaleChanged, state]);

  const handleConfirm = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    const prepared = prepareCancelSubmission({
      createId: newId,
      organizationId,
      saleId,
      state,
    });
    setState(prepared.state);
    if (!prepared.ok) {
      return;
    }
    inFlight.current = true;
    try {
      const result = await orpcClient.sale.cancel(prepared.request);
      setState(initialCancelState());
      onSaleChanged({ message: cancelSuccessMessage(result), ok: true });
    } catch (error) {
      setState((current) => cancelFailed(current, error));
      const failure = mapCancelError(error);
      if (failure.reloadDetail) {
        onSaleChanged({ message: failure.message, ok: false });
      }
    } finally {
      inFlight.current = false;
    }
  }, [onSaleChanged, organizationId, saleId, state]);
  const handleConfirmEvent = useCallback(() => {
    handleConfirm().catch(() => undefined);
  }, [handleConfirm]);

  if (state.step === "closed" && state.submission.phase === "idle") {
    return (
      <section aria-label="Cancelar venda" className="sale-cancel">
        <p className="sale-hint">{CANCELLATION_EXPLANATION}</p>
        <button
          className="quiet-button sale-danger"
          onClick={handleOpen}
          type="button"
        >
          Cancelar venda
        </button>
      </section>
    );
  }

  const locked = isCancelLocked(state);
  const confirming = state.step === "confirming" || locked;
  const errors = visibleCancelErrors(state);
  const { draft } = state;
  const submitting = state.submission.phase === "submitting";
  return (
    <section aria-labelledby="sale-cancel-title" className="sale-cancel">
      <h3 id="sale-cancel-title">Cancelar venda</h3>
      <p className="sale-hint">{CANCELLATION_EXPLANATION}</p>
      <CancelFields
        disabled={locked || confirming}
        draft={draft}
        errors={errors}
        onNoteChange={handleNoteChange}
        onReasonChange={handleReasonChange}
      />
      {state.step === "confirming" || locked ? (
        <p className="sale-message is-warning">
          Confirme: a venda será marcada como cancelada
          {draft.reasonCode === ""
            ? " sem motivo informado"
            : ` (motivo: ${cancellationReasonLabel(draft.reasonCode)})`}
          , o estoque voltará item a item e isso não poderá ser desfeito.
        </p>
      ) : null}
      <OperationFailureNotice
        onDiscardCancel={handleDiscardCancel}
        onDiscardConfirm={handleDiscardConfirm}
        onDiscardRequest={handleDiscardRequest}
        submission={state.submission}
        warning="O cancelamento pode já ter sido registrado."
      />
      <CancelActions
        confirming={confirming}
        label={cancelSubmitLabel(state)}
        locked={locked}
        onBack={handleBack}
        onClose={handleClose}
        onConfirm={handleConfirmEvent}
        onReview={handleReview}
        submitting={submitting}
      />
    </section>
  );
}
