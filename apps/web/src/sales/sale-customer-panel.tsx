import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import {
  type ComponentProps,
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
import { TextLink } from "@/ui/text-link";
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
import { useHoldSwap } from "../lib/unsent-work";
import {
  type ActionState,
  actionButtonLabels,
  availableActions,
  beginLinkSubmission,
  buildLinkCommand,
  currentCustomerId,
  currentCustomerLoaded,
  currentCustomerLoadFailed,
  currentCustomerLoading,
  currentCustomerView,
  customersLoaded,
  customersLoadFailed,
  customersLoading,
  historyNeedsCustomerList,
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
import { CurrentCustomerSummary } from "./customer-summary";
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
  finalFocus: DialogFinalFocus | undefined;
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
  finalFocus,
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
      <DialogContent finalFocus={finalFocus} layout="form">
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
  onAsk: () => void;
}

/** Removing the customer is destructive: the button only asks; the question is `RemoveDialog`. */
function RemoveButton({ action, hintId, onAsk }: RemoveButtonProps) {
  return (
    <Button
      aria-describedby={!action.enabled && action.hint ? hintId : undefined}
      aria-disabled={!action.enabled || undefined}
      onClick={action.enabled ? onAsk : undefined}
      type="button"
      variant="outline"
    >
      {action.label}
    </Button>
  );
}

interface RemoveDialogProps {
  finalFocus: DialogFinalFocus | undefined;
  onCancel: () => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

/** The question that comes before removing: its confirm is the destructive button. */
function RemoveDialog({
  finalFocus,
  onCancel,
  onConfirm,
  onOpenChange,
  open,
}: RemoveDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent finalFocus={finalFocus} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Remover o cliente desta venda?</DialogTitle>
          <DialogDescription>
            A venda fica sem cliente. Os valores da venda não mudam e a remoção
            fica no histórico de atribuição.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-3">
          <Button onClick={onCancel} type="button" variant="outline">
            Cancelar
          </Button>
          <Button onClick={onConfirm} type="button" variant="destructive">
            Sim, remover cliente
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
        <TextLink inline className="text-foreground" href={view.href}>
          Abrir clientes
        </TextLink>
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

interface LinkDataInput {
  onSaved: ((message: string) => void) | undefined;
  organizationId: string;
  saleId: string;
}

/** Reads the link of the sale, the customers and the current customer, and sends the three commands. */
function useLinkData({ onSaved, organizationId, saleId }: LinkDataInput) {
  const [state, setState] = useState(initialLinkPanelState);
  // a customer picked and not linked yet (it is cleared when the link is saved)
  useHoldSwap(state.selectedCustomerId !== "");
  const inFlight = useRef<boolean>(false);
  const linkSequence = useRef<RequestSequence>({ current: 0 });
  const customersSequence = useRef<RequestSequence>({ current: 0 });
  const currentCustomerSequence = useRef<RequestSequence>({ current: 0 });

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

  const loadCurrentCustomer = useCallback(
    async (customerId: string) => {
      const token = nextRequestToken(currentCustomerSequence.current);
      setState((current) => currentCustomerLoading(current, customerId));
      try {
        const customer = await readWithRetry(
          () => orpcClient.customer.get({ id: customerId, organizationId }),
          {
            isCurrent: () =>
              isLatestRequest(currentCustomerSequence.current, token),
          }
        );
        if (isLatestRequest(currentCustomerSequence.current, token)) {
          setState((current) => currentCustomerLoaded(current, customer));
        }
      } catch (error) {
        if (isLatestRequest(currentCustomerSequence.current, token)) {
          setState((current) =>
            currentCustomerLoadFailed(current, customerId, error)
          );
        }
      }
    },
    [organizationId]
  );

  useEffect(() => {
    loadLink().catch(() => undefined);
  }, [loadLink]);

  const linkedCustomerId = currentCustomerId(state);
  useEffect(() => {
    if (linkedCustomerId !== null) {
      loadCurrentCustomer(linkedCustomerId).catch(() => undefined);
    }
  }, [linkedCustomerId, loadCurrentCustomer]);

  const needsCustomerList =
    historyNeedsCustomerList(state) && state.customers.status === "idle";
  useEffect(() => {
    if (needsCustomerList) {
      loadCustomers().catch(() => undefined);
    }
  }, [needsCustomerList, loadCustomers]);

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
        const saved = submissionView(linkSubmitted(state, action, change));
        if (saved.message !== null) {
          onSaved?.(saved.message);
        }
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
    [loadCustomers, loadLink, onSaved, organizationId, saleId, state]
  );
  const handleSelect = useCallback(
    (customerId: string) =>
      setState((current) => selectCustomer(current, customerId)),
    []
  );
  const handleRetryName = useCallback(() => {
    if (linkedCustomerId !== null) {
      loadCurrentCustomer(linkedCustomerId).catch(() => undefined);
    }
  }, [linkedCustomerId, loadCurrentCustomer]);

  const handleRefresh = useCallback(() => {
    loadLink().catch(() => undefined);
    if (linkedCustomerId !== null) {
      loadCurrentCustomer(linkedCustomerId).catch(() => undefined);
    }
  }, [linkedCustomerId, loadCurrentCustomer, loadLink]);

  return {
    handleAction,
    handleRefresh,
    handleRetry: loadLink,
    handleRetryName,
    handleSelect,
    linkedCustomerId,
    loadCustomers,
    state,
  };
}

/**
 * The customer of one sale and what can be done with it: the data (`useLinkData`) and the two dialogs that act on it,
 * the choice (associate or change: a form dialog that picks the customer and sends it) and the question that comes
 * before removing. Whoever draws the buttons, a card or a menu, calls `openChoice` and `askRemove`. The customer picked
 * and not linked is dropped once the dialog has closed, not while it fades.
 */
export function useSaleCustomerLink(input: {
  /** Called with the sentence of the result once the link was saved. */
  onSaved?: (message: string) => void;
  organizationId: string;
  saleId: string;
}) {
  const data = useLinkData({
    onSaved: input.onSaved,
    organizationId: input.organizationId,
    saleId: input.saleId,
  });
  const {
    handleAction,
    handleRefresh,
    handleRetry,
    handleRetryName,
    handleSelect,
    linkedCustomerId,
    loadCustomers,
    state,
  } = data;
  const [choosing, setChoosing] = useState(false);
  const [asking, setAsking] = useState<LinkAction>("assign");
  const [removing, setRemoving] = useState(false);
  const nameLine = useRef<HTMLElement | null>(null);
  const hintId = useId();
  const actions = availableActions(state);
  const chooseAction = actions.find((action) => action.action !== "unassign");
  const removeAction = actions.find((action) => action.action === "unassign");
  const status = submissionView(state);

  const openChoice = useCallback(() => {
    if (chooseAction) {
      setAsking(chooseAction.action);
    }
    setChoosing(true);
    loadCustomers().catch(() => undefined);
  }, [chooseAction, loadCustomers]);
  // only "Cancelar" throws the customer picked away (once the dialog has closed); Esc and "Fechar" keep it
  const discard = useRef<boolean>(false);
  const cancelChoice = useCallback(() => {
    discard.current = true;
    setChoosing(false);
  }, []);
  const dismissChoice = useCallback(() => setChoosing(false), []);
  const choiceClosed = useCallback(() => {
    if (discard.current) {
      discard.current = false;
      handleSelect("");
    }
  }, [handleSelect]);
  const submitChoice = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // off until a customer is picked: the button says why, and Enter on it sends nothing
      if (!chooseAction?.enabled) {
        return;
      }
      if (await handleAction(chooseAction.action)) {
        setChoosing(false);
      }
    },
    [chooseAction, handleAction]
  );
  const askRemove = useCallback(() => setRemoving(true), []);
  const cancelRemove = useCallback(() => setRemoving(false), []);
  const confirmRemove = useCallback(() => {
    setRemoving(false);
    handleAction("unassign").catch(() => undefined);
  }, [handleAction]);
  const retryName = useCallback(() => {
    nameLine.current?.focus();
    handleRetryName();
  }, [handleRetryName]);

  return {
    askRemove,
    asking,
    cancelChoice,
    cancelRemove,
    choiceClosed,
    chooseAction,
    choosing,
    confirmRemove,
    currentView: currentCustomerView(state),
    dismissChoice,
    handleRefresh,
    handleRetry,
    handleSelect,
    hintId,
    history: historyRows(state),
    linkedCustomerId,
    nameLine,
    openChoice,
    picker: pickerView(state),
    ready: state.link.status === "ready",
    removeAction,
    removing,
    retryName,
    setRemoving,
    state,
    status,
    submitChoice,
  };
}

