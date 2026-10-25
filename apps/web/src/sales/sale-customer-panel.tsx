import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
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
import { readWithRetry } from "../lib/read-with-retry";
import { useReportUnsentWork } from "../lib/unsent-work";
import {
  type ActionState,
  actionButtonLabels,
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

/** Associate or change: the main action of the panel, which opens the dialog that picks the customer. */
function ChooseButton({
  action,
  busy,
  onChoose,
}: {
  action: ActionState;
  busy: boolean;
  onChoose: () => void;
}) {
  return (
    <Button
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : onChoose}
      type="button"
    >
      {action.label}
    </Button>
  );
}

interface ChooseDialogProps {
  action: ActionState;
  /** What the dialog was opened for: it keeps its words while it fades after the sale got a customer. */
  asking: LinkAction;
  /** What the last attempt said, when it did not go through: said here, since the dialog covers the panel. */
  error: string | null;
  hintId: string;
  onCancel: () => void;
  onClosed: () => void;
  /** Esc and "Fechar": the dialog closes and the customer picked is kept for the next opening. */
  onDismiss: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  open: boolean;
  picker: ReactNode;
  submitting: boolean;
}

/**
 * The customer to associate, or to change to, in a form dialog (the whole screen on a phone): the picker and the one
 * button that sends it, off with its reason (`aria-disabled`) until a customer other than the current is chosen. Esc
 * and "Fechar" are "Cancelar" (nothing closes while it is sending).
 */
