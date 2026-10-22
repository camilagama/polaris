import type {
  CustomerDuplicateMatchReadModel,
  CustomerReadModel,
} from "@polaris/contracts";
import {
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { focusLater } from "../lib/focus";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import {
  createOfflineCustomer,
  type PendingCustomer,
  pendingCustomers,
} from "../offline/customer-create";
import {
  overlayPendingCustomerEdits,
  type PendingCustomerUpdate,
  pendingCustomerUpdates,
  updateOfflineCustomer,
} from "../offline/customer-update";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import {
  findLocalDuplicates,
  listLocalCustomers,
  toLocalCustomerRow,
} from "./local-customers";
import "./customers-page.css";
import {
  type CustomerDraft,
  draftOfCustomer,
  emptyCustomerDraft,
  isCustomerDraftChanged,
} from "./customer-draft";
import { legalAcceptanceMessage } from "../lib/rpc-error";

type CustomerListStatus = "active" | "archived";
type CustomerAction = "anonymize" | "archive" | "restore";

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });
const customerStatuses: ReadonlyArray<readonly [CustomerListStatus, string]> = [
  ["active", "Ativos"],
  ["archived", "Arquivados"],
];

function rpcErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/** What did not happen, without the sentence about the session: the notice of the shell carries that one. */
function unauthorizedText(
  action?: CustomerAction | "duplicate-check" | "load" | "save"
): string {
  switch (action) {
    case "anonymize":
      return "O cliente não foi anonimizado.";
    case "archive":
      return "O cliente não foi arquivado.";
    case "restore":
      return "O cliente não foi restaurado.";
    case "load":
      return "Não foi possível carregar os clientes.";
    case "duplicate-check":
      return "Não foi possível conferir se o cliente já existe.";
    default:
      return "O cliente não foi salvo.";
  }
}

function errorMessage(
  error: unknown,
  action?: CustomerAction | "duplicate-check" | "load" | "save"
): string {
  if (
    error instanceof Error &&
    error.message === "customer_has_pending_command"
  ) {
    return "Este cliente já tem uma alteração ou um cadastro aguardando envio. Espere o envio ou resolva em Pendências.";
  }
  const unaccepted = legalAcceptanceMessage(
    error,
    action === "load" ? "os clientes" : undefined
  );
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return unauthorizedText(action);
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  if (
    code === "BAD_REQUEST" &&
    (action === "save" || action === "duplicate-check")
  ) {
    return "Confira o nome e informe ao menos um telefone ou email válido.";
  }
  if (code === "CONFLICT") {
    return "Os dados do cliente mudaram em outra solicitação. Atualize a lista e tente novamente.";
  }
  if (code === "NOT_FOUND") {
    return "O cliente não existe mais nesta organização.";
  }
  if (code === "SERVICE_UNAVAILABLE" && action === "duplicate-check") {
    return "Não foi possível verificar possíveis clientes repetidos. Tente novamente antes de salvar.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "A lista de clientes está temporariamente indisponível. Tente novamente.";
  }
  if (action === "load") {
    return "Não foi possível carregar os clientes. Tente novamente.";
  }
  return "Não foi possível salvar o cliente. Revise os campos e tente novamente.";
}

function customerStatusLabel(customer: CustomerReadModel): string {
  if (customer.anonymizedAt !== null) {
    return "Anonimizado";
  }
  return customer.status === "active" ? "Ativo" : "Arquivado";
}

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

const CONTACT_REQUIRED_TEXT =
  "Informe ao menos um telefone ou email para o cliente.";

function hasCustomerContact(draft: CustomerDraft): boolean {
  return Boolean(draft.phone.trim() || draft.email.trim());
}

function isCustomerListStatus(value: string): value is CustomerListStatus {
  return value === "active" || value === "archived";
}

function customerStatusFromEvent(
  event: MouseEvent<HTMLButtonElement>
): CustomerListStatus | null {
  const value = event.currentTarget.dataset.customerStatus;
  if (value && isCustomerListStatus(value)) {
    return value;
  }
  return null;
}

interface CustomerFormProps {
  /** Why the form cannot be saved yet: no phone and no email. Shown beside the button, with the fields marked. */
  contactError: string | null;
  draft: CustomerDraft;
  duplicateMatches: CustomerDuplicateMatchReadModel[];
  editingCustomer: CustomerReadModel | null;
  isPending: boolean;
  onCancel: () => void;
  onChange: (field: keyof CustomerDraft, value: string) => void;
  onCreateAnyway: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUseExisting: (customer: CustomerReadModel) => void;
}

