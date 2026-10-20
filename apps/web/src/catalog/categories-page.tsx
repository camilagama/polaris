import {
  type CategoryReadModel,
  categoryNameCodePointLength,
} from "@polaris/contracts";
import {
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import "./categories-page.css";

type CategoryListStatus = "active" | "archived" | "deleted";
type CategoryAction = "archive" | "restore" | "delete";
type CategoryButtonAction =
  | CategoryAction
  | "delete-cancel"
  | "delete-start"
  | "rename-cancel"
  | "rename-start";

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

function rpcErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function errorMessage(
  error: unknown,
  action?: CategoryAction | "create" | "rename"
): string {
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return action === undefined
      ? "Não foi possível carregar as categorias."
      : "A categoria não foi alterada.";
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

function CategoriesHeading() {
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
          aria-describedby="category-name-count"
          aria-invalid={isNameTooLong}
          autoComplete="off"
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
  isArchivePending: boolean;
  isDeletePending: boolean;
  isDeleteRequested: boolean;
  isRenamePending: boolean;
  isRenaming: boolean;
  isRestorePending: boolean;
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
            aria-describedby={`rename-category-count-${category.id}`}
            aria-invalid={isNameTooLong}
            autoFocus
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
              isDeleteRequested={props.pendingDeleteId === category.id}
              isRenamePending={props.pendingAction === `rename:${category.id}`}
              isRenaming={props.renamingCategoryId === category.id}
              isRestorePending={
                props.pendingAction === `restore:${category.id}`
              }
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
  const { organizationId } = useCurrentOrganization();
  const [categoryName, setCategoryName] = useState("");
  const [status, setStatus] = useState<CategoryListStatus>("active");
  const [categories, setCategories] = useState<CategoryReadModel[]>([]);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(
    null
  );
  const [renameValue, setRenameValue] = useState("");
  // typed and not sent: a new name, or a rename that differs from the current name
  const renamedCategory = categories.find(
    (item) => item.id === renamingCategoryId
  );
  useReportUnsentWork(
    categoryName.trim() !== "" ||
      (renamedCategory !== undefined && renameValue !== renamedCategory.name)
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
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

  const handleCreateCategory = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
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

  return (
    <>
      <CategoriesHeading />
      <CategoryTabs onClick={handleStatusClick} status={status} />
      {status === "active" ? (
        <CategoryCreateForm
          isPending={pendingAction === "create"}
          name={categoryName}
          onNameChange={handleCategoryNameChange}
          onSubmit={handleCreateCategory}
        />
      ) : null}

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

      {import.meta.env.DEV ? (
        <a className="offline-lab-link" href="/offline-poc?release=1">
          Abrir laboratório de persistência offline
        </a>
      ) : null}
    </>
  );
}