export type SaleCustomerLink = ReturnType<typeof useSaleCustomerLink>;

type DialogFinalFocus = ComponentProps<typeof DialogContent>["finalFocus"];

/** What the last attempt said, when it did not go through and no dialog is open to say it. */
export function CustomerSaveError({ link }: { link: SaleCustomerLink }) {
  if (link.status.kind !== "error" || link.choosing) {
    return null;
  }
  return (
    <Alert variant="destructive">
      <AlertDescription>{link.status.message}</AlertDescription>
    </Alert>
  );
}

/** The two dialogs of the customer, which open from the buttons of the card or from the items of the menu. */
export function CustomerDialogs({
  finalFocus,
  link,
}: {
  finalFocus?: DialogFinalFocus;
  link: SaleCustomerLink;
}) {
  const submitting = link.status.kind === "submitting";
  return (
    <>
      {link.chooseAction ? (
        <ChooseDialog
          action={link.chooseAction}
          asking={link.asking}
          error={
            link.choosing && link.status.kind === "error"
              ? link.status.message
              : null
          }
          finalFocus={finalFocus}
          hintId={link.hintId}
          onCancel={link.cancelChoice}
          onClosed={link.choiceClosed}
          onDismiss={link.dismissChoice}
          onSubmit={link.submitChoice}
          open={link.choosing}
          picker={
            <CustomerPicker
              disabled={submitting}
              onChange={link.handleSelect}
              selectedId={link.state.selectedCustomerId}
              view={link.picker}
            />
          }
          submitting={submitting}
        />
      ) : null}
      <RemoveDialog
        finalFocus={finalFocus}
        onCancel={link.cancelRemove}
        onConfirm={link.confirmRemove}
        onOpenChange={link.setRemoving}
        open={link.removing}
      />
    </>
  );
}

