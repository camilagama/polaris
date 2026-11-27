import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Block } from "@/ui/block";
import { Checkbox } from "@/ui/checkbox";
import { Dialog, DialogContent } from "@/ui/dialog";
import { Field, FieldLabel } from "@/ui/field";
import { ListBlock } from "@/ui/list-block";
import { Skeleton } from "@/ui/skeleton";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { orpcClient } from "../lib/orpc";
import {
  type CategoryDraft,
  ExpenseCategoryForm,
} from "./expense-category-form";
import { ActionNotice } from "./expense-fields";
import { type ExpenseGroupKey, groupCategories } from "./expense-model";
import { type CommandOutcome, useCommandRunner } from "./use-command-runner";
import type { ExpenseCategoriesState } from "./use-expense-categories";
import { useFormDialog } from "./use-form-dialog";

export type CategoryChange = "create" | "update";

interface ExpenseCategoriesPanelProps {
  onReload: () => Promise<void>;
  onUpsert: (
    category: ExpenseCategoryReadModel,
    change: CategoryChange
  ) => void;
  organizationId: string;
  state: ExpenseCategoriesState;
}

interface CategoryRowProps {
  busyKey: string | null;
  category: ExpenseCategoryReadModel;
  onRename: (category: ExpenseCategoryReadModel) => void;
  onToggle: (category: ExpenseCategoryReadModel) => void;
}

function CategoryRow({
  busyKey,
  category,
  onRename,
  onToggle,
}: CategoryRowProps) {
  const isBusy = busyKey !== null;
  const archived = category.status === "archived";
  const online = useConnectionOnline();
  const handleRename = useCallback(
    () => onRename(category),
    [category, onRename]
  );
  const handleToggle = useCallback(
    () => onToggle(category),
    [category, onToggle]
  );

  return (
    <ListBlock.Row
      className="w-0 min-w-full flex-wrap gap-y-2"
      data-category-id={category.id}
    >
      <span className="flex min-w-0 flex-[1_1_10rem] flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
        {category.name}
        {archived ? <Badge variant="warning">Arquivada</Badge> : null}
      </span>
      <span className="flex flex-wrap gap-2">
        <Button
          aria-label={`Renomear categoria ${category.name}`}
          data-category-rename=""
          disabled={isBusy}
          onClick={handleRename}
          size="sm"
          type="button"
          variant="outline"
        >
          Renomear
        </Button>
        <Button
          {...connectionControlProps(online)}
          aria-label={`${archived ? "Restaurar" : "Arquivar"} categoria ${category.name}`}
          disabled={isBusy}
          onClick={handleToggle}
          size="sm"
          type="button"
          variant="outline"
        >
          {archived ? "Restaurar" : "Arquivar"}
        </Button>
      </span>
    </ListBlock.Row>
  );
}

const LOADING_TITLE = "Categorias de despesa";

/** The shape of a row while the categories load: the name, and the two actions at its end. */
function CategoryRowShape() {
  return (
    <div className="flex items-center justify-between gap-3">
      <Skeleton className="h-3.5 w-1/3" />
      <Skeleton className="h-8 w-28" />
    </div>
  );
}

function useCategoryCommands({
  onReload,
  onUpsert,
  organizationId,
}: Omit<ExpenseCategoriesPanelProps, "state">) {
  const { busy, clearFeedback, feedback, run } = useCommandRunner();

  const settle = useCallback(
    async (outcome: CommandOutcome) => {
      if (outcome === "conflict") {
        await onReload();
      }
      return outcome;
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
            }),
            "create"
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
          onUpsert(result.category, "update");
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
            onUpsert(result.category, "update");
            return archiving ? "Categoria arquivada." : "Categoria restaurada.";
          }
        )
      );
    },
    [onUpsert, organizationId, run, settle]
  );

  return { busy, clearFeedback, create, feedback, rename, toggle };
}