interface CustomerDuplicateCandidateProps {
  customer: CustomerReadModel;
  disabled: boolean;
  matchedBy: Array<"email" | "phone">;
  onUseExisting: (customer: CustomerReadModel) => void;
}

function CustomerDuplicateCandidate({
  customer,
  disabled,
  matchedBy,
  onUseExisting,
}: CustomerDuplicateCandidateProps) {
  const handleUseExisting = useCallback(
    () => onUseExisting(customer),
    [customer, onUseExisting]
  );

  return (
    <li className="customer-duplicate-item">
      <div className="customer-duplicate-details">
        <div className="customer-duplicate-title-row">
          <strong>{customer.name}</strong>
          <span className={`category-status status-${customer.status}`}>
            {customer.status === "active" ? "Ativo" : "Arquivado"}
          </span>
        </div>
        <div className="customer-duplicate-contacts">
          {customer.phone ? <span>{customer.phone}</span> : null}
          {customer.email ? <span>{customer.email}</span> : null}
        </div>
        <p>
          Correspondência por{" "}
          {matchedBy
            .map((field) => (field === "email" ? "email" : "telefone"))
            .join(" e ")}
          .
        </p>
        {customer.status === "archived" ? (
          <p className="customer-duplicate-archived-note">
            Selecionar este cadastro não o restaura.
          </p>
        ) : null}
      </div>
      <button
        aria-label={`Usar existente: ${customer.name}`}
        className="primary-button"
        disabled={disabled}
        onClick={handleUseExisting}
        type="button"
      >
        Usar existente
      </button>
    </li>
  );
}

function customerSubmitLabel(
  isPending: boolean,
  editingCustomer: CustomerReadModel | null
): string {
  if (isPending) {
    return "Salvando…";
  }
  if (editingCustomer) {
    return "Salvar alterações";
  }
  return "Cadastrar cliente";
}

function CustomerForm({
  contactError,
  draft,
  duplicateMatches,
  editingCustomer,
  isPending,
  onCancel,
  onChange,
  onCreateAnyway,
  onUseExisting,
  onSubmit,
}: CustomerFormProps) {
  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange("name", event.currentTarget.value),
    [onChange]
  );
  const handlePhoneChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange("phone", event.currentTarget.value),
    [onChange]
  );
  const handleEmailChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange("email", event.currentTarget.value),
    [onChange]
  );
  const handleNotesChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      onChange("notes", event.currentTarget.value),
    [onChange]
  );

  return (
    <section
      aria-labelledby="customer-form-heading"
      className="customer-form-panel"
    >
      <div className="customer-section-heading">
        <div>
          <p className="categories-eyebrow">
            {editingCustomer ? "Atualização" : "Cadastro"}
          </p>
          <h2 id="customer-form-heading">
            {editingCustomer ? "Editar cliente" : "Novo cliente"}
          </h2>
        </div>
        {editingCustomer ? (
          <button
            className="quiet-button"
            disabled={isPending}
            onClick={onCancel}
            type="button"
          >
            Cancelar edição
          </button>
        ) : null}
      </div>

      <form className="customer-form" onSubmit={onSubmit}>
        <div className="customer-form-field">
          <label className="field-label" htmlFor="customer-name">
            Nome
          </label>
          <input
            autoComplete="name"
            disabled={isPending}
            id="customer-name"
            onChange={handleNameChange}
            required
            value={draft.name}
          />
        </div>

        <fieldset
          aria-describedby="customer-contact-help"
          className="customer-contact-fields"
        >
          <legend className="field-label customer-contact-label">
            Contato{" "}
            <span className="field-optional">Informe telefone ou email</span>
          </legend>
          <div className="customer-contact-grid">
            <div className="customer-form-field">
              <label className="field-label" htmlFor="customer-phone">
                Telefone <span className="field-optional">Opcional</span>
              </label>
              <input
                aria-describedby={
                  contactError ? "customer-contact-error" : undefined
                }
                aria-invalid={contactError ? true : undefined}
                autoComplete="tel"
                disabled={isPending}
                id="customer-phone"
                onChange={handlePhoneChange}
                type="tel"
                value={draft.phone}
              />
            </div>
            <div className="customer-form-field">
              <label className="field-label" htmlFor="customer-email">
                Email <span className="field-optional">Opcional</span>
              </label>
              <input
                aria-describedby={
                  contactError ? "customer-contact-error" : undefined
                }
                aria-invalid={contactError ? true : undefined}
                autoComplete="email"
                disabled={isPending}
                id="customer-email"
                onChange={handleEmailChange}
                type="email"
                value={draft.email}
              />
            </div>
          </div>
          <p className="field-help" id="customer-contact-help">
            Email e telefone podem se repetir entre clientes.
          </p>
        </fieldset>

        {/* always in the tree, so the panel that appears after the check is announced (U-25) */}
        <p className="visually-hidden" role="status">
          {duplicateMatches.length > 0
            ? "Encontramos possíveis clientes existentes. Revise antes de criar um novo."
            : ""}
        </p>
        {duplicateMatches.length > 0 ? (
          <section
            aria-labelledby="customer-duplicate-heading"
            className="customer-duplicate-panel"
          >
            <div className="customer-duplicate-intro">
              <h3 id="customer-duplicate-heading">
                Encontramos possíveis clientes existentes
              </h3>
              <p>
                Revise os cadastros por email ou telefone. Nenhum dado será
                mesclado automaticamente.
              </p>
            </div>
            <ul className="customer-duplicate-list">
              {duplicateMatches.map(({ customer, matchedBy }) => (
                <CustomerDuplicateCandidate
                  customer={customer}
                  disabled={isPending}
                  key={customer.id}
                  matchedBy={matchedBy}
                  onUseExisting={onUseExisting}
                />
              ))}
            </ul>
            <div className="customer-duplicate-actions">
              <button
                className="quiet-button"
                disabled={isPending}
                onClick={onCreateAnyway}
                type="button"
              >
                Criar mesmo assim
              </button>
            </div>
          </section>
        ) : null}

        <div className="customer-form-field customer-notes-field">
          <label className="field-label" htmlFor="customer-notes">
            Observações <span className="field-optional">Opcional</span>
          </label>
          <textarea
            disabled={isPending}
            id="customer-notes"
            onChange={handleNotesChange}
            rows={3}
            value={draft.notes}
          />
        </div>

        {contactError ? (
          <p
            className="field-error customer-contact-error"
            id="customer-contact-error"
            role="alert"
          >
            {contactError}
          </p>
        ) : null}
        <div className="customer-form-actions">
          <button className="primary-button" disabled={isPending} type="submit">
            {customerSubmitLabel(isPending, editingCustomer)}
          </button>
        </div>
      </form>
    </section>
  );
}