/** The buttons of the card: associate or change, and remove. */
function CustomerButtons({ link }: { link: SaleCustomerLink }) {
  return (
    <div className="flex flex-wrap gap-3">
      {link.chooseAction ? (
        <ChooseButton
          action={link.chooseAction}
          busy={link.status.kind === "submitting"}
          onChoose={link.openChoice}
        />
      ) : null}
      {link.removeAction ? (
        <RemoveButton
          action={link.removeAction}
          hintId={link.hintId}
          onAsk={link.askRemove}
        />
      ) : null}
    </div>
  );
}

/** The versions of the attribution of the sale, newest last, as the card shows them. */
export function CustomerHistory({
  level,
  link,
}: {
  level: 2 | 3 | 4;
  link: SaleCustomerLink;
}) {
  const SubHeading = `h${level}` as const;
  if (link.history.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-2">
      <SubHeading className={level === 2 ? "text-section" : "font-medium"}>
        Histórico de atribuição
      </SubHeading>
      <ol className="grid gap-2">
        {link.history.map((row) => (
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
  const link = useSaleCustomerLink({ organizationId, saleId });
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const { currentView, status } = link;
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
                onClick={link.handleRetry}
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
              <dd
                className={
                  currentView.kind === "customer-error"
                    ? "focus-ring flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm text-destructive"
                    : "focus-ring rounded-sm font-medium [overflow-wrap:anywhere]"
                }
                ref={link.nameLine}
                tabIndex={-1}
              >
                <span role="status">{currentView.label}</span>
                {currentView.kind === "customer-error" ? (
                  <Button
                    onClick={link.retryName}
                    size="sm"
                    type="button"
                    variant="link"
                  >
                    <RefreshCwIcon
                      aria-hidden="true"
                      data-icon="inline-start"
                    />
                    Tentar novamente
                  </Button>
                ) : null}
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
        <CurrentCustomerSummary
          customerId={link.linkedCustomerId}
          load={link.state.currentCustomer}
        />
        {link.ready ? (
          <>
            <CustomerButtons link={link} />
            <CustomerDialogs link={link} />
            <CustomerSaveError link={link} />
          </>
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
        <CustomerHistory level={headingLevel === 2 ? 3 : 4} link={link} />
        {link.ready && link.history.length === 0 ? (
          <p className="text-muted-foreground text-support">
            Ainda não há histórico: esta venda nunca teve cliente associado.
          </p>
        ) : null}
      </Frame>
    </section>
  );
}