/** What opened the form (or, when its row left the list, the button of a new one): "Nova categoria" or the "Renomear" of the category. */
function categoryFormOrigin(next: ExpenseCategoryReadModel | "new") {
  return next === "new"
    ? () => document.querySelector<HTMLElement>("[data-category-new]")
    : () =>
        document.querySelector<HTMLElement>(
          `[data-category-id="${next.id}"] [data-category-rename]`
        ) ?? document.querySelector<HTMLElement>("[data-category-new]");
}

/** The Categorias part of the Despesas tab: the categories of the organization, by group. */
export function ExpenseCategoriesPanel({
  onReload,
  onUpsert,
  organizationId,
  state,
}: ExpenseCategoriesPanelProps) {
  const [showArchived, setShowArchived] = useState(false);
  const { busy, clearFeedback, create, feedback, rename, toggle } =
    useCategoryCommands({
      onReload,
      onUpsert,
      organizationId,
    });
  const form = useFormDialog<ExpenseCategoryReadModel, CategoryDraft>({
    busy: busy !== null,
    onOpen: clearFeedback,
    originOf: categoryFormOrigin,
  });
  const { close: closeForm, editing, openForm } = form;
  const handleNew = useCallback(() => openForm("new"), [openForm]);
  // a name already used comes back as a conflict, as a version changed elsewhere: the list is read again and the
  // form stays open with what was typed and the message inside, as the row's own form did; renaming again goes with
  // the version just read
  const handleSave = useCallback(
    async (draft: CategoryDraft) => {
      const current =
        editing &&
        (state.categories.find((category) => category.id === editing.id) ??
          editing);
      const outcome = current
        ? await rename(current, draft.name)
        : await create(draft.group, draft.name);
      if (outcome === "ok") {
        closeForm();
      }
    },
    [closeForm, create, editing, rename, state.categories]
  );
  const sections = useMemo(
    () =>
      groupCategories(
        state.categories.filter(
          (category) => showArchived || category.status === "active"
        )
      ),
    [showArchived, state.categories]
  );

  return (
    <Block variant="plain">
      {/* while the form is open it covers this part of the screen: what the commands say is said inside it */}
      <ActionNotice feedback={form.open ? null : feedback} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Field className="min-h-ctl-md w-auto" orientation="horizontal">
          <Checkbox
            checked={showArchived}
            id="expense-categories-archived"
            onCheckedChange={setShowArchived}
          />
          <FieldLabel htmlFor="expense-categories-archived">
            Mostrar categorias arquivadas
          </FieldLabel>
        </Field>
        <Button
          data-category-new=""
          disabled={busy !== null}
          onClick={handleNew}
          type="button"
          variant="outline"
        >
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          Nova categoria
        </Button>
      </div>
      <Dialog disablePointerDismissal {...form.dialog}>
        <DialogContent finalFocus={form.finalFocus} layout="form">
          <ExpenseCategoryForm
            disabled={busy !== null}
            editing={editing}
            feedback={feedback?.kind === "error" ? feedback : null}
            key={form.formKey}
            keptDraft={form.keptDraft}
            onCancel={closeForm}
            onDraftChange={form.onDraftChange}
            onSave={handleSave}
          />
        </DialogContent>
      </Dialog>
      <div aria-busy={state.isLoading} className="grid gap-4">
        {state.isLoading && state.categories.length === 0 ? (
          <ListBlock
            skeleton={<CategoryRowShape />}
            state="loading"
            title={LOADING_TITLE}
          />
        ) : null}
        {sections.map((section) => (
          <ListBlock
            id={`expense-group-${section.key}`}
            key={section.key}
            state="rows"
            title={
              <span className="[overflow-wrap:anywhere]">{section.label}</span>
            }
          >
            {section.items.map((category) => (
              <CategoryRow
                busyKey={busy}
                category={category}
                key={category.id}
                onRename={openForm}
                onToggle={toggle}
              />
            ))}
          </ListBlock>
        ))}
      </div>
    </Block>
  );
}
