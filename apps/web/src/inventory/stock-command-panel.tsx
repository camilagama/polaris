import type { InventoryBalanceReadModel } from "@polaris/contracts";
import CheckIcon from "lucide-react/dist/esm/icons/check";
import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { FieldLegend, FieldSet } from "@/ui/field";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import type { LocalWorkspace } from "../offline/runtime/use-local-workspace";
import { queueOfflineStock } from "./queue-offline-stock";
import {
  backToStockEditing,
  canCloseStock,
  cancelDiscardStock,
  discardLockedStock,
  editStockField,
  firstInvalidStockField,
  isStockDraftChanged,
  mapStockError,
  prepareStockSubmission,
  requestDiscardStock,
  retargetStock,
  reviewStock,
  STOCK_ACTION_LABELS,
  STOCK_FIELD_ORDER,
  type StockAction,
  type StockCall,
  type StockFailure,
  type StockFieldName,
  type StockResult,
  startStockCommand,
  stockActionBlock,
  stockFailed,
  stockFieldRefusal,
  stockQueueFailed,
  stockSubmitLabel,
  stockSucceeded,
  validateStockDraft,
  visibleStockIssues,
} from "./stock-command-model";
import {
  Confirmation,
  EditFields,
  FailureNotice,
  LockedNotice,
  stockFieldId,
} from "./stock-panel-fields";
import {
  costText,
  type StockTarget,
  targetCostText,
  unitsText,
} from "./stock-target";

const newId = () => crypto.randomUUID();