interface CustomerCardProps {
  customer: CustomerReadModel;
  isPending: boolean;
  /** Why editing, archiving and restoring are unavailable for this customer, or null. */
  lockedReason: string | null;
  /** Why archiving, restoring and anonymizing (not editing) are unavailable right now, or null. */
  lifecycleReason: string | null;
  onAnonymize: (customer: CustomerReadModel) => void;
  onArchive: (customer: CustomerReadModel) => void;
  onEdit: (customer: CustomerReadModel) => void;
  onRestore: (customer: CustomerReadModel) => void;
  pendingAction: string | null;
  /** The customer was created on this device and the server has not confirmed it yet. */
  syncState: PendingCustomer | undefined;
  /** An edit made on this device that the server has not confirmed yet. */
  updateState: PendingCustomerUpdate | undefined;
}

function syncStateLabel(
  syncState: PendingCustomer | PendingCustomerUpdate,
  isUpdate: boolean
): string {
  if (syncState.state === "rejected") {
    return isUpdate
      ? "Alteração recusada pelo servidor"
      : "Recusado pelo servidor";
  }
  if (syncState.state === "sending") {
    return isUpdate ? "Enviando alteração…" : "Enviando…";
  }
  return isUpdate ? "Alteração aguardando envio" : "Aguardando envio";
}

interface CustomerActionsProps {
  customer: CustomerReadModel;
  isPending: boolean;
  lifecycleLocked: boolean;
  lockedReason: string | null;
  onAnonymize: (customer: CustomerReadModel) => void;
  onArchive: (customer: CustomerReadModel) => void;
  onEdit: (customer: CustomerReadModel) => void;
  onRestore: (customer: CustomerReadModel) => void;
  pendingAction: string | null;
}

