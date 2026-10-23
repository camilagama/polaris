import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
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
      <Alert variant="destructive">
        <AlertDescription>{submission.failure.message}</AlertDescription>
      </Alert>
    );
  }
  if (submission.phase !== "locked") {
    return null;
  }
  return (
    <Alert variant="destructive">
      <AlertDescription className="grid justify-items-start gap-3 [&_p:not(:last-child)]:mb-0">
        <p>{submission.failure.message}</p>
        {submission.confirmingDiscard ? (
          <>
            <p>
              <strong>{warning}</strong> Descartar esta tentativa não desfaz o
              que já tenha sido feito. Depois de descartar, recarregue a venda
              para conferir o estado.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                className="h-auto min-h-ctl-md whitespace-normal py-1.5"
                onClick={onDiscardConfirm}
                type="button"
                variant="destructive"
              >
                Sim, descartar esta tentativa
              </Button>
              <Button onClick={onDiscardCancel} type="button" variant="outline">
                Voltar
              </Button>
            </div>
          </>
        ) : (
          <Button onClick={onDiscardRequest} type="button" variant="outline">
            Descartar esta tentativa
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
