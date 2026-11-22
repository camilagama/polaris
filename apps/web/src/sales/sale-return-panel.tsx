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
import type { SaleNotice } from "./sale-cancellation-model";
import { OperationActions } from "./sale-operation-actions";
import { ReasonFields } from "./sale-reason-fields";
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
  type ReturnReview,
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
import { ReturnTable } from "./sale-return-table";
import { useStepFocus } from "./use-step-focus";

const newId = () => crypto.randomUUID();

interface ReturnReviewNoticeProps {
  noticeRef: Ref<HTMLDivElement>;
  review: ReturnReview;
}

export function ReturnReviewNotice({
  noticeRef,
  review,
}: ReturnReviewNoticeProps) {
  return (
    <Alert
      className="focus-ring border-0 bg-muted p-4"
      ref={noticeRef}
      tabIndex={-1}
    >
      <AlertTitle>Confirme a devolução</AlertTitle>
      <AlertDescription className="grid gap-2 [&_p:not(:last-child)]:mb-0">
        <p>Motivo: {review.reasonText}.</p>
        <ul className="grid list-disc gap-0.5 pl-5">
          {review.lines.map((line) => (
            <li key={line.key}>{line.text}</li>
          ))}
        </ul>
        <p>{review.totalsText}</p>
        <p>
          O estoque volta apenas nas quantidades de “Volta ao estoque”, pelo
          custo de cada item. A venda é preservada. Isso não poderá ser
          desfeito.
        </p>
      </AlertDescription>
    </Alert>
  );
}

interface ReturnPanelProps {
  finalFocus: ComponentProps<typeof DialogContent>["finalFocus"];
  /** Asks the screen to close the dialog (it never closes by itself, and not while an attempt is in flight). */
  onClose: () => void;
  onSaleChanged: (notice: SaleNotice) => void;
  open: boolean;
  organizationId: string;
  rows: readonly ReturnTableRow[];
  saleId: string;
}

/** The form as it opens: one blank line for each item that can still be returned. */
function openedReturn(rows: readonly ReturnTableRow[]) {
  return openReturn(initialReturnState(), rows);
}

/**
 * Partial return in two steps, in a form dialog (the whole screen on a phone) that the screen opens from the menu of
 * the title. The sale is preserved; stock returns only for the quantities marked "Volta ao estoque", and Polaris
 * processes no refund. The draft is kept while the dialog fades and dropped once it has closed.
 */
export function SaleReturnPanel({
  finalFocus,
  onClose,
  onSaleChanged,
  open,
  organizationId,
  rows,
  saleId,
}: ReturnPanelProps) {
  const [state, setState] = useState(() => openedReturn(rows));
  useHoldSwap(isReturnDraftChanged(state));
  const inFlight = useRef<boolean>(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const confirming = state.step === "confirming" || isReturnLocked(state);
  const focusFirstField = useStepFocus(confirming, noticeRef, sectionRef);

  const handleClose = useCallback(() => {
    if (!isReturnLocked(state)) {
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
  const handleClosed = useCallback(
    (next: boolean) => {
      if (!next) {
        setState((current) =>
          closeReturn(current) === current ? current : openedReturn(rows)
        );
      }
    },
    [rows]
  );
  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  }, []);
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
    (value: string) =>
      setState((current) =>
        editReturnReason(
          current,
          RETURN_REASONS.find(([code]) => code === value)?.[0] ?? ""
        )
      ),
    []
  );
  const handleNoteChange = useCallback(
    (value: string) => setState((current) => editReturnNote(current, value)),
    []
  );
  const handleReview = useCallback(
    () => setState((current) => reviewReturn(current)),
    []
  );
  const handleBack = useCallback(() => {
    setState((current) => backToReturnEditing(current));
    focusFirstField();
  }, [focusFirstField]);
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
    setState(openedReturn(rows));
    onClose();
    onSaleChanged({
      message: "Tentativa descartada. Conferimos o estado atual da venda.",
      ok: false,
    });
  }, [onClose, onSaleChanged, rows, state]);

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
      setState(openedReturn(rows));
      onClose();
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
  }, [onClose, onSaleChanged, organizationId, rows, saleId, state]);
  const handleConfirmEvent = useCallback(() => {
    handleConfirm().catch(() => undefined);
  }, [handleConfirm]);

  const locked = isReturnLocked(state);
  const review = confirming ? returnReview(state) : null;
  const errors = visibleReturnErrors(state);
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
            <DialogTitle>Registrar devolução</DialogTitle>
            <DialogDescription>{RETURN_EXPLANATION}</DialogDescription>
          </DialogHeader>
          <DialogBody ref={sectionRef}>
            <ReturnTable
              disabled={confirming}
              draft={state.draft}
              errors={errors}
              onRestocked={handleRestocked}
              onReturned={handleReturned}
              rows={rows}
            />
            <ReasonFields
              disabled={confirming}
              errors={errors}
              legend="Motivo da devolução (opcional)"
              noteCounter={returnNoteCounterText(state.draft)}
              onNoteChange={handleNoteChange}
              onReasonChange={handleReasonChange}
              prefix="sale-return"
              reasonCode={state.draft.reasonCode}
              reasonNote={state.draft.reasonNote}
              reasons={RETURN_REASONS}
            />
            {review ? (
              // the effect, in a neutral notice (auditoria v5.1, rule 2)
              <ReturnReviewNotice noticeRef={noticeRef} review={review} />
            ) : null}
            <OperationFailureNotice
              onDiscardCancel={handleDiscardCancel}
              onDiscardConfirm={handleDiscardConfirm}
              onDiscardRequest={handleDiscardRequest}
              submission={state.submission}
              warning="A devolução pode já ter sido registrada."
            />
          </DialogBody>
          <DialogFooter>
            <OperationActions
              closeLabel="Não devolver"
              confirming={confirming}
              confirmLabel={returnSubmitLabel(state)}
              destructive={false}
              locked={locked}
              onBack={handleBack}
              onClose={handleClose}
              onConfirm={handleConfirmEvent}
              onReview={handleReview}
              retrying={state.submission.phase === "locked"}
              reviewLabel="Revisar devolução"
              submitting={state.submission.phase === "submitting"}
            />
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
