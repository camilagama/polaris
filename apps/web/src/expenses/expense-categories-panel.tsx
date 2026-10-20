import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { MAX_EXPENSE_CATEGORY_NAME_LENGTH } from "@polaris/domain/expenses/expense";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import {
  EXPENSE_GROUP_ORDER,
  type ExpenseGroupKey,
  groupCategories,
} from "./expense-model";
import { FeedbackMessage } from "./feedback-message";
import { type CommandOutcome, useCommandRunner } from "./use-command-runner";
import type { ExpenseCategoriesState } from "./use-expense-categories";

interface ExpenseCategoriesPanelProps {
  onReload: () => Promise<void>;
  onUpsert: (category: ExpenseCategoryReadModel) => void;
  organizationId: string;
  state: ExpenseCategoriesState;
}

interface CategoryRowProps {
  busyKey: string | null;
  category: ExpenseCategoryReadModel;
  onRename: (
    category: ExpenseCategoryReadModel,
    name: string
  ) => Promise<boolean>;
  onToggle: (category: ExpenseCategoryReadModel) => void;
}

function CategoryRow({
  busyKey,
  category,
  onRename,
  onToggle,
}: CategoryRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(category.name);
  useReportUnsentWork(renaming && name !== category.name);
  const isBusy = busyKey !== null;
  const archived = category.status === "archived";
  const nameFieldId = `expense-category-name-${category.id}`;

  const handleStart = useCallback(() => {
    setName(category.name);
    setRenaming(true);
  }, [category.name]);
  const handleCancel = useCallback(() => setRenaming(false), []);
  const handleName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setName(event.currentTarget.value),
    []
  );
  const handleToggle = useCallback(
    () => onToggle(category),
    [category, onToggle]
  );
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (name.trim() === category.name) {
        setRenaming(false);
        return;
      }
      if (await onRename(category, name)) {
        setRenaming(false);
      }
    },
    [category, name, onRename]
  );

  if (renaming) {
    return (
      <form className="expense-category-rename" onSubmit={handleSubmit}>
        <label className="visually-hidden" htmlFor={nameFieldId}>
          Novo nome da categoria {category.name}
        </label>
        <input
          autoComplete="off"
          disabled={isBusy}
          id={nameFieldId}
          maxLength={MAX_EXPENSE_CATEGORY_NAME_LENGTH}
          onChange={handleName}
          required
          value={name}
        />
        <button className="primary-button" disabled={isBusy} type="submit">
          Salvar
        </button>
        <button
          className="quiet-button"
          disabled={isBusy}
          onClick={handleCancel}
          type="button"
        >
          Cancelar
        </button>
      </form>
    );
  }

  return (
    <div className="expense-category-row">
      <span className="expense-category-name">{category.name}</span>
      {archived ? (
        <span className="category-status status-archived">Arquivada</span>
      ) : null}
      <span className="expense-category-actions">
        <button
          aria-label={`Renomear categoria ${category.name}`}
          className="quiet-button"
          disabled={isBusy}
          onClick={handleStart}
          type="button"
        >
          Renomear
        </button>
        <button
          aria-label={`${archived ? "Restaurar" : "Arquivar"} categoria ${category.name}`}
          className="quiet-button"
          disabled={isBusy}
          onClick={handleToggle}
          type="button"
        >
          {archived ? "Restaurar" : "Arquivar"}
        </button>
      </span>
    </div>
  );
}

interface NewCategoryFormProps {
  busy: boolean;
  onCreate: (group: ExpenseGroupKey, name: string) => Promise<boolean>;
}

