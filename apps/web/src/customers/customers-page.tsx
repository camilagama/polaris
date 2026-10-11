import type { CustomerReadModel } from "@polaris/contracts";
import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import { orpcClient } from "../lib/orpc";
import "../catalog/categories-page.css";
import "./customers-page.css";

type CustomerListStatus = "active" | "archived";
type CustomerAction = "archive" | "restore";
interface CustomerDraft {
  email: string;
  name: string;
  notes: string;
  phone: string;
}

const organizationIdStorageKey = "polaris.organizationId";
const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });
const customerStatuses: ReadonlyArray<readonly [CustomerListStatus, string]> = [
  ["active", "Ativos"],
  ["archived", "Arquivados"],
];

const emptyDraft: CustomerDraft = {
  email: "",
  name: "",
  notes: "",
  phone: "",
};

function savedOrganizationId(): string | null {
  try {
    return window.localStorage.getItem(organizationIdStorageKey);
  } catch {
    return null;
  }
}

function clearSavedOrganizationId(): void {
  try {
    window.localStorage.removeItem(organizationIdStorageKey);
  } catch {
    // The page still clears its in-memory organization context.
  }
}

function rpcErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function errorMessage(
  error: unknown,
  action?: CustomerAction | "load" | "save"
): string {
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return "Sua sessão não está ativa. Entre novamente para acessar os clientes.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  if (code === "BAD_REQUEST" && action === "save") {
    return "Confira o nome e informe ao menos um telefone ou email válido.";
  }
  if (code === "CONFLICT") {
    return "Os dados do cliente mudaram em outra solicitação. Atualize a lista e tente novamente.";
  }
  if (code === "NOT_FOUND") {
    return "O cliente não existe mais nesta organização.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "A lista de clientes está temporariamente indisponível. Tente novamente.";
  }
  if (action === "load") {
    return "Não foi possível carregar os clientes. Tente novamente.";
  }
  return "Não foi possível salvar o cliente. Revise os campos e tente novamente.";
}

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
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
  draft: CustomerDraft;
  editingCustomer: CustomerReadModel | null;
  isPending: boolean;
  onCancel: () => void;
  onChange: (field: keyof CustomerDraft, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
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
  draft,
  editingCustomer,
  isPending,
  onCancel,
  onChange,
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
                autoComplete="tel"
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
                autoComplete="email"
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

        <div className="customer-form-field customer-notes-field">
          <label className="field-label" htmlFor="customer-notes">
            Observações <span className="field-optional">Opcional</span>
          </label>
          <textarea
            id="customer-notes"
            onChange={handleNotesChange}
            rows={3}
            value={draft.notes}
          />
        </div>

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
  onArchive: (customer: CustomerReadModel) => void;
  onEdit: (customer: CustomerReadModel) => void;
  onRestore: (customer: CustomerReadModel) => void;
  pendingAction: string | null;
}

function CustomerCard({
  customer,
  isPending,
  onArchive,
  onEdit,
  onRestore,
  pendingAction,
}: CustomerCardProps) {
  const handleEdit = useCallback(() => onEdit(customer), [customer, onEdit]);
  const handleArchive = useCallback(
    () => onArchive(customer),
    [customer, onArchive]
  );
  const handleRestore = useCallback(
    () => onRestore(customer),
    [customer, onRestore]
  );
  const actionIsPending = pendingAction?.endsWith(customer.id) ?? false;

  return (
    <article className="customer-card">
      <div className="customer-card-main">
        <div className="customer-card-title-row">
          <h3>{customer.name}</h3>
          <span className={`category-status status-${customer.status}`}>
            {customer.status === "active" ? "Ativo" : "Arquivado"}
          </span>
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
      </div>
      <div className="customer-card-actions">
        <button
          aria-label={`Editar cliente ${customer.name}`}
          className="quiet-button"
          disabled={isPending}
          onClick={handleEdit}
          type="button"
        >
          Editar
        </button>
        {customer.status === "active" ? (
          <button
            aria-label={`Arquivar cliente ${customer.name}`}
            className="quiet-button"
            disabled={isPending}
            onClick={handleArchive}
            type="button"
          >
            {actionIsPending && pendingAction === `archive:${customer.id}`
              ? "Arquivando…"
              : "Arquivar"}
          </button>
        ) : (
          <button
            aria-label={`Restaurar cliente ${customer.name}`}
            className="quiet-button"
            disabled={isPending}
            onClick={handleRestore}
            type="button"
          >
            {actionIsPending && pendingAction === `restore:${customer.id}`
              ? "Restaurando…"
              : "Restaurar"}
          </button>
        )}
      </div>
    </article>
  );
}

