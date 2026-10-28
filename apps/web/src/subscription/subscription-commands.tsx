import type { BillingPlanView } from "@polaris/contracts";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import ExternalLinkIcon from "lucide-react/dist/esm/icons/external-link";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { CardContent } from "@/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/ui/field";
import { Textarea } from "@/ui/textarea";
import { orpcClient } from "../lib/orpc";
import {
  canCancelRenewal,
  cancelDialogText,
  cancelledGraceText,
  cancelHint,
  cancelledText,
  commandRefusal,
  FREE_CHANGES,
  keptText,
  type OwnerCommand,
  overdueText,
  REASON_HINT,
  REASON_MAX,
  reasonOf,
  refundDialogText,
  refundHint,
  refundRequestedText,
  safeOverduePaymentUrl,
  supportRefundText,
  unsafeOverdueRefusal,
} from "./subscription-commands-model";
import type { Refusal } from "./subscription-model";

/**
 * The owner's commands on the Assinatura (corte assinatura-e-cancelar, C and D, AC-42 to AC-44; design, § 11):
 * cancel the renewal, the refund of the right of withdrawal (by the app with the card, by support with Pix) and
 * paying the charge that failed. Each gesture has its request ID, kept while it is repeated and new for a new gesture
 * (ADR 0104, decision 3); the button waits off while the command is on its way.
 */

export type CommandDialog = "cancel" | "refund";

/**
 * What the last command did, said until the screen is left: the renewal cancelled, or the refund the provider took
 * (its confirmation comes by webhook); a refund not done is said by the plan's own notice (AS-42).
 */
export type CommandOutcome =
  | { kind: "cancelled"; text: string }
  | { amount: string; kind: "refund_requested" }
  | { kind: "refund_pending" };

/** The refund the provider took and whose fact has not come yet: the plan still reads it as not done. */
export function awaitsRefundFact(
  outcome: CommandOutcome | null,
  plan: BillingPlanView | null
): boolean {
  return outcome?.kind === "refund_requested" && plan?.refundPending === true;
}

const newRequestId = () => crypto.randomUUID();