function ChooseDialog({
  action,
  asking,
  error,
  hintId,
  onCancel,
  onClosed,
  onDismiss,
  onSubmit,
  open,
  picker,
  submitting,
}: ChooseDialogProps) {
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!(next || submitting)) {
        onDismiss();
      }
    },
    [onDismiss, submitting]
  );
  const handleOpenChangeComplete = useCallback(
    (next: boolean) => {
      if (!next) {
        onClosed();
      }
    },
    [onClosed]
  );
  return (
    <Dialog
      disablePointerDismissal
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={handleOpenChangeComplete}
      open={open}
    >
      <DialogContent layout="form">
        <DialogForm onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{actionButtonLabels[asking]}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {picker}
            {!action.enabled && action.hint ? (
              <p className="text-muted-foreground text-support" id={hintId}>
                {action.hint}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              disabled={submitting}
              onClick={onCancel}
              type="button"
              variant="outline"
            >
              Cancelar
            </Button>
            <Button
              aria-describedby={
                !action.enabled && action.hint ? hintId : undefined
              }
              aria-disabled={!action.enabled || undefined}
              type="submit"
            >
              {submitting ? action.label : actionButtonLabels[asking]}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

interface RemoveButtonProps {
  action: ActionState;
  hintId: string;
  onAction: (action: LinkAction) => void;
}

/** Removing the customer is destructive: it asks first, in a dialog, whose confirm is the destructive button. */
function RemoveButton({ action, hintId, onAction }: RemoveButtonProps) {
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
        aria-describedby={!action.enabled && action.hint ? hintId : undefined}
        aria-disabled={!action.enabled || undefined}
        onClick={action.enabled ? handleAsk : undefined}
        type="button"
        variant="outline"
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
      placeholder="Escolha"
      value={selectedId}
    />
  );
}

function Frame({ children, framed }: { children: ReactNode; framed: boolean }) {
  return framed ? (
    <Card className="gap-0 py-0">
      <CardContent className="grid gap-4 py-(--card-spacing)">
        {children}
      </CardContent>
    </Card>
  ) : (
    <div className="grid gap-4">{children}</div>
  );
}

interface CustomerActionsProps {
  actions: ActionState[];
  hintId: string;
  /** Sends the action; true when the link was saved. */
  onAction: (action: LinkAction) => Promise<boolean>;
  onSelect: (customerId: string) => void;
  selectedId: string;
  status: ReturnType<typeof submissionView>;
  view: PickerView;
}

/**
 * What can be done with the customer of the sale: associate or change (a form dialog that picks the customer and sends
 * the choice) and remove (a question). A failure of the choice is said inside the dialog while it is open, and under
 * the buttons once it is closed. The customer picked and not linked is dropped once the dialog has closed, not while
 * it fades.
 */
function CustomerActions({
  actions,
  hintId,
  onAction,
  onSelect,
  selectedId,
  status,
  view,
}: CustomerActionsProps) {
  const [choosing, setChoosing] = useState(false);
  const [asking, setAsking] = useState<LinkAction>("assign");
  const chooseAction = actions.find((action) => action.action !== "unassign");
  const removeAction = actions.find((action) => action.action === "unassign");
  const submitting = status.kind === "submitting";

  const handleChoose = useCallback(() => {
    if (chooseAction) {
      setAsking(chooseAction.action);
    }
    setChoosing(true);
  }, [chooseAction]);
  // only "Cancelar" throws the customer picked away (once the dialog has closed); Esc and "Fechar" keep it
  const discard = useRef<boolean>(false);
  const handleCancel = useCallback(() => {
    discard.current = true;
    setChoosing(false);
  }, []);
  const handleDismiss = useCallback(() => setChoosing(false), []);
  const handleClosed = useCallback(() => {
    if (discard.current) {
      discard.current = false;
      onSelect("");
    }
  }, [onSelect]);
  const handleRemove = useCallback(
    (action: LinkAction) => {
      onAction(action).catch(() => undefined);
    },
    [onAction]
  );
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // off until a customer is picked: the button says why, and Enter on it sends nothing
      if (!chooseAction?.enabled) {
        return;
      }
      if (await onAction(chooseAction.action)) {
        setChoosing(false);
      }
    },
    [chooseAction, onAction]
  );

  return (
    <>
      <div className="flex flex-wrap gap-3">
        {chooseAction ? (
          <ChooseButton
            action={chooseAction}
            busy={submitting}
            onChoose={handleChoose}
          />
        ) : null}
        {removeAction ? (
          <RemoveButton
            action={removeAction}
            hintId={hintId}
            onAction={handleRemove}
          />
        ) : null}
      </div>
      {chooseAction ? (
        <ChooseDialog
          action={chooseAction}
          asking={asking}
          error={choosing && status.kind === "error" ? status.message : null}
          hintId={hintId}
          onCancel={handleCancel}
          onClosed={handleClosed}
          onDismiss={handleDismiss}
          onSubmit={handleSubmit}
          open={choosing}
          picker={
            <CustomerPicker
              disabled={submitting}
              onChange={onSelect}
              selectedId={selectedId}
              view={view}
            />
          }
          submitting={submitting}
        />
      ) : null}
      {status.kind === "error" && !choosing ? (
        <Alert variant="destructive">
          <AlertDescription>{status.message}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

interface SaleCustomerPanelProps {
  /** In its own card (the detail and the customer page); inside another card (the confirmed sale) it has none. */
  framed?: boolean;
  headingLevel: 2 | 3;
  organizationId: string;
  saleId: string;
}

/**
 * Attribution of one confirmed sale to a customer. It never changes the sale's
 * values: every change is a new version in a separate history.
 */
export function SaleCustomerPanel({
  framed = true,
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
      const link = await readWithRetry(
        () => orpcClient.sale.getCustomerLink({ organizationId, saleId }),
        { isCurrent: () => isLatestRequest(linkSequence.current, token) }
      );
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
      const result = await readWithRetry(
        () => orpcClient.customer.list({ organizationId, status: "all" }),
        { isCurrent: () => isLatestRequest(customersSequence.current, token) }
      );
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

  /** Sends the action; true when the link was saved (the dialog that asked closes only then). */
  const handleAction = useCallback(
    async (action: LinkAction): Promise<boolean> => {
      if (inFlight.current) {
        return false;
      }
      const result = buildLinkCommand(state, action, {
        organizationId,
        saleId,
      });
      if (!result.ok) {
        setState((current) => rejectLinkCommand(current, result.message));
        return false;
      }
      inFlight.current = true;
      setState((current) => beginLinkSubmission(current, action));
      try {
        const change = await sendCommand(result.command);
        nextRequestToken(linkSequence.current);
        setState((current) => linkSubmitted(current, action, change));
        return true;
      } catch (error) {
        const failure = mapLinkError(error);
        setState((current) => linkSubmitFailed(current, error));
        if (failure.reloadLink) {
          loadLink().catch(() => undefined);
        }
        if (failure.reloadCustomers) {
          loadCustomers().catch(() => undefined);
        }
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [loadCustomers, loadLink, organizationId, saleId, state]
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
  const ready = state.link.status === "ready";
  return (
    <section aria-labelledby="sale-customer-title">
      <Frame framed={framed}>
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
                <dt className="text-muted-foreground text-support">Situação</dt>
                <dd>{currentView.detail}</dd>
              </div>
            ) : null}
          </dl>
        )}
        {ready ? (
          <CustomerActions
            actions={actions}
            hintId={hintId}
            onAction={handleAction}
            onSelect={handleSelect}
            selectedId={state.selectedCustomerId}
            status={status}
            view={pickerView(state)}
          />
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
                  <span className="text-muted-foreground">{row.dateText}</span>
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
      </Frame>
    </section>
  );
}