interface CustomerWorkspaceProps {
  customers: CustomerReadModel[];
  draft: CustomerDraft;
  editingCustomer: CustomerReadModel | null;
  error: string | null;
  isLoading: boolean;
  notice: string | null;
  onArchive: (customer: CustomerReadModel) => void;
  onCancelEdit: () => void;
  onChange: (field: keyof CustomerDraft, value: string) => void;
  onEdit: (customer: CustomerReadModel) => void;
  onResetOrganization: () => void;
  onRestore: (customer: CustomerReadModel) => void;
  onStatusClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pendingAction: string | null;
  status: CustomerListStatus;
}

function CustomerWorkspace({
  customers,
  draft,
  editingCustomer,
  error,
  isLoading,
  notice,
  onArchive,
  onCancelEdit,
  onChange,
  onEdit,
  onResetOrganization,
  onRestore,
  onStatusClick,
  onSubmit,
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
        <button
          className="quiet-button"
          onClick={onResetOrganization}
          type="button"
        >
          Trocar organização
        </button>
      </section>

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
          draft={draft}
          editingCustomer={editingCustomer}
          isPending={pendingAction !== null}
          onCancel={onCancelEdit}
          onChange={onChange}
          onSubmit={onSubmit}
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
                  onArchive={onArchive}
                  onEdit={onEdit}
                  onRestore={onRestore}
                  pendingAction={pendingAction}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}

export function CustomersPage() {
  const [organizationId, setOrganizationId] = useState<string | null>(
    savedOrganizationId
  );
  const [status, setStatus] = useState<CustomerListStatus>("active");
  const [customers, setCustomers] = useState<CustomerReadModel[]>([]);
  const [draft, setDraft] = useState<CustomerDraft>(emptyDraft);
  const [editingCustomerId, setEditingCustomerId] = useState<string | null>(
    null
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadCustomers = useCallback(
    async (targetOrganizationId: string, targetStatus: CustomerListStatus) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await orpcClient.customer.list({
          organizationId: targetOrganizationId,
          status: targetStatus,
        });
        setCustomers(result.customers);
      } catch (caughtError) {
        setError(errorMessage(caughtError, "load"));
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!organizationId) {
      setCustomers([]);
      setIsLoading(false);
      return;
    }
    loadCustomers(organizationId, status);
  }, [loadCustomers, organizationId, status]);

  const editingCustomer =
    customers.find((customer) => customer.id === editingCustomerId) ?? null;

  const handleDraftChange = useCallback(
    (field: keyof CustomerDraft, value: string) => {
      setDraft((current) => ({ ...current, [field]: value }));
    },
    []
  );

  const handleStatusClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const nextStatus = customerStatusFromEvent(event);
      if (nextStatus === null) {
        return;
      }
      setStatus(nextStatus);
      setEditingCustomerId(null);
      setDraft(emptyDraft);
      setError(null);
      setNotice(null);
    },
    []
  );

  const handleEdit = useCallback((customer: CustomerReadModel) => {
    setEditingCustomerId(customer.id);
    setDraft({
      email: customer.email ?? "",
      name: customer.name,
      notes: customer.notes ?? "",
      phone: customer.phone ?? "",
    });
    setError(null);
    setNotice(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingCustomerId(null);
    setDraft(emptyDraft);
    setError(null);
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!organizationId) {
        return;
      }
      if (!(draft.phone.trim() || draft.email.trim())) {
        setError("Informe ao menos um telefone ou email para o cliente.");
        setNotice(null);
        return;
      }

      setPendingAction(
        editingCustomer ? `update:${editingCustomer.id}` : "create"
      );
      setError(null);
      setNotice(null);
      try {
        const profile = {
          email: draft.email,
          name: draft.name,
          notes: draft.notes,
          organizationId,
          phone: draft.phone,
        };
        if (editingCustomer) {
          await orpcClient.customer.update({
            ...profile,
            expectedVersion: editingCustomer.version,
            id: editingCustomer.id,
          });
          setNotice("Dados do cliente atualizados.");
        } else {
          await orpcClient.customer.create(profile);
          setNotice("Cliente cadastrado.");
        }
        setEditingCustomerId(null);
        setDraft(emptyDraft);
        await loadCustomers(organizationId, status);
      } catch (caughtError) {
        setError(errorMessage(caughtError, "save"));
      } finally {
        setPendingAction(null);
      }
    },
    [draft, editingCustomer, loadCustomers, organizationId, status]
  );

  const handleLifecycle = useCallback(
    async (customer: CustomerReadModel, action: CustomerAction) => {
      if (!organizationId) {
        return;
      }
      setPendingAction(`${action}:${customer.id}`);
      setError(null);
      setNotice(null);
      try {
        const input = {
          expectedVersion: customer.version,
          id: customer.id,
          organizationId,
        };
        if (action === "archive") {
          await orpcClient.customer.archive(input);
          setNotice("Cliente arquivado.");
        } else {
          await orpcClient.customer.restore(input);
          setNotice("Cliente restaurado.");
        }
        if (editingCustomerId === customer.id) {
          setEditingCustomerId(null);
          setDraft(emptyDraft);
        }
        await loadCustomers(organizationId, status);
      } catch (caughtError) {
        setError(errorMessage(caughtError, action));
      } finally {
        setPendingAction(null);
      }
    },
    [editingCustomerId, loadCustomers, organizationId, status]
  );

  const handleArchive = useCallback(
    (customer: CustomerReadModel) => handleLifecycle(customer, "archive"),
    [handleLifecycle]
  );
  const handleRestore = useCallback(
    (customer: CustomerReadModel) => handleLifecycle(customer, "restore"),
    [handleLifecycle]
  );

  const handleResetOrganization = useCallback(() => {
    clearSavedOrganizationId();
    setOrganizationId(null);
    setCustomers([]);
    setEditingCustomerId(null);
    setDraft(emptyDraft);
    setNotice("Abra novamente uma organização para acessar os clientes.");
    setError(null);
  }, []);

  return (
    <div className="categories-page customers-page">
      <header className="categories-topbar">
        <a aria-label="Polaris início" className="categories-brand" href="/">
          <span aria-hidden="true" className="categories-brand-mark">
            P
          </span>
          <span>Polaris</span>
        </a>
        <nav aria-label="Navegação principal" className="catalog-switcher">
          <a href="/">Categorias</a>
          <a href="/products">Produtos</a>
          <a aria-current="page" href="/customers">
            Clientes
          </a>
        </nav>
      </header>

      <main className="categories-content customers-content">
        {organizationId ? (
          <CustomerWorkspace
            customers={customers}
            draft={draft}
            editingCustomer={editingCustomer}
            error={error}
            isLoading={isLoading}
            notice={notice}
            onArchive={handleArchive}
            onCancelEdit={handleCancelEdit}
            onChange={handleDraftChange}
            onEdit={handleEdit}
            onResetOrganization={handleResetOrganization}
            onRestore={handleRestore}
            onStatusClick={handleStatusClick}
            onSubmit={handleSubmit}
            pendingAction={pendingAction}
            status={status}
          />
        ) : (
          <section
            aria-labelledby="customer-organization-title"
            className="customer-organization-prompt"
          >
            <p className="categories-eyebrow">Primeiro acesso</p>
            <h1 id="customer-organization-title">Abra uma organização</h1>
            <p className="categories-intro-copy">
              Os cadastros de clientes pertencem a uma organização. Abra ou crie
              uma organização antes de continuar.
            </p>
            <a className="primary-button" href="/">
              Ir para categorias
            </a>
          </section>
        )}
      </main>
    </div>
  );
}
