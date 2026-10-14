import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { orpcClient } from "../lib/orpc";
import "../catalog/categories-page.css";
import "./sale-page.css";
import "./sale-customer-panel.css";
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

interface ActionButtonProps {
  action: ActionState;
  onAction: (action: LinkAction) => void;
}

function ActionButton({ action, onAction }: ActionButtonProps) {
  const handleClick = useCallback(
    () => onAction(action.action),
    [action.action, onAction]
  );
  return (
    <button
      className={
        action.action === "unassign" ? "quiet-button" : "primary-button"
      }
      disabled={!action.enabled}
      onClick={handleClick}
      type="button"
    >
      {action.label}
    </button>
  );
}

interface PickerProps {
  disabled: boolean;
  onChange: (customerId: string) => void;
  selectedId: string;
  view: PickerView;
}

function CustomerPicker({ disabled, onChange, selectedId, view }: PickerProps) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
    [onChange]
  );
  if (view.kind === "loading") {
    return (
      <p className="sale-status" role="status">
        {view.message}
      </p>
    );
  }
  if (view.kind === "error") {
    return (
      <p className="sale-message is-error" role="alert">
        {view.message}
      </p>
    );
  }
  if (view.kind === "empty") {
    return (
      <p className="sale-empty">
        {view.message} <a href={view.href}>Abrir clientes</a>
      </p>
    );
  }
  return (
    <div className="sale-field">
      <label htmlFor="sale-customer-select">Cliente</label>
      <select
        disabled={disabled}
        id="sale-customer-select"
        onChange={handleChange}
        value={selectedId}
      >
        <option value="">Escolha um cliente ativo</option>
        {view.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
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

  const Heading = headingLevel === 2 ? "h2" : "h3";
  const currentView = currentCustomerView(state);
  const actions = availableActions(state);
  const status = submissionView(state);
  const history = historyRows(state);
  const disabledHint = actions.find((action) => !action.enabled && action.hint);
  const ready = state.link.status === "ready";
  return (
    <section aria-labelledby="sale-customer-title" className="sale-customer">
      <Heading id="sale-customer-title">Cliente da venda</Heading>
      <p className="sale-hint">{VALUES_UNCHANGED_NOTE}</p>
      {currentView.kind === "error" ? (
        <p className="sale-message is-error" role="alert">
          {currentView.label}{" "}
          <button
            className="sale-link-button"
            onClick={handleRetry}
            type="button"
          >
            Tentar novamente
          </button>
        </p>
      ) : (
        <dl className="sale-details">
          <div>
            <dt>Cliente atual</dt>
            <dd>{currentView.label}</dd>
          </div>
          {currentView.detail ? (
            <div>
              <dt>Situação</dt>
              <dd>{currentView.detail}</dd>
            </div>
          ) : null}
        </dl>
      )}
      {ready ? (
        <>
          <CustomerPicker
            disabled={status.kind === "submitting"}
            onChange={handleSelect}
            selectedId={state.selectedCustomerId}
            view={pickerView(state)}
          />
          <div className="sale-actions">
            {actions.map((action) => (
              <ActionButton
                action={action}
                key={action.action}
                onAction={handleActionEvent}
              />
            ))}
          </div>
          {disabledHint ? (
            <p className="sale-hint">{disabledHint.hint}</p>
          ) : null}
        </>
      ) : null}
      <div aria-live="polite" role="status">
        {status.kind === "success" || status.kind === "submitting" ? (
          <p
            className={
              status.kind === "success"
                ? "sale-message is-success"
                : "sale-status"
            }
          >
            {status.message}
          </p>
        ) : null}
      </div>
      {status.kind === "error" ? (
        <p className="sale-message is-error" role="alert">
          {status.message}
        </p>
      ) : null}
      {history.length > 0 ? (
        <>
          <h4>Histórico de atribuição</h4>
          <ol className="sale-history">
            {history.map((row) => (
              <li key={row.key}>
                <span>
                  v{row.version} · {row.text}
                </span>
                <small>{row.dateText}</small>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {ready && history.length === 0 ? (
        <p className="sale-hint">
          Ainda não há histórico: esta venda nunca teve cliente associado.
        </p>
      ) : null}
    </section>
  );
}

interface DisclosureProps {
  organizationId: string;
  saleId: string;
}

/** Optional, collapsed entry point shown after a sale is confirmed. */
export function SaleCustomerDisclosure({
  organizationId,
  saleId,
}: DisclosureProps) {
  const [open, setOpen] = useState(false);
  const handleToggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <div className="sale-customer-disclosure">
      <button
        aria-controls="sale-customer-region"
        aria-expanded={open}
        className="quiet-button"
        onClick={handleToggle}
        type="button"
      >
        {open
          ? "Ocultar cliente da venda"
          : "Associar cliente a esta venda (opcional)"}
      </button>
      <div hidden={!open} id="sale-customer-region">
        {open ? (
          <SaleCustomerPanel
            headingLevel={3}
            key={saleId}
            organizationId={organizationId}
            saleId={saleId}
          />
        ) : null}
      </div>
    </div>
  );
}