/** What can be done to a customer that was not anonymized (an anonymized one has no actions). */
function CustomerActions({
  customer,
  isPending,
  lifecycleLocked,
  lockedReason,
  onAnonymize,
  onArchive,
  onEdit,
  onRestore,
  pendingAction,
}: CustomerActionsProps) {
  const [confirmingAnonymize, setConfirmingAnonymize] = useState(false);
  const handleEdit = useCallback(() => onEdit(customer), [customer, onEdit]);
  const handleArchive = useCallback(
    () => onArchive(customer),
    [customer, onArchive]
  );
  const handleRestore = useCallback(
    () => onRestore(customer),
    [customer, onRestore]
  );
  const handleAskAnonymize = useCallback(
    () => setConfirmingAnonymize(true),
    []
  );
  const handleCancelAnonymize = useCallback(
    () => setConfirmingAnonymize(false),
    []
  );
  const handleConfirmAnonymize = useCallback(() => {
    setConfirmingAnonymize(false);
    onAnonymize(customer);
  }, [customer, onAnonymize]);
  const pendingLabel = (
    action: CustomerAction,
    running: string,
    idle: string
  ) => (pendingAction === `${action}:${customer.id}` ? running : idle);

  return (
    <>
      <div className="customer-card-actions">
        <button
          aria-label={`Editar cliente ${customer.name}`}
          className="quiet-button"
          disabled={isPending || lockedReason !== null}
          onClick={handleEdit}
          type="button"
        >
          Editar
        </button>
        {customer.status === "active" ? (
          <button
            aria-label={`Arquivar cliente ${customer.name}`}
            className="quiet-button"
            disabled={isPending || lifecycleLocked}
            onClick={handleArchive}
            type="button"
          >
            {pendingLabel("archive", "Arquivando…", "Arquivar")}
          </button>
        ) : (
          <button
            aria-label={`Restaurar cliente ${customer.name}`}
            className="quiet-button"
            disabled={isPending || lifecycleLocked}
            onClick={handleRestore}
            type="button"
          >
            {pendingLabel("restore", "Restaurando…", "Restaurar")}
          </button>
        )}
        <button
          aria-label={`Anonimizar cliente ${customer.name}`}
          className="quiet-button"
          disabled={isPending || lifecycleLocked}
          onClick={handleAskAnonymize}
          type="button"
        >
          {pendingLabel("anonymize", "Anonimizando…", "Anonimizar")}
        </button>
      </div>
      {confirmingAnonymize ? (
        <fieldset className="customer-anonymize-confirm" disabled={isPending}>
          <legend>Confirmar a anonimização de {customer.name}</legend>
          <p>
            Anonimizar remove o nome, o telefone, o email e as observações deste
            cliente. <strong>Não dá para desfazer.</strong> As vendas ligadas a
            ele continuam com os mesmos valores.
          </p>
          <div className="customer-card-actions">
            <button
              className="quiet-button"
              onClick={handleCancelAnonymize}
              type="button"
            >
              Cancelar
            </button>
            <button
              className="danger-button"
              onClick={handleConfirmAnonymize}
              type="button"
            >
              Anonimizar definitivamente
            </button>
          </div>
        </fieldset>
      ) : null}
    </>
  );
}

function CustomerCard({
  customer,
  lifecycleReason,
  lockedReason,
  isPending,
  onAnonymize,
  onArchive,
  onEdit,
  onRestore,
  pendingAction,
  syncState,
  updateState,
}: CustomerCardProps) {
  const isAnonymized = customer.anonymizedAt !== null;
  const shownState = syncState ?? updateState;
  const reason = lockedReason ?? lifecycleReason;

  return (
    <article className="customer-card">
      <div className="customer-card-main">
        <div className="customer-card-title-row">
          <h3>{customer.name}</h3>
          <span className={`category-status status-${customer.status}`}>
            {customerStatusLabel(customer)}
          </span>
          {shownState ? (
            <span
              className="customer-sync-state"
              data-state={shownState.state}
              role="status"
            >
              {syncStateLabel(shownState, !syncState)}
            </span>
          ) : null}
        </div>
        <div className="customer-card-contacts">
          {customer.phone ? <span>{customer.phone}</span> : null}
          {customer.email ? <span>{customer.email}</span> : null}
        </div>
        {customer.notes ? (
          <p className="customer-notes">{customer.notes}</p>
        ) : null}
        <p className="customer-meta">
          Atualizado em {formatDate(customer.updatedAt)}
        </p>
        {shownState?.state === "rejected" ? (
          <p className="customer-meta">
            <a href="/attention">Resolver em Pendências</a>
          </p>
        ) : null}
        {reason ? <p className="customer-meta">{reason}</p> : null}
        {isAnonymized ? (
          <p className="customer-meta">
            Dados pessoais removidos. Este cadastro não pode ser editado nem
            restaurado; as vendas ligadas a ele mantêm seus valores.
          </p>
        ) : null}
      </div>
      {isAnonymized ? null : (
        <CustomerActions
          customer={customer}
          isPending={isPending}
          lifecycleLocked={reason !== null}
          lockedReason={lockedReason}
          onAnonymize={onAnonymize}
          onArchive={onArchive}
          onEdit={onEdit}
          onRestore={onRestore}
          pendingAction={pendingAction}
        />
      )}
    </article>
  );
}