interface StockCommandPanelProps {
  action: StockAction;
  /** Without a connection: the movement is kept on this device instead of sent. */
  local?: LocalWorkspace | undefined;
  organizationId: string;
  /** The panel was closed; the page restores focus to the row's button. */
  onClose: () => void;
  /** The server answered with a newer balance for this variant. */
  onBalance: (
    balance: InventoryBalanceReadModel,
    updatedAt: string | null
  ) => void;
  /** The variant or its product changed under the screen. */
  onReloadList: () => void;
  target: StockTarget;
  today: string;
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

interface ActionsProps {
  /** The id of the notice that says why the action is blocked. */
  blockId: string;
  confirming: boolean;
  label: string;
  locked: boolean;
  onBack: () => void;
  onClose: () => void;
  onConfirm: () => void;
  onReview: () => void;
  submitting: boolean;
  blocked: boolean;
  closable: boolean;
}

function Actions({
  blocked,
  blockId,
  closable,
  confirming,
  label,
  locked,
  onBack,
  onClose,
  onConfirm,
  onReview,
  submitting,
}: ActionsProps) {
  return (
    <div className="flex flex-wrap gap-3">
      {confirming ? (
        <>
          <Button disabled={submitting} onClick={onConfirm} type="button">
            {label}
          </Button>
          {locked ? null : (
            <Button onClick={onBack} type="button" variant="outline">
              Voltar
            </Button>
          )}
        </>
      ) : (
        // aria-disabled, not disabled: the button stays reachable and reads why it is off (the notice above the form)
        <Button
          aria-describedby={blocked ? blockId : undefined}
          aria-disabled={blocked || undefined}
          onClick={blocked ? undefined : onReview}
          type="button"
        >
          Revisar
        </Button>
      )}
      {closable ? (
        <Button onClick={onClose} type="button" variant="ghost">
          {confirming ? "Cancelar" : "Fechar"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One stock command on one variant, in two steps: fill in and review, then
 * confirm. An unknown outcome locks the attempt and a retry resends the same
 * command ID, so the server never records the movement twice.
 */
export function StockCommandPanel({
  action,
  local,
  onBalance,
  onClose,
  onReloadList,
  organizationId,
  target,
  today,
}: StockCommandPanelProps) {
  const [state, setState] = useState(() =>
    startStockCommand(action, target, today)
  );
  useReportUnsentWork(isStockDraftChanged(state));
  const inFlight = useRef<boolean>(false);
  const statusRef: RefObject<HTMLDivElement | null> = useRef(null);
  const panelRef: RefObject<HTMLElement | null> = useRef(null);
  const prefix = `stock-${target.variantId}-${action}`;
  const focus = useCallback(
    (field: StockFieldName | null) => {
      if (field !== null) {
        document.getElementById(stockFieldId(prefix, field))?.focus();
      }
    },
    [prefix]
  );
  const labels = STOCK_ACTION_LABELS[action];

  useEffect(() => {
    // Opening the panel moves focus into it: the first field, or the panel
    // itself when the action is blocked and no field can take focus.
    if (stockActionBlock(action, target) === null) {
      focus(STOCK_FIELD_ORDER[action][0] ?? null);
    } else {
      panelRef.current?.focus();
    }
  }, [action, focus, target]);

  useEffect(() => {
    if (state.submission.phase === "success") {
      statusRef.current?.focus();
    }
  }, [state.submission.phase]);

  const handleChange = useCallback((field: StockFieldName, value: string) => {
    setState((current) => editStockField(current, field, value));
  }, []);

  const handleReview = useCallback(() => {
    const next = reviewStock(state);
    setState(next);
    if (next.step !== "confirming") {
      const { issues } = validateStockDraft(
        next.draft,
        next.target,
        next.today
      );
      focusLater(() => focus(firstInvalidStockField(next.action, issues)));
    }
  }, [focus, state]);
  const handleBack = useCallback(
    () => setState((current) => backToStockEditing(current)),
    []
  );
  const handleDiscardRequest = useCallback(
    () => setState((current) => requestDiscardStock(current)),
    []
  );
  const handleDiscardCancel = useCallback(
    () => setState((current) => cancelDiscardStock(current)),
    []
  );
  const handleDiscardConfirm = useCallback(() => {
    const fresh = discardLockedStock(state);
    if (fresh !== null) {
      setState(fresh);
    }
  }, [state]);

  const refreshBalance = useCallback(async () => {
    try {
      const balance = await orpcClient.inventory.getBalance({
        organizationId,
        variantId: target.variantId,
      });
      setState((current) => retargetStock(current, balance));
      onBalance(balance, null);
    } catch {
      // The field keeps saying to revise, without a number; the list keeps its last read.
    }
  }, [onBalance, organizationId, target.variantId]);

  /** Keeps the movement on this device; nothing is sent, so a failure here is definite. */
  const confirmOnDevice = useCallback(
    async (call: StockCall) => {
      const stores = local?.runtime.context() ?? null;
      try {
        if (!(local && stores)) {
          throw new Error("offline_runtime_unavailable");
        }
        const queued = await queueOfflineStock({ call, stores });
        setState((current) => stockSucceeded(current, queued, true));
        local.runtime.localDataChanged();
        local.runtime.refreshCounts().catch(() => undefined);
        // sends it now when the connection came back since the render
        local.runtime.syncNow().catch(() => undefined);
      } catch (error) {
        setState((current) => stockQueueFailed(current, error));
        if (
          error instanceof Error &&
          error.name === "InsufficientLocalStockError"
        ) {
          focusLater(() => focus("quantity"));
        }
      }
    },
    [focus, local]
  );

  const afterFailure = useCallback(
    (failure: StockFailure) => {
      if (failure.field !== null) {
        const { field } = failure;
        focusLater(() => focus(field));
      }
      if (failure.refreshBalance) {
        refreshBalance().catch(() => undefined);
      }
      if (failure.reloadList) {
        onReloadList();
      }
    },
    [focus, onReloadList, refreshBalance]
  );

  const handleConfirm = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    const prepared = prepareStockSubmission({
      createId: newId,
      organizationId,
      state,
    });
    setState(prepared.state);
    if (!prepared.ok) {
      return;
    }
    inFlight.current = true;
    try {
      const { call } = prepared;
      // An attempt locked on the server (outcome unknown) is retried there, as it
      // was sent: sending it to the device with another payload could record the
      // movement twice.
      if (local && state.submission.phase !== "locked") {
        await confirmOnDevice(call);
        return;
      }
      let result: StockResult & { movement: { createdAt: string } };
      if (call.action === "receive") {
        result = await orpcClient.inventory.receiveStock(call.input);
      } else if (call.action === "count") {
        result = await orpcClient.inventory.inventoryCount(call.input);
      } else {
        result = await orpcClient.inventory.writeOffStock(call.input);
      }
      setState((current) => stockSucceeded(current, result));
      onBalance(
        result.balance,
        result.replayed ? null : result.movement.createdAt
      );
    } catch (error) {
      setState((current) => stockFailed(current, error));
      afterFailure(mapStockError(state.action, error));
    } finally {
      inFlight.current = false;
    }
  }, [afterFailure, confirmOnDevice, local, onBalance, organizationId, state]);
  const handleConfirmEvent = useCallback(() => {
    handleConfirm().catch(() => undefined);
  }, [handleConfirm]);
  const handleSubmitForm = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (state.step === "confirming" || state.submission.phase === "locked") {
        handleConfirmEvent();
      } else {
        handleReview();
      }
    },
    [handleConfirmEvent, handleReview, state.step, state.submission.phase]
  );

  const block = stockActionBlock(action, state.target);
  const issues = visibleStockIssues(state);
  const errors: Partial<Record<StockFieldName, string>> = {};
  // one message per field: a refusal that belongs to a field replaces the local check there
  const refusal = stockFieldRefusal(state);
  if (refusal !== null) {
    errors[refusal.field] = refusal.message;
  }
  for (const found of issues) {
    errors[found.field] ??= found.message;
  }
  const { submission } = state;
  const locked = submission.phase === "locked";
  const confirming = state.step === "confirming" || locked;
  const submitting = submission.phase === "submitting";
  const blocked = block !== null;
  useEffect(() => {
    // The balance read after a refusal can leave nothing to act on: the field turns off, so focus moves to the panel.
    if (blocked) {
      panelRef.current?.focus();
    }
  }, [blocked]);

  if (submission.phase === "success") {
    return (
      <section
        aria-labelledby={`${prefix}-title`}
        className="grid gap-3 rounded-lg border bg-card p-3 md:p-4"
      >
        <div
          className="focus-ring grid gap-1 rounded-sm"
          ref={statusRef}
          role="status"
          tabIndex={-1}
        >
          <h3
            className="flex items-center gap-2 text-section"
            id={`${prefix}-title`}
          >
            <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
            {labels.title}
          </h3>
          <p>{submission.message}</p>
          {submission.queued ? null : (
            <p className="text-muted-foreground text-support">
              Saldo: {unitsText(submission.balance.quantity)} · custo médio:{" "}
              {costText(submission.balance.movingAverageCost)}
            </p>
          )}
        </div>
        <div>
          <Button onClick={onClose} type="button">
            Fechar
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={`${prefix}-title`}
      className="focus-ring grid gap-3 rounded-lg border bg-card p-3 md:p-4"
      ref={panelRef}
      tabIndex={-1}
    >
      <div className="grid gap-0.5">
        <h3 className="text-section" id={`${prefix}-title`}>
          {labels.title}
        </h3>
        <p className="text-muted-foreground text-support">
          {state.target.productName} — {state.target.variantText}. Saldo atual:{" "}
          {unitsText(state.target.quantity)} · custo médio:{" "}
          {targetCostText(state.target)}.
        </p>
      </div>
      {state.target.archived ? (
        <Alert role="note" variant="warning">
          <AlertDescription>
            Produto arquivado: o estoque ainda pode ser ajustado, mas ele não
            aparece para venda.
          </AlertDescription>
        </Alert>
      ) : null}
      {block ? (
        <Alert id={`${prefix}-block`} role="note" variant="warning">
          <AlertDescription>{block}</AlertDescription>
        </Alert>
      ) : null}
      <form className="grid gap-4" noValidate onSubmit={handleSubmitForm}>
        <FieldSet
          disabled={block !== null || locked || confirming || submitting}
        >
          <FieldLegend className="sr-only">{labels.title}</FieldLegend>
          <EditFields
            disabled={block !== null || locked || confirming || submitting}
            errors={errors}
            onChange={handleChange}
            prefix={prefix}
            state={state}
          />
        </FieldSet>
        {confirming ? <Confirmation state={state} /> : null}
        {submission.phase === "failed" && submission.failure.field === null ? (
          <FailureNotice failure={submission.failure} />
        ) : null}
        {submission.phase === "locked" ? (
          <LockedNotice
            confirmingDiscard={submission.confirmingDiscard}
            failure={submission.failure}
            onDiscardCancel={handleDiscardCancel}
            onDiscardConfirm={handleDiscardConfirm}
            onDiscardRequest={handleDiscardRequest}
          />
        ) : null}
        <Actions
          blockId={`${prefix}-block`}
          blocked={block !== null}
          closable={canCloseStock(state)}
          confirming={confirming}
          label={stockSubmitLabel(state)}
          locked={locked}
          onBack={handleBack}
          onClose={onClose}
          onConfirm={handleConfirmEvent}
          onReview={handleReview}
          submitting={submitting}
        />
      </form>
    </section>
  );
}