function NewCategoryForm({ busy, onCreate }: NewCategoryFormProps) {
  const [group, setGroup] = useState<ExpenseGroupKey>("operational");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useReportUnsentWork(name.trim() !== "");

  const handleGroup = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const match = EXPENSE_GROUP_ORDER.find(
      (item) => item.key === event.currentTarget.value
    );
    if (match) {
      setGroup(match.key);
    }
  }, []);
  const handleName = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setName(event.currentTarget.value);
    setError(null);
  }, []);
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (name.trim() === "") {
        setError("Informe o nome da categoria.");
        return;
      }
      if (await onCreate(group, name)) {
        setName("");
      }
    },
    [group, name, onCreate]
  );

  return (
    <form className="expense-category-form" noValidate onSubmit={handleSubmit}>
      <div className="expense-field">
        <label className="field-label" htmlFor="expense-new-category-group">
          Grupo
        </label>
        <select
          className="expense-select"
          disabled={busy}
          id="expense-new-category-group"
          onChange={handleGroup}
          value={group}
        >
          {EXPENSE_GROUP_ORDER.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <div className="expense-field">
        <label className="field-label" htmlFor="expense-new-category-name">
          Nome da categoria
        </label>
        <input
          aria-describedby={error ? "expense-new-category-error" : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          disabled={busy}
          id="expense-new-category-name"
          maxLength={MAX_EXPENSE_CATEGORY_NAME_LENGTH}
          onChange={handleName}
          value={name}
        />
        {error ? (
          <p className="field-error" id="expense-new-category-error">
            {error}
          </p>
        ) : null}
      </div>
      <button className="primary-button" disabled={busy} type="submit">
        Adicionar categoria
      </button>
    </form>
  );
}

function useCategoryCommands({
  onReload,
  onUpsert,
  organizationId,
}: Omit<ExpenseCategoriesPanelProps, "state">) {
  const { busy, feedback, run } = useCommandRunner();

  const settle = useCallback(
    async (outcome: CommandOutcome) => {
      if (outcome === "conflict") {
        await onReload();
      }
      return outcome === "ok";
    },
    [onReload]
  );

  const create = useCallback(
    async (group: ExpenseGroupKey, name: string) =>
      settle(
        await run("create", "category-create", async () => {
          onUpsert(
            await orpcClient.expense.createCategory({
              group,
              name,
              organizationId,
            })
          );
          return "Categoria criada.";
        })
      ),
    [onUpsert, organizationId, run, settle]
  );

  const rename = useCallback(
    async (category: ExpenseCategoryReadModel, name: string) =>
      settle(
        await run(`rename:${category.id}`, "category-rename", async () => {
          const result = await orpcClient.expense.renameCategory({
            expectedVersion: category.version,
            id: category.id,
            name,
            organizationId,
          });
          onUpsert(result.category);
          return "Categoria renomeada.";
        })
      ),
    [onUpsert, organizationId, run, settle]
  );

  const toggle = useCallback(
    async (category: ExpenseCategoryReadModel) => {
      const archiving = category.status === "active";
      const input = {
        expectedVersion: category.version,
        id: category.id,
        organizationId,
      };
      await settle(
        await run(
          `toggle:${category.id}`,
          archiving ? "category-archive" : "category-restore",
          async () => {
            const result = archiving
              ? await orpcClient.expense.archiveCategory(input)
              : await orpcClient.expense.restoreCategory(input);
            onUpsert(result.category);
            return archiving ? "Categoria arquivada." : "Categoria restaurada.";
          }
        )
      );
    },
    [onUpsert, organizationId, run, settle]
  );

  return { busy, create, feedback, rename, toggle };
}

/** Secondary section: the categories of the organization, by group. */
export function ExpenseCategoriesPanel({
  onReload,
  onUpsert,
  organizationId,
  state,
}: ExpenseCategoriesPanelProps) {
  const [showArchived, setShowArchived] = useState(false);
  const { busy, create, feedback, rename, toggle } = useCategoryCommands({
    onReload,
    onUpsert,
    organizationId,
  });
  const sections = useMemo(
    () =>
      groupCategories(
        state.categories.filter(
          (category) => showArchived || category.status === "active"
        )
      ),
    [showArchived, state.categories]
  );
  const handleShowArchived = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setShowArchived(event.currentTarget.checked),
    []
  );

  return (
    <details className="expense-panel expense-categories">
      <summary>
        <span className="categories-eyebrow">Organização</span>
        <span className="expense-categories-title">Categorias de despesa</span>
      </summary>
      <div aria-busy={state.isLoading} className="expense-categories-body">
        <FeedbackMessage feedback={feedback} />
        <label className="expense-checkbox">
          <input
            checked={showArchived}
            onChange={handleShowArchived}
            type="checkbox"
          />
          Mostrar categorias arquivadas
        </label>
        {state.isLoading && state.categories.length === 0 ? (
          <p className="expense-empty-state" role="status">
            Carregando categorias…
          </p>
        ) : null}
        {sections.map((section) => (
          <section
            aria-labelledby={`expense-group-${section.key}`}
            className="expense-category-group"
            key={section.key}
          >
            <h3 id={`expense-group-${section.key}`}>{section.label}</h3>
            <ul>
              {section.items.map((category) => (
                <li key={category.id}>
                  <CategoryRow
                    busyKey={busy}
                    category={category}
                    onRename={rename}
                    onToggle={toggle}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
        <NewCategoryForm busy={busy !== null} onCreate={create} />
      </div>
    </details>
  );
}