/** One command of the owner: its pending flag, its refusal and the request ID of the gesture under way. */
function useOwnerCommand<T>(
  command: OwnerCommand,
  run: (requestId: string) => Promise<T>
) {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const requestId = useRef<string | null>(null);
  const inFlight = useRef<boolean>(false);
  /** A new gesture: the next call gets a new request ID. */
  const reset = useCallback(() => {
    requestId.current = null;
    setRefusal(null);
  }, []);
  /** An answer the screen will not use: said as a refusal, and the next try is a new gesture. */
  const refuse = useCallback((next: Refusal) => {
    requestId.current = null;
    setRefusal(next);
  }, []);
  const send = useCallback(async (): Promise<T | null> => {
    if (inFlight.current) {
      return null;
    }
    inFlight.current = true;
    requestId.current ??= newRequestId();
    setPending(true);
    setRefusal(null);
    try {
      const answer = await run(requestId.current);
      requestId.current = null;
      return answer;
    } catch (error) {
      const next = commandRefusal(command, error);
      if (next.reread) {
        // the plan is read again: what comes after is a new gesture
        requestId.current = null;
      }
      setRefusal(next);
      return null;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [command, run]);
  return { pending, refuse, refusal, reset, send };
}

/** What changes on the Free and what the store keeps: the same in both dialogs (AC-22 to AC-24). */
function WhatChanges({ plan }: { plan: BillingPlanView }) {
  return (
    <div className="grid gap-2 rounded-lg bg-muted/60 px-3 py-2.5">
      <h3 className="m-0 font-medium text-sm">O que muda no Free</h3>
      <ul className="m-0 grid list-disc gap-1 pl-5 text-muted-foreground">
        {FREE_CHANGES.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h3 className="m-0 font-medium text-sm">O que fica guardado</h3>
      <p className="m-0 text-muted-foreground">{keptText(plan)}</p>
    </div>
  );
}

function RefusalAlert({
  focusOnShow = false,
  onReread,
  refusal,
}: {
  /** In a dialog, the notice may be under the fold at 360 px: the focus takes it into view. */
  focusOnShow?: boolean;
  onReread: () => void;
  refusal: Refusal;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnShow) {
      ref.current?.focus();
    }
  }, [focusOnShow, refusal]);
  return (
    <Alert
      className="focus-ring"
      ref={ref}
      tabIndex={focusOnShow ? -1 : undefined}
      variant="destructive"
    >
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription className="grid justify-items-start gap-2">
        {refusal.text}
        {refusal.reread ? (
          <Button onClick={onReread} size="sm" type="button" variant="outline">
            Atualizar
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** Closing a dialog, except while its command is on its way: the answer decides what the screen shows. */
function useDialogExits(
  pending: boolean,
  onOpenChange: (open: boolean) => void
) {
  const guarded = useCallback(
    (next: boolean) => {
      if (!pending) {
        onOpenChange(next);
      }
    },
    [onOpenChange, pending]
  );
  const back = useCallback(() => onOpenChange(false), [onOpenChange]);
  return { back, guarded };
}

const DIALOG = "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md";
const OFF = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

interface CommandDialogProps {
  onOpenChange: (open: boolean) => void;
  onOutcome: (outcome: CommandOutcome) => void;
  onReread: () => void;
  open: boolean;
  organizationId: string;
  plan: BillingPlanView;
}

/** "Cancelar a renovação": one dialog with the true loss, what stays and the optional reason; no second step. */
function CancelRenewalDialog({
  onOpenChange,
  onOutcome,
  onReread,
  open,
  organizationId,
  plan,
}: CommandDialogProps) {
  const [reason, setReason] = useState("");
  const run = useCallback(
    (requestId: string) =>
      orpcClient.billing.cancelRenewal({
        organizationId,
        reason: reasonOf(reason),
        requestId,
      }),
    [organizationId, reason]
  );
  const { pending, refusal, reset, send } = useOwnerCommand("cancel", run);
  const { back, guarded } = useDialogExits(pending, onOpenChange);
  useEffect(() => {
    if (open) {
      reset();
      setReason("");
    }
  }, [open, reset]);
  const typeReason = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value),
    []
  );
  const confirm = useCallback(async () => {
    const answer = await send();
    if (answer !== null) {
      onOutcome({
        kind: "cancelled",
        text: cancelledText(answer.result, answer.accessEndsAt),
      });
      onOpenChange(false);
      onReread();
    }
  }, [onOpenChange, onOutcome, onReread, send]);
  const reread = useCallback(() => {
    onOpenChange(false);
    onReread();
  }, [onOpenChange, onReread]);
  const text = cancelDialogText(plan);
  return (
    <Dialog onOpenChange={guarded} open={open}>
      <DialogContent className={DIALOG} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        <WhatChanges plan={plan} />
        <Field>
          <FieldLabel htmlFor="subscription-cancel-reason">
            Por que está cancelando? (opcional)
          </FieldLabel>
          <Textarea
            aria-describedby="subscription-cancel-reason-hint"
            id="subscription-cancel-reason"
            maxLength={REASON_MAX}
            onChange={typeReason}
            readOnly={pending}
            placeholder="Ex.: ficou caro, não uso o catálogo…"
            value={reason}
          />
          <FieldDescription id="subscription-cancel-reason-hint">
            {REASON_HINT}
          </FieldDescription>
        </Field>
        {refusal ? (
          <RefusalAlert focusOnShow onReread={reread} refusal={refusal} />
        ) : null}
        <DialogFooter className="gap-3">
          <Button
            aria-disabled={pending || undefined}
            className={OFF}
            onClick={pending ? undefined : back}
            type="button"
            variant="outline"
          >
            Continuar no Pro
          </Button>
          <Button
            aria-disabled={pending || undefined}
            className={OFF}
            onClick={pending ? undefined : confirm}
            type="button"
          >
            {pending ? "Cancelando…" : text.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Desistir e receber o reembolso": the amount, that the Pro ends now and what stays (AC-34). */
function RefundDialog({
  amount,
  onOpenChange,
  onOutcome,
  onReread,
  open,
  organizationId,
  plan,
}: CommandDialogProps & { amount: string }) {
  const run = useCallback(
    (requestId: string) =>
      orpcClient.billing.requestRefund({ organizationId, requestId }),
    [organizationId]
  );
  const { pending, refusal, reset, send } = useOwnerCommand("refund", run);
  const { back, guarded } = useDialogExits(pending, onOpenChange);
  useEffect(() => {
    if (open) {
      reset();
    }
  }, [open, reset]);
  const confirm = useCallback(async () => {
    const answer = await send();
    if (answer !== null) {
      onOutcome(
        answer.result === "refund_requested"
          ? { amount: answer.amount, kind: "refund_requested" }
          : { kind: "refund_pending" }
      );
      onOpenChange(false);
      onReread();
    }
  }, [onOpenChange, onOutcome, onReread, send]);
  const reread = useCallback(() => {
    onOpenChange(false);
    onReread();
  }, [onOpenChange, onReread]);
  const text = refundDialogText(amount);
  return (
    <Dialog onOpenChange={guarded} open={open}>
      <DialogContent className={DIALOG} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        <WhatChanges plan={plan} />
        {refusal ? (
          <RefusalAlert focusOnShow onReread={reread} refusal={refusal} />
        ) : null}
        <DialogFooter className="gap-3">
          <Button
            aria-disabled={pending || undefined}
            className={OFF}
            onClick={pending ? undefined : back}
            type="button"
            variant="outline"
          >
            Continuar no Pro
          </Button>
          <Button
            aria-disabled={pending || undefined}
            className={OFF}
            onClick={pending ? undefined : confirm}
            type="button"
            variant="destructive"
          >
            {pending
              ? "Pedindo o reembolso…"
              : "Desistir e receber o reembolso"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Pagar a cobrança pendente" (AC-43), only when the server says the page exists: the page of the charge that failed,
 * opened apart with `noopener`, and the plan read again when the person comes back. The address is the payer's: kept
 * on this screen only, for the link that opens it again.
 */
function OverduePayment({
  onReread,
  organizationId,
  plan,
}: {
  onReread: () => void;
  organizationId: string;
  plan: BillingPlanView;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const run = useCallback(
    (requestId: string) =>
      orpcClient.billing.openOverduePayment({ organizationId, requestId }),
    [organizationId]
  );
  const { pending, refuse, refusal, send } = useOwnerCommand("overdue", run);
  const open = useCallback(async () => {
    const answer = await send();
    if (answer === null) {
      return;
    }
    const url = safeOverduePaymentUrl(answer.handoff.url);
    if (url === null) {
      refuse(unsafeOverdueRefusal());
      return;
    }
    setOpened(url);
    window.open(url, "_blank", "noopener,noreferrer");
  }, [refuse, send]);
  // back from the provider's page: the payment may have been made
  useEffect(() => {
    if (opened === null) {
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        onReread();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [onReread, opened]);
  return (
    <div className="grid justify-items-start gap-2 rounded-lg border px-3 py-2.5">
      <p className="m-0 text-muted-foreground">{overdueText(plan)}</p>
      <Button
        aria-disabled={pending || undefined}
        className={OFF}
        onClick={pending ? undefined : open}
        type="button"
      >
        <ExternalLinkIcon aria-hidden="true" />
        {pending ? "Abrindo…" : "Pagar a cobrança pendente"}
      </Button>
      {opened ? (
        <p className="m-0 text-muted-foreground text-support">
          A página de pagamento abriu em outra aba. Se não abriu,{" "}
          <a
            className="underline underline-offset-4"
            href={opened}
            rel="noopener noreferrer"
            target="_blank"
          >
            abra a página de pagamento
          </a>
          . Depois de pagar, volte aqui.
        </p>
      ) : null}
      {refusal ? <RefusalAlert onReread={onReread} refusal={refusal} /> : null}
    </div>
  );
}

function ActionRow({ children, hint }: { children: ReactNode; hint: string }) {
  return (
    <div className="flex flex-col items-start gap-x-3 gap-y-1.5 sm:flex-row sm:items-center">
      {children}
      <p className="m-0 text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * The actions under the plan: pay the charge that failed, cancel the renewal and the right of withdrawal, each only
 * where the plan says it holds; the dialogs are the screen's, so the notice of a refund not done may open one too.
 */
export function PlanActions({
  dialog,
  onDialog,
  onOutcome,
  onReread,
  organizationId,
  outcome,
  plan,
}: {
  dialog: CommandDialog | null;
  onDialog: (dialog: CommandDialog | null) => void;
  onOutcome: (outcome: CommandOutcome) => void;
  onReread: () => void;
  organizationId: string;
  outcome: CommandOutcome | null;
  plan: BillingPlanView;
}) {
  const { refund } = plan;
  // AS-43 asks for the server's page; a renewal already cancelled is not told to cancel it to change the card
  const overdue =
    plan.state === "grace" &&
    plan.recovery === "provider_page" &&
    !plan.renewalCancelled;
  const graceCancelled =
    plan.state === "grace" &&
    plan.recovery === "provider_page" &&
    plan.renewalCancelled;
  const cancel = canCancelRenewal(plan);
  const refundByApp = refund !== null && refund.via === "app";
  const showRefundButton = refundByApp && !plan.refundPending;
  const support = refund !== null && refund.via === "suporte";
  // the dialog of the refund stays while it is open, even if the window closes meanwhile: its answer is said there
  const lastAmount = useRef<string | null>(null);
  if (refundByApp) {
    lastAmount.current = refund.amount;
  }
  const refundAmount = lastAmount.current;
  const close = useCallback(
    (open: boolean) => {
      if (!open) {
        onDialog(null);
      }
    },
    [onDialog]
  );
  const askCancel = useCallback(() => onDialog("cancel"), [onDialog]);
  const askRefund = useCallback(() => onDialog("refund"), [onDialog]);
  const outcomeText = outcomeTextOf(outcome, plan);
  // the button that opened the dialog may be gone with the plan read again: the focus goes to what was done
  const outcomeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (outcome !== null) {
      outcomeRef.current?.focus();
    }
  }, [outcome]);
  if (
    !(
      outcomeText ||
      overdue ||
      graceCancelled ||
      cancel ||
      showRefundButton ||
      support ||
      dialog !== null
    )
  ) {
    return null;
  }
  return (
    <CardContent className="grid gap-3 border-t pt-(--card-spacing)">
      {outcomeText ? (
        <Alert className="focus-ring" ref={outcomeRef} tabIndex={-1}>
          <AlertDescription>{outcomeText}</AlertDescription>
        </Alert>
      ) : null}
      {overdue ? (
        <OverduePayment
          onReread={onReread}
          organizationId={organizationId}
          plan={plan}
        />
      ) : null}
      {graceCancelled ? (
        <p className="m-0 rounded-lg border px-3 py-2.5 text-muted-foreground">
          {cancelledGraceText()}
        </p>
      ) : null}
      {cancel ? (
        <ActionRow hint={cancelHint(plan)}>
          <Button onClick={askCancel} type="button" variant="outline">
            Cancelar a renovação
          </Button>
        </ActionRow>
      ) : null}
      {showRefundButton ? (
        <ActionRow hint={refundHint(refund)}>
          <Button onClick={askRefund} type="button" variant="destructive">
            Desistir e receber o reembolso
          </Button>
        </ActionRow>
      ) : null}
      {support ? (
        <p className="m-0 text-muted-foreground">
          {supportRefundText(refund, null)}
        </p>
      ) : null}
      <CancelRenewalDialog
        onOpenChange={close}
        onOutcome={onOutcome}
        onReread={onReread}
        open={dialog === "cancel" && cancel}
        organizationId={organizationId}
        plan={plan}
      />
      {refundAmount === null ? null : (
        <RefundDialog
          amount={refundAmount}
          onOpenChange={close}
          onOutcome={onOutcome}
          onReread={onReread}
          open={dialog === "refund"}
          organizationId={organizationId}
          plan={plan}
        />
      )}
    </CardContent>
  );
}

/** The line of what the last command did; none for a refund not done, which the plan's notice says (AS-42). */
function outcomeTextOf(
  outcome: CommandOutcome | null,
  plan: BillingPlanView
): string | null {
  switch (outcome?.kind) {
    case "cancelled":
      return outcome.text;
    case "refund_requested":
      return refundRequestedText(outcome.amount, plan);
    default:
      return null;
  }
}

/** "Tentar o reembolso de novo", inside the notice of the refund not done, while the app may still do it (AS-42). */
export function RefundRetry({
  onDialog,
  plan,
}: {
  onDialog: (dialog: CommandDialog) => void;
  plan: BillingPlanView;
}) {
  const retry = useCallback(() => onDialog("refund"), [onDialog]);
  const { refund } = plan;
  if (!plan.refundPending || refund === null || refund.via !== "app") {
    return null;
  }
  return (
    <Button onClick={retry} size="sm" type="button" variant="destructive">
      Tentar o reembolso de novo
    </Button>
  );
}
