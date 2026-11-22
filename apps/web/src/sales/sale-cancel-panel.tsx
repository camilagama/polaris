import {
  type ComponentProps,
  type FormEvent,
  type Ref,
  useCallback,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { orpcClient } from "../lib/orpc";
import { useHoldSwap } from "../lib/unsent-work";
import { OperationFailureNotice } from "./operation-failure-notice";
import {
  backToCancelEditing,
  CANCELLATION_EXPLANATION,
  CANCELLATION_REASONS,
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
import { OperationActions } from "./sale-operation-actions";
import { ReasonFields } from "./sale-reason-fields";
import { useStepFocus } from "./use-step-focus";

const newId = () => crypto.randomUUID();

interface CancelPanelProps {
  finalFocus: ComponentProps<typeof DialogContent>["finalFocus"];
  /** Asks the screen to close the dialog (it never closes by itself, and not while an attempt is in flight). */
  onClose: () => void;
  /** Called when the sale changed on the server: reload it and show the notice. */
  onSaleChanged: (notice: SaleNotice) => void;
  open: boolean;
  organizationId: string;
  saleId: string;
  saleItemCount: number;
}

interface CancelReviewNoticeProps {
  noticeRef: Ref<HTMLDivElement>;
  reasonCode: string;
}

/** The effect of confirming, in a block set back into the card: muted fill, no border. */
export function CancelReviewNotice({
  noticeRef,
  reasonCode,
}: CancelReviewNoticeProps) {
  return (
    <Alert
      className="focus-ring border-0 bg-muted p-4"
      ref={noticeRef}
      tabIndex={-1}
    >
      <AlertTitle>Confirme o cancelamento</AlertTitle>
      <AlertDescription>
        A venda será marcada como cancelada
        {reasonCode === ""
          ? " sem motivo informado"
          : ` (motivo: ${cancellationReasonLabel(reasonCode)})`}
        , o estoque voltará item a item, exceto item de produto removido, e isso
        não poderá ser desfeito.
      </AlertDescription>
    </Alert>
  );
}

/** The form as it opens, on the reason. */
function openedCancel() {
  return openCancel(initialCancelState());
}

/**
 * Whole-sale cancellation in two steps, in a form dialog (the whole screen on a phone) that the screen opens from the
 * menu of the title. The sale is preserved; stock comes back item by item and the cancellation cannot be undone. The
 * draft is kept while the dialog fades and dropped once it has closed.
 */
export function SaleCancelPanel({
  finalFocus,
  onClose,
  onSaleChanged,
  open,
  organizationId,
  saleId,
  saleItemCount,
}: CancelPanelProps) {
  const [state, setState] = useState(openedCancel);
  useHoldSwap(isCancelDraftChanged(state));
  const inFlight = useRef<boolean>(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const confirming = state.step === "confirming" || isCancelLocked(state);
  const focusFirstField = useStepFocus(confirming, noticeRef, sectionRef);

  const handleClose = useCallback(() => {
    if (!isCancelLocked(state)) {
      onClose();
    }
  }, [onClose, state]);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        handleClose();
      }
    },
    [handleClose]
  );
  const handleClosed = useCallback((next: boolean) => {
    if (!next) {
      setState((current) =>
        closeCancel(current) === current ? current : openedCancel()
      );
    }
  }, []);
  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  }, []);
  const handleReasonChange = useCallback(
    (value: string) =>
      setState((current) =>
        editCancelReason(
          current,
          CANCELLATION_REASONS.find(([code]) => code === value)?.[0] ?? ""
        )
      ),
    []
  );
  const handleNoteChange = useCallback(
    (value: string) => setState((current) => editCancelNote(current, value)),
    []
  );
  const handleReview = useCallback(
    () => setState((current) => reviewCancel(current)),
    []
  );
  const handleBack = useCallback(() => {
    setState((current) => backToCancelEditing(current));
    focusFirstField();
  }, [focusFirstField]);
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
    setState(openedCancel());
    onClose();
    onSaleChanged({
      message: "Tentativa descartada. Conferimos o estado atual da venda.",
      ok: false,
    });
  }, [onClose, onSaleChanged, state]);

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
      setState(openedCancel());
      onClose();
      onSaleChanged({
        message: cancelSuccessMessage(result, saleItemCount),
        ok: true,
      });
    } catch (error) {
      setState((current) => cancelFailed(current, error));
      const failure = mapCancelError(error);
      if (failure.reloadDetail) {
        onSaleChanged({ message: failure.message, ok: false });
      }
    } finally {
      inFlight.current = false;
    }
  }, [onClose, onSaleChanged, organizationId, saleId, saleItemCount, state]);
  const handleConfirmEvent = useCallback(() => {
    handleConfirm().catch(() => undefined);
  }, [handleConfirm]);

  const locked = isCancelLocked(state);
  const errors = visibleCancelErrors(state);
  const { draft } = state;
  const submitting = state.submission.phase === "submitting";
  return (
    <Dialog
      disablePointerDismissal
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={handleClosed}
      open={open}
    >
      <DialogContent finalFocus={finalFocus} layout="form">
        <DialogForm onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Cancelar venda</DialogTitle>
            <DialogDescription>{CANCELLATION_EXPLANATION}</DialogDescription>
          </DialogHeader>
          <DialogBody ref={sectionRef}>
            <ReasonFields
              disabled={confirming}
              errors={errors}
              legend="Motivo do cancelamento (opcional)"
              noteCounter={noteCounterText(draft)}
              onNoteChange={handleNoteChange}
              onReasonChange={handleReasonChange}
              prefix="sale-cancel"
              reasonCode={draft.reasonCode}
              reasonNote={draft.reasonNote}
              reasons={CANCELLATION_REASONS}
            />
            {confirming ? (
              // the effect, in a neutral notice (auditoria v5.1, rule 2)
              <CancelReviewNotice
                noticeRef={noticeRef}
                reasonCode={draft.reasonCode}
              />
            ) : null}
            <OperationFailureNotice
              onDiscardCancel={handleDiscardCancel}
              onDiscardConfirm={handleDiscardConfirm}
              onDiscardRequest={handleDiscardRequest}
              submission={state.submission}
              warning="O cancelamento pode já ter sido registrado."
            />
          </DialogBody>
          <DialogFooter>
            <OperationActions
              closeLabel="Não cancelar"
              confirming={confirming}
              confirmLabel={cancelSubmitLabel(state)}
              destructive
              locked={locked}
              onBack={handleBack}
              onClose={handleClose}
              onConfirm={handleConfirmEvent}
              onReview={handleReview}
              retrying={state.submission.phase === "locked"}
              reviewLabel="Revisar cancelamento"
              submitting={submitting}
            />
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
