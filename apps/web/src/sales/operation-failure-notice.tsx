import type { OperationSubmission } from "./sale-cancellation-model";

interface OperationFailureNoticeProps {
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  onDiscardRequest: () => void;
  submission: OperationSubmission;
  /** Bold warning, e.g. "O cancelamento pode já ter sido registrado." */
  warning: string;
}

/**
 * Shows a failed or locked operation and the actions allowed for it. A locked
 * operation may already be registered, so discarding needs a second step.
 */
export function OperationFailureNotice({
  onDiscardCancel,
  onDiscardConfirm,
  onDiscardRequest,
  submission,
  warning,
}: OperationFailureNoticeProps) {
  if (submission.phase === "failed") {
    return (
      <p className="sale-message is-error" role="alert">
        {submission.failure.message}
      </p>
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
            <strong>{warning}</strong> Descartar esta tentativa não desfaz o que
            já tenha sido feito. Depois de descartar, recarregue a venda para
            conferir o estado.
          </p>
          <div className="sale-actions">
            <button
              className="danger-button"
              onClick={onDiscardConfirm}
              type="button"
            >
              Sim, descartar esta tentativa
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
