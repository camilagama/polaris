import type { CategoryReadModel } from "@polaris/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import {
  type CategoryAction,
  type CategoryListStatus,
  categoryActionNotice,
  categoryErrorMessage,
  categoryNameIsTooLong,
  NAME_TOO_LONG,
  STATUS_OPTIONS,
} from "./categories-model";
import { CategoryForm } from "./category-form";
import { CategoryList } from "./category-list";
import { ActionFeedback, LoadErrorNotice } from "./products-page-parts";
import { StatusNav } from "./screen-parts";

/**
 * Categorias on the interface v5.1 (components of `src/ui`, no sheet of its own). It works only with a connection:
 * it reads and writes on the server, so the strip of the offline notice says so (U-54).
 */
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
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);

  // typed and not sent: a new name, or a rename that differs from the current name
  const renamedCategory = categories.find(
    (item) => item.id === renamingCategoryId
  );
  useReportUnsentWork(
    categoryName.trim() !== "" ||
      (renamedCategory !== undefined && renameValue !== renamedCategory.name)
  );

  /**
   * The result of an action on a row is said at the top of the screen, and a person far down the list is taken to it
   * (the row is gone: the menu, the rename form, the confirmation). A new category is made beside the message, where
   * the focus already is.
   */
  const [feedbackFocus, setFeedbackFocus] = useState(0);
  const focusFeedback = useCallback(
    () => setFeedbackFocus((count) => count + 1),
    []
  );
  useEffect(() => {
    if (feedbackFocus > 0) {
      feedbackRef.current?.focus();
    }
  }, [feedbackFocus]);

  useEffect(() => {
    let current = true;
    setIsLoading(true);
    setLoadError(null);
    orpcClient.category
      .list({ organizationId, status })
      .then(({ categories: result }) => {
        if (current) {
          setCategories(result);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setLoadError(categoryErrorMessage(cause));
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

  const refresh = useCallback(
    () => setRefreshVersion((version) => version + 1),
    []
  );

  const handleCreate = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (categoryNameIsTooLong(categoryName)) {
        setError(NAME_TOO_LONG);
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
        refresh();
      } catch (cause: unknown) {
        setError(categoryErrorMessage(cause, "create"));
      } finally {
        // the focus stays in the field, beside the message: a new name can be typed at once
        setPendingAction(null);
      }
    },
    [categoryName, organizationId, refresh]
  );

  const runAction = useCallback(
    async (category: CategoryReadModel, action: CategoryAction) => {
      setPendingAction(`${action}:${category.id}`);
      setError(null);
      setNotice(null);
      try {
        const result = await orpcClient.category[action]({
          id: category.id,
          organizationId,
        });
        setNotice(
          categoryActionNotice(action, result.category.name, result.changed)
        );
        setPendingDeleteId(null);
        refresh();
      } catch (cause: unknown) {
        setError(categoryErrorMessage(cause, action));
      } finally {
        setPendingAction(null);
        focusFeedback();
      }
    },
    [focusFeedback, organizationId, refresh]
  );
  const handleArchive = useCallback(
    (category: CategoryReadModel) => runAction(category, "archive"),
    [runAction]
  );
  const handleRestore = useCallback(
    (category: CategoryReadModel) => runAction(category, "restore"),
    [runAction]
  );
  const handleDelete = useCallback(
    (category: CategoryReadModel) => runAction(category, "delete"),
    [runAction]
  );

  const handleRenameSubmit = useCallback(
    async (category: CategoryReadModel) => {
      if (categoryNameIsTooLong(renameValue)) {
        setError(NAME_TOO_LONG);
        focusFeedback();
        return;
      }
      setPendingAction(`rename:${category.id}`);
      setError(null);
      setNotice(null);
      try {
        const result = await orpcClient.category.rename({
          id: category.id,
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
        refresh();
      } catch (cause: unknown) {
        setError(categoryErrorMessage(cause, "rename"));
      } finally {
        setPendingAction(null);
        focusFeedback();
      }
    },
    [focusFeedback, organizationId, refresh, renameValue]
  );

  const handleRenameStart = useCallback((category: CategoryReadModel) => {
    setRenamingCategoryId(category.id);
    setRenameValue(category.name);
    setPendingDeleteId(null);
  }, []);
  const handleRenameCancel = useCallback(() => {
    setRenamingCategoryId(null);
    setRenameValue("");
  }, []);
  const handleDeleteStart = useCallback((category: CategoryReadModel) => {
    setPendingDeleteId(category.id);
    setRenamingCategoryId(null);
    setRenameValue("");
  }, []);
  const handleDeleteCancel = useCallback(() => setPendingDeleteId(null), []);

  const handleStatus = useCallback((next: CategoryListStatus) => {
    setStatus(next);
    setPendingDeleteId(null);
    setRenamingCategoryId(null);
    setError(null);
    setNotice(null);
  }, []);

  return (
    <div
      className="grid gap-4 font-sans text-foreground text-sm antialiased"
      data-ui=""
    >
      <div className="grid gap-1">
        <h1 className="text-title">Categorias</h1>
        <p className="text-muted-foreground text-support">
          Agrupam os produtos do catálogo. As categorias de despesa ficam em
          Despesas.
        </p>
      </div>
      <ActionFeedback error={error} notice={notice} regionRef={feedbackRef} />
      <StatusNav
        disabled={pendingAction !== null}
        label="Estado das categorias"
        onSelect={handleStatus}
        options={STATUS_OPTIONS}
        value={status}
      />
      {status === "active" ? (
        <CategoryForm
          isPending={pendingAction === "create"}
          name={categoryName}
          onNameChange={setCategoryName}
          onSubmit={handleCreate}
        />
      ) : null}
      {loadError ? (
        <LoadErrorNotice message={loadError} onRetry={refresh} />
      ) : (
        <CategoryList
          categories={categories}
          isLoading={isLoading}
          onArchive={handleArchive}
          onDelete={handleDelete}
          onDeleteCancel={handleDeleteCancel}
          onDeleteStart={handleDeleteStart}
          onRenameCancel={handleRenameCancel}
          onRenameChange={setRenameValue}
          onRenameStart={handleRenameStart}
          onRenameSubmit={handleRenameSubmit}
          onRestore={handleRestore}
          pendingAction={pendingAction}
          pendingDeleteId={pendingDeleteId}
          renameValue={renameValue}
          renamingCategoryId={renamingCategoryId}
          status={status}
        />
      )}
    </div>
  );
}
