import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import {
  type ActionState,
  availableActions,
  beginLinkSubmission,
  buildLinkCommand,
  currentCustomerView,
  customersLoaded,
  customersLoadFailed,
  customersLoading,
  historyRows,
  initialLinkPanelState,
  isLatestRequest,
  type LinkAction,
  type LinkCommand,
  linkLoaded,
  linkLoadFailed,
  linkLoading,
  linkSubmitFailed,
  linkSubmitted,
  mapLinkError,
  nextRequestToken,
  type PickerView,
  pickerView,
  type RequestSequence,
  rejectLinkCommand,
  type SaleCustomerLinkChange,
  selectCustomer,
  submissionView,
  VALUES_UNCHANGED_NOTE,
} from "./sale-customer-link-model";
import { SelectField } from "./sale-fields";

function sendCommand(command: LinkCommand): Promise<SaleCustomerLinkChange> {
  switch (command.action) {
    case "assign":
      return orpcClient.sale.assignCustomer(command.input);
    case "reassign":
      return orpcClient.sale.reassignCustomer(command.input);
    default:
      return orpcClient.sale.unassignCustomer(command.input);
  }
}

/* aria-disabled, not disabled: the button stays reachable and reads why it is off (decision of 21/10) */
const OFF = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

interface ActionButtonProps {
  action: ActionState;
  hintId: string;
  onAction: (action: LinkAction) => void;
}

/** Associate or change: the main action of the panel. */
function ActionButton({ action, hintId, onAction }: ActionButtonProps) {
  const handleClick = useCallback(
    () => onAction(action.action),
    [action.action, onAction]
  );
  return (
    <Button
      aria-describedby={!action.enabled && action.hint ? hintId : undefined}
      aria-disabled={!action.enabled || undefined}
      className={OFF}
      onClick={action.enabled ? handleClick : undefined}
      type="button"
    >
      {action.label}
    </Button>
  );
}

interface RemoveButtonProps {
  action: ActionState;
  onAction: (action: LinkAction) => void;
}

