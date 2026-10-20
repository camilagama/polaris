import { type ChangeEvent, useCallback, useRef, useState } from "react";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import "../catalog/categories-page.css";
import "./sale-page.css";
import "./sale-return-panel.css";
import { OperationFailureNotice } from "./operation-failure-notice";
import type { SaleNotice } from "./sale-cancellation-model";
import {
  backToReturnEditing,
  cancelDiscardReturn,
  closeReturn,
  discardLockedReturn,
  editRestocked,
  editReturned,
  editReturnNote,
  editReturnReason,
  initialReturnState,
  isReturnDraftChanged,
  isReturnLocked,
  mapReturnError,
  openReturn,
  prepareReturnSubmission,
  RETURN_EXPLANATION,
  RETURN_REASONS,
  type ReturnDraft,
  type ReturnDraftErrors,
  type ReturnLineDraft,
  type ReturnTableRow,
  requestDiscardReturn,
  returnFailed,
  returnNoteCounterText,
  returnReview,
  returnSubmitLabel,
  returnSuccessMessage,
  reviewReturn,
  visibleReturnErrors,
} from "./sale-return-model";

const newId = () => crypto.randomUUID();

interface ReturnRowProps {
  disabled: boolean;
  draft: ReturnLineDraft | undefined;
  errors: { restocked?: string; returned?: string } | undefined;
  onRestocked: (position: number, text: string) => void;
  onReturned: (position: number, text: string) => void;
  row: ReturnTableRow;
}

function ReturnRow({
  disabled,
  draft,
  errors,
  onRestocked,
  onReturned,
  row,
}: ReturnRowProps) {
  const handleReturned = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onReturned(row.position, event.target.value),
    [onReturned, row.position]
  );
  const handleRestocked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onRestocked(row.position, event.target.value),
    [onRestocked, row.position]
  );
  const prefix = `sale-return-${row.position}`;
  return (
    <tr>
      <th data-label="Item" scope="row">
        {row.label}
      </th>
      <td data-label="Vendido">{row.sold}</td>
      <td data-label="Já devolvido">{row.returned}</td>
      <td data-label="Já voltou ao estoque">{row.restocked}</td>
      <td data-label="Disponível">{row.available}</td>
      <td data-label="Devolvido">
        {draft ? (
          <>
            <input
              aria-describedby={
                errors?.returned ? `${prefix}-returned-error` : undefined
              }
              aria-invalid={errors?.returned ? true : undefined}
              aria-label={`Devolvido: ${row.label} (até ${row.available})`}
              disabled={disabled}
              id={`${prefix}-returned`}
              inputMode="numeric"
              maxLength={10}
              onChange={handleReturned}
              value={draft.returned}
            />
            {errors?.returned ? (
              <p
                className="sale-error"
                id={`${prefix}-returned-error`}
                role="alert"
              >
                {errors.returned}
              </p>
            ) : null}
          </>
        ) : (
          "—"
        )}
      </td>
      <td data-label="Volta ao estoque">
        {draft ? (
          <>
            <input
              aria-describedby={
                errors?.restocked ? `${prefix}-restocked-error` : undefined
              }
              aria-invalid={errors?.restocked ? true : undefined}
              aria-label={`Volta ao estoque: ${row.label}`}
              disabled={disabled}
              id={`${prefix}-restocked`}
              inputMode="numeric"
              maxLength={10}
              onChange={handleRestocked}
              value={draft.restocked}
            />
            {errors?.restocked ? (
              <p
                className="sale-error"
                id={`${prefix}-restocked-error`}
                role="alert"
              >
                {errors.restocked}
              </p>
            ) : null}
          </>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}

interface ReturnTableProps {
  disabled: boolean;
  draft: ReturnDraft;
  errors: ReturnDraftErrors;
  onRestocked: (position: number, text: string) => void;
  onReturned: (position: number, text: string) => void;
  rows: readonly ReturnTableRow[];
}

function ReturnTable({
  disabled,
  draft,
  errors,
  onRestocked,
  onReturned,
  rows,
}: ReturnTableProps) {
  return (
    <div className="sale-return-table-wrap">
      <table className="sale-return-table">
        <caption className="visually-hidden">
          Itens da venda e quantidades para devolver
        </caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Vendido</th>
            <th scope="col">Já devolvido</th>
            <th scope="col">Já voltou ao estoque</th>
            <th scope="col">Disponível</th>
            <th scope="col">Devolvido</th>
            <th scope="col">Volta ao estoque</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ReturnRow
              disabled={disabled}
              draft={draft.lines.find((line) => line.position === row.position)}
              errors={errors.lines[row.position]}
              key={row.position}
              onRestocked={onRestocked}
              onReturned={onReturned}
              row={row}
            />
          ))}
        </tbody>
      </table>
      {errors.items ? (
        <p className="sale-error" role="alert">
          {errors.items}
        </p>
      ) : null}
    </div>
  );
}

