import { useCallback, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
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
  /** Called when the sale changed on the server: reload it and show the notice. */
  onSaleChanged: (notice: SaleNotice) => void;
  organizationId: string;
  saleId: string;
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
  const sectionRef = useRef<HTMLElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const confirming = state.step === "confirming" || isCancelLocked(state);
  useStepFocus(confirming, noticeRef, sectionRef);

  const handleOpen = useCallback(
    () => setState((current) => openCancel(current)),
    []
  );
  const handleClose = useCallback(
    () => setState((current) => closeCancel(current)),
    []
  );
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
      <section aria-label="Cancelar venda">
        <Card className="gap-0 py-0">
          <CardContent className="grid justify-items-start gap-3 py-(--card-spacing)">
            <p className="text-muted-foreground text-support">
              {CANCELLATION_EXPLANATION}
            </p>
            <Button onClick={handleOpen} type="button" variant="outline">
              Cancelar venda
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }

  const locked = isCancelLocked(state);
  const errors = visibleCancelErrors(state);
  const { draft } = state;
  const submitting = state.submission.phase === "submitting";
  return (
    <section aria-labelledby="sale-cancel-title" ref={sectionRef}>
      <Card className="gap-0 py-0">
        <CardContent className="grid gap-4 py-(--card-spacing)">
          <div className="grid gap-1">
            <h2 className="text-section" id="sale-cancel-title">
              Cancelar venda
            </h2>
            <p className="text-muted-foreground text-support">
              {CANCELLATION_EXPLANATION}
            </p>
          </div>
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
            <Alert className="focus-ring" ref={noticeRef} tabIndex={-1}>
              <AlertTitle>Confirme o cancelamento</AlertTitle>
              <AlertDescription>
                A venda será marcada como cancelada
                {draft.reasonCode === ""
                  ? " sem motivo informado"
                  : ` (motivo: ${cancellationReasonLabel(draft.reasonCode)})`}
                , o estoque voltará item a item e isso não poderá ser desfeito.
              </AlertDescription>
            </Alert>
          ) : null}
          <OperationFailureNotice
            onDiscardCancel={handleDiscardCancel}
            onDiscardConfirm={handleDiscardConfirm}
            onDiscardRequest={handleDiscardRequest}
            submission={state.submission}
            warning="O cancelamento pode já ter sido registrado."
          />
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
            reviewLabel="Revisar cancelamento"
            submitting={submitting}
          />
        </CardContent>
      </Card>
    </section>
  );
}