/** Removing the customer is destructive: it asks first, in a dialog. */
function RemoveButton({ action, onAction }: RemoveButtonProps) {
  const [asking, setAsking] = useState(false);
  const handleAsk = useCallback(() => setAsking(true), []);
  const handleOpenChange = useCallback((open: boolean) => setAsking(open), []);
  const handleCancel = useCallback(() => setAsking(false), []);
  const handleConfirm = useCallback(() => {
    setAsking(false);
    onAction(action.action);
  }, [action.action, onAction]);
  return (
    <>
      <Button
        aria-disabled={!action.enabled || undefined}
        className={OFF}
        onClick={action.enabled ? handleAsk : undefined}
        type="button"
        variant="destructive"
      >
        {action.label}
      </Button>
      <Dialog onOpenChange={handleOpenChange} open={asking}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remover o cliente desta venda?</DialogTitle>
            <DialogDescription>
              A venda fica sem cliente. Os valores da venda não mudam e a
              remoção fica no histórico de atribuição.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3">
            <Button onClick={handleCancel} type="button" variant="outline">
              Cancelar
            </Button>
            <Button onClick={handleConfirm} type="button" variant="destructive">
              Sim, remover cliente
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface PickerProps {
  disabled: boolean;
  onChange: (customerId: string) => void;
  selectedId: string;
  view: PickerView;
}

function CustomerPicker({ disabled, onChange, selectedId, view }: PickerProps) {
  if (view.kind === "loading") {
    return (
      <p className="text-muted-foreground" role="status">
        {view.message}
      </p>
    );
  }
  if (view.kind === "error") {
    return (
      <Alert variant="destructive">
        <AlertDescription>{view.message}</AlertDescription>
      </Alert>
    );
  }
  if (view.kind === "empty") {
    return (
      <p className="text-muted-foreground">
        {view.message}{" "}
        <a
          className="focus-ring rounded-sm text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground"
          href={view.href}
        >
          Abrir clientes
        </a>
      </p>
    );
  }
  return (
    <SelectField
      disabled={disabled}
      id="sale-customer-select"
      label="Cliente"
      onChange={onChange}
      options={view.options}
      placeholder="Escolha um cliente ativo"
      value={selectedId}
    />
  );
}

interface SaleCustomerPanelProps {
  headingLevel: 2 | 3;
  organizationId: string;
  saleId: string;
}

/**
 * Attribution of one confirmed sale to a customer. It never changes the sale's
 * values: every change is a new version in a separate history.
 */
export function SaleCustomerPanel({
  headingLevel,
  organizationId,
  saleId,
}: SaleCustomerPanelProps) {
  const [state, setState] = useState(initialLinkPanelState);
  // a customer picked and not linked yet (it is cleared when the link is saved)
  useReportUnsentWork(state.selectedCustomerId !== "");
  const inFlight = useRef<boolean>(false);
  const linkSequence = useRef<RequestSequence>({ current: 0 });
  const customersSequence = useRef<RequestSequence>({ current: 0 });

  const loadLink = useCallback(async () => {
    const token = nextRequestToken(linkSequence.current);
    setState(linkLoading);
    try {
      const link = await orpcClient.sale.getCustomerLink({
        organizationId,
        saleId,
      });
      if (isLatestRequest(linkSequence.current, token)) {
        setState((current) => linkLoaded(current, link));
      }
    } catch (error) {
      if (isLatestRequest(linkSequence.current, token)) {
        setState((current) => linkLoadFailed(current, error));
      }
    }
  }, [organizationId, saleId]);

  const loadCustomers = useCallback(async () => {
    const token = nextRequestToken(customersSequence.current);
    setState(customersLoading);
    try {
      const result = await orpcClient.customer.list({
        organizationId,
        status: "all",
      });
      if (isLatestRequest(customersSequence.current, token)) {
        setState((current) => customersLoaded(current, result.customers));
      }
    } catch (error) {
      if (isLatestRequest(customersSequence.current, token)) {
        setState((current) => customersLoadFailed(current, error));
      }
    }
  }, [organizationId]);

  useEffect(() => {
    loadLink().catch(() => undefined);
    loadCustomers().catch(() => undefined);
  }, [loadCustomers, loadLink]);

  const handleAction = useCallback(
    async (action: LinkAction) => {
      if (inFlight.current) {
        return;
      }
      const result = buildLinkCommand(state, action, {
        organizationId,
        saleId,
      });
      if (!result.ok) {
        setState((current) => rejectLinkCommand(current, result.message));
        return;
      }
      inFlight.current = true;
      setState((current) => beginLinkSubmission(current, action));
      try {
        const change = await sendCommand(result.command);
        nextRequestToken(linkSequence.current);
        setState((current) => linkSubmitted(current, action, change));
      } catch (error) {
        const failure = mapLinkError(error);
        setState((current) => linkSubmitFailed(current, error));
        if (failure.reloadLink) {
          loadLink().catch(() => undefined);
        }
        if (failure.reloadCustomers) {
          loadCustomers().catch(() => undefined);
        }
      } finally {
        inFlight.current = false;
      }
    },
    [loadCustomers, loadLink, organizationId, saleId, state]
  );
  const handleActionEvent = useCallback(
    (action: LinkAction) => {
      handleAction(action).catch(() => undefined);
    },
    [handleAction]
  );
  const handleSelect = useCallback(
    (customerId: string) =>
      setState((current) => selectCustomer(current, customerId)),
    []
  );
  const handleRetry = useCallback(() => {
    loadLink().catch(() => undefined);
    loadCustomers().catch(() => undefined);
  }, [loadCustomers, loadLink]);

  const hintId = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const SubHeading = headingLevel === 2 ? "h3" : "h4";
  const currentView = currentCustomerView(state);
  const actions = availableActions(state);
  const status = submissionView(state);
  const history = historyRows(state);
  const disabledHint = actions.find((action) => !action.enabled && action.hint);
  const ready = state.link.status === "ready";
  return (
    <section aria-labelledby="sale-customer-title">
      <Card className="gap-0 py-0">
        <CardContent className="grid gap-4 py-(--card-spacing)">
          <div className="grid gap-1">
            <Heading className="text-section" id="sale-customer-title">
              Cliente da venda
            </Heading>
            <p className="text-muted-foreground text-support">
              {VALUES_UNCHANGED_NOTE}
            </p>
          </div>
          {currentView.kind === "error" ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {currentView.label}
                <Button
                  onClick={handleRetry}
                  size="sm"
                  type="button"
                  variant="link"
                >
                  <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                  Tentar novamente
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <dl className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-0.5">
                <dt className="text-muted-foreground text-support">
                  Cliente atual
                </dt>
                <dd className="font-medium [overflow-wrap:anywhere]">
                  {currentView.label}
                </dd>
              </div>
              {currentView.detail ? (
                <div className="grid gap-0.5">
                  <dt className="text-muted-foreground text-support">
                    Situação
                  </dt>
                  <dd>{currentView.detail}</dd>
                </div>
              ) : null}
            </dl>
          )}
          {ready ? (
            <div className="grid gap-3">
              <CustomerPicker
                disabled={status.kind === "submitting"}
                onChange={handleSelect}
                selectedId={state.selectedCustomerId}
                view={pickerView(state)}
              />
              <div className="flex flex-wrap gap-3">
                {actions.map((action) =>
                  action.action === "unassign" ? (
                    <RemoveButton
                      action={action}
                      key={action.action}
                      onAction={handleActionEvent}
                    />
                  ) : (
                    <ActionButton
                      action={action}
                      hintId={hintId}
                      key={action.action}
                      onAction={handleActionEvent}
                    />
                  )
                )}
              </div>
              {disabledHint ? (
                <p className="text-muted-foreground text-support" id={hintId}>
                  {disabledHint.hint}
                </p>
              ) : null}
            </div>
          ) : null}
          <div aria-live="polite" role="status">
            {status.kind === "success" || status.kind === "submitting" ? (
              <p
                className={
                  status.kind === "success"
                    ? "font-medium"
                    : "text-muted-foreground"
                }
              >
                {status.message}
              </p>
            ) : null}
          </div>
          {status.kind === "error" ? (
            <Alert variant="destructive">
              <AlertDescription>{status.message}</AlertDescription>
            </Alert>
          ) : null}
          {history.length > 0 ? (
            <div className="grid gap-2">
              <SubHeading className="font-medium">
                Histórico de atribuição
              </SubHeading>
              <ol className="grid gap-2">
                {history.map((row) => (
                  <li
                    className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 border-border border-t pt-2 text-support [overflow-wrap:anywhere] first:border-t-0 first:pt-0"
                    key={row.key}
                  >
                    <span>
                      v{row.version} · {row.text}
                    </span>
                    <span className="text-muted-foreground">
                      {row.dateText}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {ready && history.length === 0 ? (
            <p className="text-muted-foreground text-support">
              Ainda não há histórico: esta venda nunca teve cliente associado.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