/**
 * Nothing can be done to a customer the server has not confirmed, nor on top of
 * an edit it has not confirmed (the next one would be made from a version the
 * server has not produced yet).
 */
function lockedReasonFor(
  syncState: PendingCustomer | undefined,
  updateState: PendingCustomerUpdate | undefined
): string | null {
  if (syncState) {
    return "Disponível depois que o servidor confirmar o cadastro.";
  }
  if (updateState) {
    return updateState.state === "rejected"
      ? "A alteração foi recusada. Resolva em Pendências antes de alterar de novo."
      : "Disponível depois que o servidor confirmar a alteração.";
  }
  return null;
}

interface CustomerWorkspaceProps {
  contactError: string | null;
  customers: CustomerReadModel[];
  draft: CustomerDraft;
  duplicateMatches: CustomerDuplicateMatchReadModel[];
  editingCustomer: CustomerReadModel | null;
  error: string | null;
  isLoading: boolean;
  /** Working from this device's collections while the connection is down. */
  isOffline: boolean;
  notice: string | null;
  onAnonymize: (customer: CustomerReadModel) => void;
  onArchive: (customer: CustomerReadModel) => void;
  onCancelEdit: () => void;
  onChange: (field: keyof CustomerDraft, value: string) => void;
  onCreateAnyway: () => void;
  onEdit: (customer: CustomerReadModel) => void;
  onRestore: (customer: CustomerReadModel) => void;
  onStatusClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUseExisting: (customer: CustomerReadModel) => void;
  pendingAction: string | null;
  status: CustomerListStatus;
  /** Customers created on this device that the server has not confirmed yet. */
  syncStates: ReadonlyMap<string, PendingCustomer>;
  /** Edits made on this device that the server has not confirmed yet. */
  updateStates: ReadonlyMap<string, PendingCustomerUpdate>;
}

