import { useCallback, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
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
  const sectionRef = useRef<HTMLElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const confirming = state.step === "confirming" || isReturnLocked(state);
  const focusFirstField = useStepFocus(confirming, noticeRef, sectionRef);

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
      <section aria-label="Devolução">
        <Card gap="none" pad="none">
          <CardContent className="grid justify-items-start gap-3 py-(--card-spacing)">
            <p className="text-muted-foreground text-support">
              {RETURN_EXPLANATION}
            </p>
            <Button onClick={handleOpen} type="button" variant="outline">
              Registrar devolução
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }

  const locked = isReturnLocked(state);
  const review = confirming ? returnReview(state) : null;
  const errors = visibleReturnErrors(state);
  return (
    <section aria-labelledby="sale-return-title" ref={sectionRef}>
      <Card gap="none" pad="none">
        <CardContent className="grid gap-4 py-(--card-spacing)">
          <div className="grid gap-1">
            <h2 className="text-section" id="sale-return-title">
              Registrar devolução
            </h2>
            <p className="text-muted-foreground text-support">
              {RETURN_EXPLANATION}
            </p>
          </div>
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
            <Alert className="focus-ring" ref={noticeRef} tabIndex={-1}>
              <AlertTitle>Confirme a devolução</AlertTitle>
              <AlertDescription className="grid gap-2" paragraphs="tight">
                <p>Motivo: {review.reasonText}.</p>
                <ul className="grid list-disc gap-0.5 pl-5">
                  {review.lines.map((line) => (
                    <li key={line.key}>{line.text}</li>
                  ))}
                </ul>
                <p>{review.totalsText}</p>
                <p>
                  O estoque volta apenas nas quantidades de “Volta ao estoque”,
                  pelo custo de cada item. A venda é preservada.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
          <OperationFailureNotice
            onDiscardCancel={handleDiscardCancel}
            onDiscardConfirm={handleDiscardConfirm}
            onDiscardRequest={handleDiscardRequest}
            submission={state.submission}
            warning="A devolução pode já ter sido registrada."
          />
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
        </CardContent>
      </Card>
    </section>
  );
}