interface ReasonFieldsProps {
  disabled: boolean;
  draft: ReturnDraft;
  errors: ReturnDraftErrors;
  onNoteChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onReasonChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}

function ReasonFields({
  disabled,
  draft,
  errors,
  onNoteChange,
  onReasonChange,
}: ReasonFieldsProps) {
  return (
    <fieldset className="sale-cancel-fields" disabled={disabled}>
      <legend>Motivo da devolução (opcional)</legend>
      <div className="sale-field">
        <label htmlFor="sale-return-reason">Motivo</label>
        <select
          aria-describedby={
            errors.reason ? "sale-return-reason-error" : undefined
          }
          aria-invalid={errors.reason ? true : undefined}
          id="sale-return-reason"
          onChange={onReasonChange}
          value={draft.reasonCode}
        >
          <option value="">Sem motivo informado</option>
          {RETURN_REASONS.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        {errors.reason ? (
          <p className="sale-error" id="sale-return-reason-error" role="alert">
            {errors.reason}
          </p>
        ) : null}
      </div>
      {draft.reasonCode === "" ? null : (
        <div className="sale-field">
          <label htmlFor="sale-return-note">
            {draft.reasonCode === "other"
              ? "Observação (obrigatória para “Outro”)"
              : "Observação (opcional)"}
          </label>
          <textarea
            aria-describedby={
              errors.note ? "sale-return-note-error" : "sale-return-note-count"
            }
            aria-invalid={errors.note ? true : undefined}
            id="sale-return-note"
            onChange={onNoteChange}
            rows={3}
            value={draft.reasonNote}
          />
          <p className="sale-hint" id="sale-return-note-count">
            {returnNoteCounterText(draft)}
          </p>
          {errors.note ? (
            <p className="sale-error" id="sale-return-note-error" role="alert">
              {errors.note}
            </p>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}

interface ReturnPanelProps {
  onSaleChanged: (notice: SaleNotice) => void;
  organizationId: string;
  rows: readonly ReturnTableRow[];
  saleId: string;
}

/**
 * Partial return in two steps. The sale is preserved; stock returns only for
 * the quantities marked "Volta ao estoque", and Polaris processes no refund.
 */
export function SaleReturnPanel({
  onSaleChanged,
  organizationId,
  rows,
  saleId,
}: ReturnPanelProps) {
  const [state, setState] = useState(initialReturnState);
  useReportUnsentWork(isReturnDraftChanged(state));
  const inFlight = useRef<boolean>(false);

  const handleOpen = useCallback(
    () => setState((current) => openReturn(current, rows)),
    [rows]
  );
  const handleClose = useCallback(
    () => setState((current) => closeReturn(current)),
    []
  );
  const handleReturned = useCallback(
    (position: number, text: string) =>
      setState((current) => editReturned(current, position, text)),
    []
  );
  const handleRestocked = useCallback(
    (position: number, text: string) =>
      setState((current) => editRestocked(current, position, text)),
    []
  );
  const handleReasonChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.target;
      setState((current) =>
        editReturnReason(
          current,
          RETURN_REASONS.find(([code]) => code === value)?.[0] ?? ""
        )
      );
    },
    []
  );
  const handleNoteChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const { value } = event.target;
      setState((current) => editReturnNote(current, value));
    },
    []
  );
  const handleReview = useCallback(
    () => setState((current) => reviewReturn(current)),
    []
  );
  const handleBack = useCallback(
    () => setState((current) => backToReturnEditing(current)),
    []
  );
  const handleDiscardRequest = useCallback(
    () => setState((current) => requestDiscardReturn(current)),
    []
  );
  const handleDiscardCancel = useCallback(
    () => setState((current) => cancelDiscardReturn(current)),
    []
  );
  const handleDiscardConfirm = useCallback(() => {
    const discarded = discardLockedReturn(state);
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
    const prepared = prepareReturnSubmission({
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
      const result = await orpcClient.sale.return(prepared.request);
      setState(initialReturnState());
      onSaleChanged({ message: returnSuccessMessage(result), ok: true });
    } catch (error) {
      setState((current) => returnFailed(current, error));
      const failure = mapReturnError(error);
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
      <section aria-label="Devolução" className="sale-cancel">
        <p className="sale-hint">{RETURN_EXPLANATION}</p>
        <button className="quiet-button" onClick={handleOpen} type="button">
          Registrar devolução
        </button>
      </section>
    );
  }

  const locked = isReturnLocked(state);
  const confirming = state.step === "confirming" || locked;
  const review = confirming ? returnReview(state) : null;
  return (
    <section aria-labelledby="sale-return-title" className="sale-cancel">
      <h3 id="sale-return-title">Registrar devolução</h3>
      <p className="sale-hint">{RETURN_EXPLANATION}</p>
      <ReturnTable
        disabled={locked || confirming}
        draft={state.draft}
        errors={visibleReturnErrors(state)}
        onRestocked={handleRestocked}
        onReturned={handleReturned}
        rows={rows}
      />
      <ReasonFields
        disabled={locked || confirming}
        draft={state.draft}
        errors={visibleReturnErrors(state)}
        onNoteChange={handleNoteChange}
        onReasonChange={handleReasonChange}
      />
      {review ? (
        <div className="sale-message is-warning">
          <p>
            <strong>Confirme a devolução</strong> (motivo: {review.reasonText}
            ).
          </p>
          <ul>
            {review.lines.map((line) => (
              <li key={line.key}>{line.text}</li>
            ))}
          </ul>
          <p>{review.totalsText}</p>
          <p>
            O estoque volta apenas nas quantidades de “Volta ao estoque”, pelo
            custo de cada item. A venda é preservada.
          </p>
        </div>
      ) : null}
      <OperationFailureNotice
        onDiscardCancel={handleDiscardCancel}
        onDiscardConfirm={handleDiscardConfirm}
        onDiscardRequest={handleDiscardRequest}
        submission={state.submission}
        warning="A devolução pode já ter sido registrada."
      />
      <div className="sale-actions">
        {confirming ? (
          <>
            <button
              className="primary-button"
              disabled={state.submission.phase === "submitting"}
              onClick={handleConfirmEvent}
              type="button"
            >
              {returnSubmitLabel(state)}
            </button>
            {locked ? null : (
              <button
                className="quiet-button"
                onClick={handleBack}
                type="button"
              >
                Voltar
              </button>
            )}
          </>
        ) : (
          <>
            <button
              className="primary-button"
              onClick={handleReview}
              type="button"
            >
              Revisar devolução
            </button>
            <button
              className="quiet-button"
              onClick={handleClose}
              type="button"
            >
              Não devolver
            </button>
          </>
        )}
      </div>
    </section>
  );
}
