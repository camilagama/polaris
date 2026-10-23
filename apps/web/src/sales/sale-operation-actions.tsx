import { Button } from "@/ui/button";

interface OperationActionsProps {
  closeLabel: string;
  /** The last step: the review, or the locked attempt. */
  confirming: boolean;
  confirmLabel: string;
  /**
   * Cancelling is destructive; registering a return is the main action. A locked attempt only resends the same
   * command (safe), so its confirm is the main action too: the destructive one is "discard", in the notice.
   */
  destructive: boolean;
  locked: boolean;
  onBack: () => void;
  onClose: () => void;
  onConfirm: () => void;
  onReview: () => void;
  reviewLabel: string;
  submitting: boolean;
}

/**
 * The buttons of a cancellation or of a return: review and close while editing; confirm and back on the last
 * step. A destructive button exists only on that last step (auditoria v5.1, rule 1).
 */
export function OperationActions({
  closeLabel,
  confirmLabel,
  confirming,
  destructive,
  locked,
  onBack,
  onClose,
  onConfirm,
  onReview,
  reviewLabel,
  submitting,
}: OperationActionsProps) {
  return (
    <div className="flex flex-wrap gap-3">
      {confirming ? (
        <>
          <Button
            disabled={submitting}
            onClick={onConfirm}
            type="button"
            variant={destructive && !locked ? "destructive" : "default"}
          >
            {confirmLabel}
          </Button>
          {locked ? null : (
            <Button onClick={onBack} type="button" variant="outline">
              Voltar
            </Button>
          )}
        </>
      ) : (
        <>
          <Button onClick={onReview} type="button">
            {reviewLabel}
          </Button>
          <Button onClick={onClose} type="button" variant="ghost">
            {closeLabel}
          </Button>
        </>
      )}
    </div>
  );
}
