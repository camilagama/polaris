import {
  categoryNameCodePointLength,
  type CategoryReadModel,
} from "@polaris/contracts";
import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import { orpcClient } from "../lib/orpc";
import "./categories-page.css";

type CategoryListStatus = "active" | "archived" | "deleted";
type CategoryAction = "archive" | "restore" | "delete";
type CategoryButtonAction =
  | CategoryAction
  | "delete-cancel"
  | "delete-start"
  | "rename-cancel"
  | "rename-start";

const organizationIdStorageKey = "polaris.organizationId";
const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });
const statusLabels: Record<CategoryReadModel["status"], string> = {
  active: "Ativa",
  archived: "Arquivada",
  deleted: "Removida",
};
const listStatuses: ReadonlyArray<readonly [CategoryListStatus, string]> = [
  ["active", "Ativas"],
  ["archived", "Arquivadas"],
  ["deleted", "Removidas"],
];

function savedOrganizationId(): string | null {
  try {
    return window.localStorage.getItem(organizationIdStorageKey);
  } catch {
    return null;
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
  action?: CategoryAction | "create" | "rename" | "setup"
): string {
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return "Sua sessão não está ativa. Entre novamente para acessar o catálogo.";
  }
  if (code === "FORBIDDEN" && action === "setup") {
    return "Verifique seu email antes de criar ou abrir uma organização.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  if (code === "CONFLICT" && (action === "create" || action === "rename")) {
    return "Já existe uma categoria com esse nome nesta organização.";
  }
  if (code === "CONFLICT" && action === "restore") {
    return "Categorias removidas não podem ser restauradas.";
  }
  if (code === "CONFLICT" && action === "delete") {
    return "Desvincule os produtos desta categoria antes de removê-la.";
  }
  if (code === "CONFLICT") {
    return "O estado da categoria mudou. Atualize a lista e tente novamente.";
  }
  if (code === "NOT_FOUND") {
    return "A categoria não existe mais nesta organização.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O catálogo está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function categoryNameCountLabel(name: string): string {
  const count = categoryNameCodePointLength(name);
  return count > 100
    ? `Limite de 100 caracteres excedido (${count}).`
    : `${count}/100 caracteres`;
}

function categoryNameIsTooLong(name: string): boolean {
  return categoryNameCodePointLength(name) > 100;
}

function initialTimezone(): string {
  return (
    Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo"
  );
}

function isCategoryListStatus(value: string): value is CategoryListStatus {
  return value === "active" || value === "archived" || value === "deleted";
}

function isCategoryButtonAction(
  value: string | undefined
): value is CategoryButtonAction {
  switch (value) {
    case "archive":
    case "delete":
    case "delete-cancel":
    case "delete-start":
    case "rename-cancel":
    case "rename-start":
    case "restore":
      return true;
    default:
      return false;
  }
}

interface OrganizationSetupProps {
  isPending: boolean;
  name: string;
  onNameChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTimezoneChange: (event: ChangeEvent<HTMLInputElement>) => void;
  timezone: string;
}

function OrganizationSetup({
  isPending,
  name,
  onNameChange,
  onSubmit,
  onTimezoneChange,
  timezone,
}: OrganizationSetupProps) {
  return (
    <section aria-labelledby="organization-setup-title" className="setup-card">
      <p className="categories-eyebrow">Primeiro acesso</p>
      <h1 id="organization-setup-title">Abra o catálogo da organização</h1>
      <p className="categories-intro-copy">
        Use uma sessão autenticada e verificada. Se a organização já existir,
        ela será aberta sem alterar seus dados.
      </p>
      <form className="setup-form" onSubmit={onSubmit}>
        <label className="field-label" htmlFor="organization-name">
          Nome da organização
        </label>
        <input
          autoComplete="organization"
          id="organization-name"
          maxLength={128}
          onChange={onNameChange}
          placeholder="Ex.: Loja Horizonte"
          required
          value={name}
        />
        <label className="field-label" htmlFor="organization-timezone">
          Fuso horário da organização
        </label>
        <input
          autoComplete="off"
          id="organization-timezone"
          maxLength={64}
          onChange={onTimezoneChange}
          required
          value={timezone}
        />
        <p className="field-help">
          Use um identificador IANA, como America/Sao_Paulo.
        </p>
        <button className="primary-button" disabled={isPending} type="submit">
          {isPending ? "Abrindo…" : "Criar ou abrir organização"}
        </button>
      </form>
    </section>
  );
}

interface CategoriesHeadingProps {
  onResetOrganization: () => void;
}

function CategoriesHeading({ onResetOrganization }: CategoriesHeadingProps) {
  return (
    <section className="categories-heading">
      <div>
        <p className="categories-eyebrow">Gestão de catálogo</p>
        <h1>Categorias</h1>
        <p className="categories-intro-copy">
          Agrupe produtos para manter o catálogo fácil de consultar. Categorias
          de despesas pertencem a outra área do produto.
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
  );
}

interface CategoryTabsProps {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  status: CategoryListStatus;
}

function CategoryTabs({ onClick, status }: CategoryTabsProps) {
  return (
    <nav aria-label="Estado das categorias" className="category-tabs">
      {listStatuses.map(([value, label]) => (
        <button
          aria-pressed={status === value}
          className={
            status === value ? "category-tab is-selected" : "category-tab"
          }
          data-category-status={value}
          key={value}
          onClick={onClick}
          type="button"
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

interface CategoryCreateFormProps {
  isPending: boolean;
  name: string;
  onNameChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function CategoryCreateForm({
  isPending,
  name,
  onNameChange,
  onSubmit,
}: CategoryCreateFormProps) {
  const isNameTooLong = categoryNameIsTooLong(name);

  return (
    <form className="category-create-form" onSubmit={onSubmit}>
      <div className="category-create-field">
        <label className="field-label" htmlFor="category-name">
          Nova categoria
        </label>
        <input
          autoComplete="off"
          aria-describedby="category-name-count"
          aria-invalid={isNameTooLong}
          id="category-name"
          onChange={onNameChange}
          placeholder="Ex.: Acessórios"
          required
          value={name}
        />
        <span
          className="field-help"
          id="category-name-count"
          role={isNameTooLong ? "alert" : undefined}
        >
          {categoryNameCountLabel(name)}
        </span>
      </div>
      <button
        className="primary-button"
        disabled={isPending || isNameTooLong}
        type="submit"
      >
        {isPending ? "Salvando…" : "Adicionar categoria"}
      </button>
    </form>
  );
}

interface CategoryRowProps {
  category: CategoryReadModel;
  isDeletePending: boolean;
  isRenamePending: boolean;
  isArchivePending: boolean;
  isRestorePending: boolean;
  isRenaming: boolean;
  isDeleteRequested: boolean;
  onActionClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onRenameChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRenameSubmit: (event: FormEvent<HTMLFormElement>) => void;
  renameValue: string;
}

function CategoryActionsCell(props: CategoryRowProps) {
  const {
    category,
    isArchivePending,
    isDeletePending,
    isDeleteRequested,
    isRenamePending,
    isRestorePending,
    isRenaming,
    onActionClick,
    onRenameChange,
    onRenameSubmit,
    renameValue,
  } = props;

  if (category.status === "deleted") {
    return (
      <span className="tombstone-note">
        Histórico preservado; não pode ser restaurada
      </span>
    );
  }
  if (isRenaming) {
    const isNameTooLong = categoryNameIsTooLong(renameValue);

    return (
      <form
        className="category-inline-rename"
        data-category-id={category.id}
        onSubmit={onRenameSubmit}
      >
        <label
          className="visually-hidden"
          htmlFor={`rename-category-${category.id}`}
        >
          Novo nome para {category.name}
        </label>
        <div className="category-rename-field">
          <input
            autoFocus
            aria-describedby={`rename-category-count-${category.id}`}
            aria-invalid={isNameTooLong}
            id={`rename-category-${category.id}`}
            onChange={onRenameChange}
            required
            value={renameValue}
          />
          <span
            className="field-help"
            id={`rename-category-count-${category.id}`}
            role={isNameTooLong ? "alert" : undefined}
          >
            {categoryNameCountLabel(renameValue)}
          </span>
        </div>
        <button
          className="primary-button"
          disabled={isRenamePending || isNameTooLong}
          type="submit"
        >
          Salvar
        </button>
        <button
          className="quiet-button"
          data-category-action="rename-cancel"
          data-category-id={category.id}
          onClick={onActionClick}
          type="button"
        >
          Cancelar
        </button>
      </form>
    );
  }
  if (isDeleteRequested) {
    return (
      <fieldset className="delete-confirmation">
        <legend className="visually-hidden">
          Confirmar remoção de {category.name}
        </legend>
        <span>
          A remoção é permanente na lista; o histórico e o nome ficam
          preservados.
        </span>
        <button
          className="danger-button"
          data-category-action="delete"
          data-category-id={category.id}
          disabled={isDeletePending}
          onClick={onActionClick}
          type="button"
        >
          Confirmar remoção
        </button>
        <button
          className="quiet-button"
          data-category-action="delete-cancel"
          data-category-id={category.id}
          onClick={onActionClick}
          type="button"
        >
          Cancelar
        </button>
      </fieldset>
    );
  }

  const isActive = category.status === "active";
  return (
    <div className="category-actions">
      <button
        className="quiet-button"
        data-category-action="rename-start"
        data-category-id={category.id}
        onClick={onActionClick}
        type="button"
      >
        Renomear
      </button>
      <button
        className="quiet-button"
        data-category-action={isActive ? "archive" : "restore"}
        data-category-id={category.id}
        disabled={isActive ? isArchivePending : isRestorePending}
        onClick={onActionClick}
        type="button"
      >
        {isActive ? "Arquivar" : "Restaurar"}
      </button>
      <button
        className="danger-text-button"
        data-category-action="delete-start"
        data-category-id={category.id}
        onClick={onActionClick}
        type="button"
      >
        Remover
      </button>
    </div>
  );
}

function CategoryRow(props: CategoryRowProps) {
  const { category } = props;
  return (
    <tr>
      <td data-label="Categoria">
        <span className="category-name">{category.name}</span>
        <span className="category-id">{category.id.slice(0, 8)}</span>
      </td>
      <td data-label="Estado">
        <span className={`category-status status-${category.status}`}>
          {statusLabels[category.status]}
        </span>
      </td>
      <td data-label="Criada">{formatDate(category.createdAt)}</td>
      <td data-label="Atualizada">{formatDate(category.updatedAt)}</td>
      <td className="category-actions-cell" data-label="Ações">
        <CategoryActionsCell {...props} />
      </td>
    </tr>
  );
}

interface CategoryListPanelProps {
  categories: CategoryReadModel[];
  isLoading: boolean;
  onActionClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onRenameChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRenameSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pendingAction: string | null;
  pendingDeleteId: string | null;
  renameValue: string;
  renamingCategoryId: string | null;
  status: CategoryListStatus;
}

const titlesByStatus: Record<CategoryListStatus, string> = {
  active: "Categorias ativas",
  archived: "Categorias arquivadas",
  deleted: "Categorias removidas",
};

const emptyTextByStatus: Record<CategoryListStatus, string> = {
  active: "Nenhuma categoria ativa. Adicione a primeira categoria do catálogo.",
  archived: "Não há categorias arquivadas.",
  deleted: "Não há categorias removidas.",
};

function CategoryListContent(props: CategoryListPanelProps) {
  const { categories, isLoading, onActionClick, status } = props;
  if (isLoading) {
    return (
      <p className="category-empty-state" role="status">
        Carregando categorias…
      </p>
    );
  }
  if (categories.length === 0) {
    return <p className="category-empty-state">{emptyTextByStatus[status]}</p>;
  }

  return (
    <div className="category-table-wrap">
      <table className="category-table">
        <caption className="visually-hidden">
          Lista de categorias do catálogo: {statusLabels[status]}
        </caption>
        <thead>
          <tr>
            <th scope="col">Categoria</th>
            <th scope="col">Estado</th>
            <th scope="col">Criada</th>
            <th scope="col">Atualizada</th>
            <th scope="col">
              <span className="visually-hidden">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <CategoryRow
              category={category}
              isArchivePending={
                props.pendingAction === `archive:${category.id}`
              }
              isDeletePending={props.pendingAction === `delete:${category.id}`}
              isRestorePending={
                props.pendingAction === `restore:${category.id}`
              }
              isDeleteRequested={props.pendingDeleteId === category.id}
              isRenamePending={props.pendingAction === `rename:${category.id}`}
              isRenaming={props.renamingCategoryId === category.id}
              key={category.id}
              onActionClick={onActionClick}
              onRenameChange={props.onRenameChange}
              onRenameSubmit={props.onRenameSubmit}
              renameValue={props.renameValue}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryListPanel(props: CategoryListPanelProps) {
  const { categories, isLoading, status } = props;
  return (
    <section
      aria-labelledby="category-list-heading"
      className="category-list-panel"
    >
      <div className="category-list-heading">
        <div>
          <p className="categories-eyebrow">Organização ativa</p>
          <h2 id="category-list-heading">{titlesByStatus[status]}</h2>
        </div>
        <span className="category-count">
          {isLoading ? "Carregando" : categories.length}
        </span>
      </div>
      <CategoryListContent {...props} />
    </section>
  );
}

export function CategoriesPage() {
  const [organizationId, setOrganizationId] = useState<string | null>(
    savedOrganizationId
  );
  const [organizationName, setOrganizationName] = useState("");
  const [timezone, setTimezone] = useState(initialTimezone);
  const [categoryName, setCategoryName] = useState("");
  const [status, setStatus] = useState<CategoryListStatus>("active");
  const [categories, setCategories] = useState<CategoryReadModel[]>([]);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(
    null
  );
  const [renameValue, setRenameValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!organizationId) {
      setCategories([]);
      setIsLoading(false);
      return;
    }

    let current = true;
    setIsLoading(true);
    setError(null);
    orpcClient.category
      .list({ organizationId, status })
      .then(({ categories: result }) => {
        if (current) {
          setCategories(result);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (current) {
          setIsLoading(false);
        }
      });

    return () => {
      current = false;
    };
  }, [organizationId, refreshVersion, status]);

  const handleOrganizationNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setOrganizationName(event.currentTarget.value);
    },
    []
  );
  const handleTimezoneChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setTimezone(event.currentTarget.value);
    },
    []
  );
  const handleCategoryNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setCategoryName(event.currentTarget.value);
    },
    []
  );
  const handleRenameValueChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setRenameValue(event.currentTarget.value);
    },
    []
  );

  const handleOpenOrganization = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPendingAction("organization");
      setError(null);
      setNotice(null);
      try {
        const result = await orpcClient.organization.createInitial({
          name: organizationName,
          timezone,
        });
        let storageFailure = false;
        try {
          window.localStorage.setItem(
            organizationIdStorageKey,
            result.organization.id
          );
        } catch {
          storageFailure = true;
        }
        setOrganizationId(result.organization.id);
        let successMessage =
          "Sua organização existente foi aberta; os dados enviados não a alteraram.";
        if (result.created) {
          successMessage = "Organização criada. O catálogo já pode ser usado.";
        }
        if (storageFailure) {
          successMessage =
            "Organização aberta; este navegador não conseguiu salvar a seleção.";
        }
        setNotice(successMessage);
      } catch (cause: unknown) {
        setError(errorMessage(cause, "setup"));
      } finally {
        setPendingAction(null);
      }
    },
    [organizationName, timezone]
  );

  const handleCreateCategory = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!organizationId) {
        return;
      }
      if (categoryNameIsTooLong(categoryName)) {
        setError("O nome da categoria deve ter no máximo 100 caracteres.");
        return;
      }
      setPendingAction("create");
      setError(null);
      setNotice(null);
      try {
        const category = await orpcClient.category.create({
          name: categoryName,
          organizationId,
        });
        setCategoryName("");
        setNotice(`Categoria “${category.name}” criada.`);
        setRefreshVersion((version) => version + 1);
      } catch (cause: unknown) {
        setError(errorMessage(cause, "create"));
      } finally {
        setPendingAction(null);
      }
    },
    [categoryName, organizationId]
  );

  const handleCategoryAction = useCallback(
    async (category: CategoryReadModel, action: CategoryAction) => {
      if (!organizationId) {
        return;
      }
      setPendingAction(`${action}:${category.id}`);
      setError(null);
      setNotice(null);
      try {
        const input = { id: category.id, organizationId };
        const result = await orpcClient.category[action](input);
        const messages: Record<CategoryAction, string> = {
          archive: `Categoria “${result.category.name}” arquivada.`,
          delete: `Categoria “${result.category.name}” removida; o registro de histórico foi preservado.`,
          restore: `Categoria “${result.category.name}” restaurada.`,
        };
        setNotice(
          result.changed
            ? messages[action]
            : `A categoria “${result.category.name}” já estava nesse estado.`
        );
        setPendingDeleteId(null);
        setRefreshVersion((version) => version + 1);
      } catch (cause: unknown) {
        setError(errorMessage(cause, action));
      } finally {
        setPendingAction(null);
      }
    },
    [organizationId]
  );

  const handleRenameCategory = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const { categoryId } = event.currentTarget.dataset;
      if (!organizationId) {
        return;
      }
      if (!categoryId) {
        return;
      }
      if (categoryNameIsTooLong(renameValue)) {
        setError("O nome da categoria deve ter no máximo 100 caracteres.");
        return;
      }
      setPendingAction(`rename:${categoryId}`);
      setError(null);
      setNotice(null);
      try {
        const result = await orpcClient.category.rename({
          id: categoryId,
          name: renameValue,
          organizationId,
        });
        setNotice(
          result.changed
            ? `Categoria renomeada para “${result.category.name}”.`
            : `O nome da categoria continua “${result.category.name}”.`
        );
        setRenamingCategoryId(null);
        setRenameValue("");
        setRefreshVersion((version) => version + 1);
      } catch (cause: unknown) {
        setError(errorMessage(cause, "rename"));
      } finally {
        setPendingAction(null);
      }
    },
    [organizationId, renameValue]
  );

  const handleCategoryActionClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { categoryAction, categoryId } = event.currentTarget.dataset;
      if (!categoryId) {
        return;
      }
      if (!isCategoryButtonAction(categoryAction)) {
        return;
      }

      const category = categories.find((item) => item.id === categoryId);
      if (!category) {
        return;
      }

      switch (categoryAction) {
        case "archive":
        case "restore":
        case "delete":
          handleCategoryAction(category, categoryAction).catch(() => undefined);
          break;
        case "delete-start":
          setPendingDeleteId(category.id);
          setRenamingCategoryId(null);
          setRenameValue("");
          break;
        case "delete-cancel":
          setPendingDeleteId(null);
          break;
        case "rename-start":
          setRenamingCategoryId(category.id);
          setRenameValue(category.name);
          setPendingDeleteId(null);
          break;
        case "rename-cancel":
          setRenamingCategoryId(null);
          setRenameValue("");
          break;
        default:
          return;
      }
    },
    [categories, handleCategoryAction]
  );

  const handleStatusClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { categoryStatus } = event.currentTarget.dataset;
      if (!categoryStatus) {
        return;
      }
      if (!isCategoryListStatus(categoryStatus)) {
        return;
      }
      setStatus(categoryStatus);
      setPendingDeleteId(null);
      setRenamingCategoryId(null);
    },
    []
  );

  const handleResetOrganization = useCallback(() => {
    try {
      window.localStorage.removeItem(organizationIdStorageKey);
    } catch {
      setError("Não foi possível limpar a organização salva neste navegador.");
      return;
    }
    setOrganizationId(null);
    setCategories([]);
    setPendingDeleteId(null);
    setRenamingCategoryId(null);
    setRenameValue("");
    setNotice("Selecione ou crie a organização novamente.");
    setError(null);
  }, []);

  return (
    <div className="categories-page">
      <header className="categories-topbar">
        <a aria-label="Polaris início" className="categories-brand" href="/">
          <span aria-hidden="true" className="categories-brand-mark">
            P
          </span>
          <span>Polaris</span>
        </a>
        <nav aria-label="Catálogo" className="catalog-switcher">
          <a aria-current="page" href="/">
            Categorias
          </a>
          <a href="/products">Produtos</a>
          <a href="/customers">Clientes</a>
        </nav>
      </header>

      <main className="categories-content">
        {organizationId ? (
          <>
            <CategoriesHeading onResetOrganization={handleResetOrganization} />
            <CategoryTabs onClick={handleStatusClick} status={status} />
            {status === "active" ? (
              <CategoryCreateForm
                isPending={pendingAction === "create"}
                name={categoryName}
                onNameChange={handleCategoryNameChange}
                onSubmit={handleCreateCategory}
              />
            ) : null}
          </>
        ) : (
          <OrganizationSetup
            isPending={pendingAction === "organization"}
            name={organizationName}
            onNameChange={handleOrganizationNameChange}
            onSubmit={handleOpenOrganization}
            onTimezoneChange={handleTimezoneChange}
            timezone={timezone}
          />
        )}

        {error ? (
          <p className="categories-message is-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="categories-message is-success" role="status">
            {notice}
          </p>
        ) : null}

        {organizationId ? (
          <CategoryListPanel
            categories={categories}
            isLoading={isLoading}
            onActionClick={handleCategoryActionClick}
            onRenameChange={handleRenameValueChange}
            onRenameSubmit={handleRenameCategory}
            pendingAction={pendingAction}
            pendingDeleteId={pendingDeleteId}
            renameValue={renameValue}
            renamingCategoryId={renamingCategoryId}
            status={status}
          />
        ) : null}

        {import.meta.env.DEV ? (
          <a className="offline-lab-link" href="/offline-poc?release=1">
            Abrir laboratório de persistência offline
          </a>
        ) : null}
      </main>
    </div>
  );
}