function CustomerWorkspace({
  contactError,
  customers,
  draft,
  duplicateMatches,
  editingCustomer,
  error,
  isLoading,
  isOffline,
  syncStates,
  updateStates,
  notice,
  onAnonymize,
  onArchive,
  onCancelEdit,
  onChange,
  onCreateAnyway,
  onEdit,
  onRestore,
  onStatusClick,
  onSubmit,
  onUseExisting,
  pendingAction,
  status,
}: CustomerWorkspaceProps) {
  return (
    <>
      <section className="categories-heading">
        <div>
          <p className="categories-eyebrow">Relacionamento</p>
          <h1>Clientes</h1>
          <p className="categories-intro-copy">
            Cadastre nome e pelo menos um contato. Email e telefone podem se
            repetir entre clientes.
          </p>
        </div>
      </section>

      {isOffline ? (
        <p className="customer-notice" role="status">
          Sem conexão. Você pode cadastrar e editar clientes; as mudanças são
          enviadas quando a conexão voltar. Arquivar e restaurar precisam de
          conexão.
        </p>
      ) : null}
      {notice ? (
        <p className="customer-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="customer-error" role="alert">
          {error}
        </p>
      ) : null}

      {status === "active" || editingCustomer ? (
        <CustomerForm
          contactError={contactError}
          draft={draft}
          duplicateMatches={duplicateMatches}
          editingCustomer={editingCustomer}
          isPending={pendingAction !== null}
          onCancel={onCancelEdit}
          onChange={onChange}
          onCreateAnyway={onCreateAnyway}
          onSubmit={onSubmit}
          onUseExisting={onUseExisting}
        />
      ) : null}

      <section
        aria-busy={isLoading}
        aria-labelledby="customer-list-heading"
        className="customer-list-panel"
      >
        <div className="customer-list-heading">
          <div>
            <p className="categories-eyebrow">Registros da organização</p>
            <h2 id="customer-list-heading">
              {status === "active" ? "Clientes ativos" : "Clientes arquivados"}
            </h2>
          </div>
          <nav aria-label="Estado dos clientes" className="category-tabs">
            {customerStatuses.map(([value, label]) => (
              <button
                aria-pressed={status === value}
                className={
                  status === value ? "category-tab is-selected" : "category-tab"
                }
                data-customer-status={value}
                disabled={pendingAction !== null}
                key={value}
                onClick={onStatusClick}
                type="button"
              >
                {label}
              </button>
            ))}
          </nav>
        </div>

        {isLoading ? (
          <p className="customer-empty-state" role="status">
            Carregando clientes…
          </p>
        ) : null}
        {!isLoading && customers.length === 0 ? (
          <p className="customer-empty-state">
            {status === "active"
              ? "Nenhum cliente cadastrado. Use o formulário para adicionar o primeiro."
              : "Nenhum cliente arquivado."}
          </p>
        ) : null}
        {!isLoading && customers.length > 0 ? (
          <ul className="customer-list">
            {customers.map((customer) => (
              <li className="customer-list-item" key={customer.id}>
                <CustomerCard
                  customer={customer}
                  isPending={pendingAction !== null}
                  lifecycleReason={
                    isOffline
                      ? "Arquivar, restaurar e anonimizar precisam de conexão."
                      : null
                  }
                  lockedReason={lockedReasonFor(
                    syncStates.get(customer.id),
                    updateStates.get(customer.id)
                  )}
                  onAnonymize={onAnonymize}
                  onArchive={onArchive}
                  onEdit={onEdit}
                  onRestore={onRestore}
                  pendingAction={pendingAction}
                  syncState={syncStates.get(customer.id)}
                  updateState={updateStates.get(customer.id)}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}

/**
 * After the server changed a customer, the same row goes into the local
 * collection (when the runtime is on), so the list read from the device shows
 * it at once instead of waiting for the next pull; the pull later writes the
 * same version again.
 */
async function keepLocalRow(
  workspace: ReturnType<typeof useLocalWorkspace>,
  customer: CustomerReadModel
): Promise<void> {
  if (workspace) {
    await workspace.stores.writer.upsert("customers", [
      toLocalCustomerRow(customer),
    ]);
  }
}

export function CustomersPage() {
  const { organizationId } = useCurrentOrganization();
  const workspace = useLocalWorkspace(organizationId);
  const [syncStates, setSyncStates] = useState<
    ReadonlyMap<string, PendingCustomer>
  >(new Map());
  const [updateStates, setUpdateStates] = useState<
    ReadonlyMap<string, PendingCustomerUpdate>
  >(new Map());
  const [status, setStatus] = useState<CustomerListStatus>("active");
  const [customers, setCustomers] = useState<CustomerReadModel[]>([]);
  const [draft, setDraft] = useState<CustomerDraft>(emptyCustomerDraft);
  const [editingCustomer, setEditingCustomer] =
    useState<CustomerReadModel | null>(null);
  const [duplicateMatches, setDuplicateMatches] = useState<
    CustomerDuplicateMatchReadModel[]
  >([]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);
  const customerLoadSequence = useRef(0);
  useReportUnsentWork(isCustomerDraftChanged(draft, editingCustomer));
  // any change of the form (typing, picking another customer, clearing) takes the contact error away
  useEffect(() => setContactError(null), [draft]);

  const loadCustomers = useCallback(
    async (targetOrganizationId: string, targetStatus: CustomerListStatus) => {
      customerLoadSequence.current += 1;
      const requestSequence = customerLoadSequence.current;
      setIsLoading(true);
      setError(null);
      setCustomers([]);
      try {
        const result = await orpcClient.customer.list({
          organizationId: targetOrganizationId,
          status: targetStatus,
        });
        if (requestSequence !== customerLoadSequence.current) {
          return;
        }
        setCustomers(result.customers);
      } catch (caughtError) {
        if (requestSequence === customerLoadSequence.current) {
          setError(errorMessage(caughtError, "load"));
        }
      } finally {
        if (requestSequence === customerLoadSequence.current) {
          setIsLoading(false);
        }
      }
    },
    []
  );

  const usesLocalRows = workspace !== null;
  useEffect(() => {
    if (usesLocalRows) {
      return;
    }
    loadCustomers(organizationId, status);
    return () => {
      customerLoadSequence.current += 1;
    };
  }, [loadCustomers, organizationId, status, usesLocalRows]);

  // With the offline runtime ready the list comes from this device, and is read
  // again whenever the runtime says the local rows may have changed.
  useEffect(() => {
    if (!workspace) {
      return;
    }
    let cancelled = false;
    const { outbox, writer } = workspace.stores;
    Promise.all([
      writer.rows("customers"),
      pendingCustomers(outbox),
      pendingCustomerUpdates(outbox),
      outbox.snapshot(),
    ])
      .then(([rows, pending, updates, snapshot]) => {
        if (cancelled) {
          return;
        }
        // an edit still waiting is shown over the server's row (never written into it)
        setCustomers(
          listLocalCustomers(
            overlayPendingCustomerEdits(rows, snapshot.commands),
            organizationId,
            status
          )
        );
        setSyncStates(new Map(pending.map((item) => [item.customerId, item])));
        setUpdateStates(
          new Map(updates.map((item) => [item.customerId, item]))
        );
        setError(null);
        setIsLoading(false);
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setError(errorMessage(caughtError, "load"));
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, organizationId, status]);

  /** Shows the change: the local rows are read again, or the server's list is. */
  const refreshList = useCallback(async () => {
    if (workspace) {
      await workspace.runtime.refreshCounts();
      workspace.runtime.localDataChanged();
      return;
    }
    await loadCustomers(organizationId, status);
  }, [loadCustomers, organizationId, status, workspace]);

  const handleDraftChange = useCallback(
    (field: keyof CustomerDraft, value: string) => {
      setDraft((current) => ({ ...current, [field]: value }));
      setDuplicateMatches([]);
      setError(null);
      setNotice(null);
    },
    []
  );

  const handleStatusClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const nextStatus = customerStatusFromEvent(event);
      if (nextStatus === null || nextStatus === status) {
        return;
      }
      customerLoadSequence.current += 1;
      setCustomers([]);
      setIsLoading(true);
      setError(null);
      setStatus(nextStatus);
      setEditingCustomer(null);
      setDraft(emptyCustomerDraft);
      setDuplicateMatches([]);
      setNotice(null);
    },
    [status]
  );

  const handleEdit = useCallback((customer: CustomerReadModel) => {
    setEditingCustomer(customer);
    setDraft(draftOfCustomer(customer));
    setDuplicateMatches([]);
    setError(null);
    setNotice(null);
  }, []);

  const handleUseExisting = useCallback(
    (customer: CustomerReadModel) => {
      const locked = lockedReasonFor(
        syncStates.get(customer.id),
        updateStates.get(customer.id)
      );
      if (locked) {
        // the same lock as the card: nothing is edited on top of an unconfirmed change
        setError(locked);
        setNotice(null);
        setDuplicateMatches([]);
        return;
      }
      setStatus(customer.status);
      setEditingCustomer(customer);
      setDraft(draftOfCustomer(customer));
      setDuplicateMatches([]);
      setError(null);
      setNotice(
        customer.status === "archived"
          ? "Cadastro existente selecionado. Ele continua arquivado até você restaurá-lo."
          : "Cadastro existente selecionado para revisão. Nenhum dado foi mesclado."
      );
    },
    [syncStates, updateStates]
  );

  const handleCancelEdit = useCallback(() => {
    setEditingCustomer(null);
    setDraft(emptyCustomerDraft);
    setDuplicateMatches([]);
    setError(null);
    setNotice(null);
  }, []);

  const findDraftDuplicates = useCallback(async () => {
    if (workspace) {
      const [rows, snapshot] = await Promise.all([
        workspace.stores.writer.rows("customers"),
        workspace.stores.outbox.snapshot(),
      ]);
      return findLocalDuplicates(
        // a phone or e-mail changed by an edit that is still waiting counts
        overlayPendingCustomerEdits(rows, snapshot.commands),
        organizationId,
        { email: draft.email, phone: draft.phone }
      );
    }
    const result = await orpcClient.customer.findPossibleDuplicates({
      email: draft.email,
      organizationId,
      phone: draft.phone,
    });
    return result.matches;
  }, [draft.email, draft.phone, organizationId, workspace]);

  const persistCustomer = useCallback(async () => {
    const profile = {
      email: draft.email,
      name: draft.name,
      notes: draft.notes,
      organizationId,
      phone: draft.phone,
    };
    if (editingCustomer && workspace && !workspace.online) {
      // Queued on this device (from the version the person edited) and shown at once.
      const stores = workspace.runtime.context();
      if (!stores || stores.organizationId !== organizationId) {
        throw new Error("offline_runtime_unavailable");
      }
      await updateOfflineCustomer({
        current: editingCustomer,
        deviceId: stores.deviceId,
        input: profile,
        lease: stores.lease,
        organizationId,
        outbox: stores.outbox,
      });
      return "Alteração salva neste aparelho. Ela será enviada quando a conexão voltar.";
    }
    if (editingCustomer) {
      const updated = await orpcClient.customer.update({
        ...profile,
        expectedVersion: editingCustomer.version,
        id: editingCustomer.id,
      });
      await keepLocalRow(workspace, updated.customer);
      return "Dados do cliente atualizados.";
    }
    if (workspace) {
      // Queued on this device and shown at once; sent now when there is a connection.
      const stores = workspace.runtime.context();
      if (!stores || stores.organizationId !== organizationId) {
        // not ready, or the organization changed under the screen: nothing is queued
        throw new Error("offline_runtime_unavailable");
      }
      await createOfflineCustomer({
        deviceId: stores.deviceId,
        input: profile,
        lease: stores.lease,
        organizationId,
        outbox: stores.outbox,
        writer: stores.writer,
      });
      if (workspace.online) {
        workspace.runtime.syncNow().catch(() => undefined);
        return "Cliente cadastrado.";
      }
      return "Cliente salvo neste aparelho. Ele será enviado quando a conexão voltar.";
    }
    await orpcClient.customer.create(profile);
    return "Cliente cadastrado.";
  }, [draft, editingCustomer, organizationId, workspace]);

  const saveCustomer = useCallback(
    async (allowPossibleDuplicates = false) => {
      if (!hasCustomerContact(draft)) {
        // beside the button and on the fields, not at the top of the page (U-24)
        setContactError(CONTACT_REQUIRED_TEXT);
        setError(null);
        setNotice(null);
        focusLater(() => document.getElementById("customer-phone")?.focus());
        return;
      }
      setContactError(null);

      const needsDuplicateCheck = !(editingCustomer || allowPossibleDuplicates);
      if (editingCustomer) {
        setPendingAction(`update:${editingCustomer.id}`);
      } else if (allowPossibleDuplicates) {
        setPendingAction("create");
      } else {
        setPendingAction("duplicate-check");
      }
      setError(null);
      setNotice(null);
      setDuplicateMatches([]);
      let failureAction: "duplicate-check" | "save" = "save";
      if (needsDuplicateCheck) {
        failureAction = "duplicate-check";
      }
      try {
        if (needsDuplicateCheck) {
          const matches = await findDraftDuplicates();
          if (matches.length > 0) {
            setDuplicateMatches(matches);
            return;
          }
          failureAction = "save";
        }
        setNotice(await persistCustomer());
        setEditingCustomer(null);
        setDraft(emptyCustomerDraft);
        await refreshList();
      } catch (caughtError) {
        setError(errorMessage(caughtError, failureAction));
      } finally {
        setPendingAction(null);
      }
    },
    [draft, editingCustomer, findDraftDuplicates, persistCustomer, refreshList]
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await saveCustomer();
    },
    [saveCustomer]
  );

  const handleCreateAnyway = useCallback(
    () => saveCustomer(true),
    [saveCustomer]
  );

  const handleLifecycle = useCallback(
    async (customer: CustomerReadModel, action: CustomerAction) => {
      setPendingAction(`${action}:${customer.id}`);
      setError(null);
      setNotice(null);
      try {
        const input = {
          expectedVersion: customer.version,
          id: customer.id,
          organizationId,
        };
        if (action === "anonymize") {
          const anonymized =
            await orpcClient.customer.anonymizeForPrivacy(input);
          await keepLocalRow(workspace, anonymized.customer);
          setNotice(
            "Cliente anonimizado. Os dados pessoais foram removidos; as vendas ligadas a ele mantêm seus valores."
          );
        } else if (action === "archive") {
          const archived = await orpcClient.customer.archive(input);
          await keepLocalRow(workspace, archived.customer);
          setNotice("Cliente arquivado.");
        } else {
          const restored = await orpcClient.customer.restore(input);
          await keepLocalRow(workspace, restored.customer);
          setNotice("Cliente restaurado.");
        }
        if (editingCustomer?.id === customer.id) {
          setEditingCustomer(null);
          setDraft(emptyCustomerDraft);
        }
        await refreshList();
      } catch (caughtError) {
        setError(errorMessage(caughtError, action));
      } finally {
        setPendingAction(null);
      }
    },
    [editingCustomer, organizationId, refreshList, workspace]
  );

  const handleAnonymize = useCallback(
    (customer: CustomerReadModel) => handleLifecycle(customer, "anonymize"),
    [handleLifecycle]
  );
  const handleArchive = useCallback(
    (customer: CustomerReadModel) => handleLifecycle(customer, "archive"),
    [handleLifecycle]
  );
  const handleRestore = useCallback(
    (customer: CustomerReadModel) => handleLifecycle(customer, "restore"),
    [handleLifecycle]
  );

  return (
    <div className="customers-page">
      <CustomerWorkspace
        contactError={contactError}
        customers={customers}
        draft={draft}
        duplicateMatches={duplicateMatches}
        editingCustomer={editingCustomer}
        error={error}
        isLoading={isLoading}
        isOffline={workspace !== null && !workspace.online}
        notice={notice}
        onAnonymize={handleAnonymize}
        onArchive={handleArchive}
        onCancelEdit={handleCancelEdit}
        onChange={handleDraftChange}
        onCreateAnyway={handleCreateAnyway}
        onEdit={handleEdit}
        onRestore={handleRestore}
        onStatusClick={handleStatusClick}
        onSubmit={handleSubmit}
        onUseExisting={handleUseExisting}
        pendingAction={pendingAction}
        status={status}
        syncStates={syncStates}
        updateStates={updateStates}
      />
    </div>
  );
}
