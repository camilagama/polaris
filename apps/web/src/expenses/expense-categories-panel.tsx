import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import { Dialog, DialogContent } from "@/ui/dialog";
import { Field, FieldLabel } from "@/ui/field";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { orpcClient } from "../lib/orpc";
import {
  type CategoryDraft,
  ExpenseCategoryForm,
} from "./expense-category-form";
import { ActionNotice, ListNote } from "./expense-fields";
import { type ExpenseGroupKey, groupCategories } from "./expense-model";
import { type CommandOutcome, useCommandRunner } from "./use-command-runner";
import type { ExpenseCategoriesState } from "./use-expense-categories";
import { useFormDialog } from "./use-form-dialog";

interface ExpenseCategoriesPanelProps {
  onReload: () => Promise<void>;
  onUpsert: (category: ExpenseCategoryReadModel) => void;
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
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2"
      data-category-id={category.id}
    >
      <span className="flex min-w-0 flex-[1_1_10rem] flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
        {category.name}
        {archived ? <Badge variant="warning">Arquivada</Badge> : null}
      </span>
      <span className="flex gap-2">
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

  return { busy, clearFeedback, create, feedback, rename, toggle };
}

/** What opened the form: "Nova categoria" or the "Renomear" of the category. */
function categoryFormOrigin(next: ExpenseCategoryReadModel | "new") {
  return next === "new"
    ? () => document.querySelector<HTMLElement>("[data-category-new]")
    : () =>
        document.querySelector<HTMLElement>(
          `[data-category-id="${next.id}"] [data-category-rename]`
        );
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
  const handleSave = useCallback(
    async (draft: CategoryDraft) => {
      const outcome = editing
        ? await rename(editing, draft.name)
        : await create(draft.group, draft.name);
      if (outcome !== "failed") {
        closeForm();
      }
    },
    [closeForm, create, editing, rename]
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
    <Card>
      <CardContent className="grid gap-4">
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
            <ListNote loading>Carregando categorias…</ListNote>
          ) : null}
          {sections.map((section) => (
            <section
              aria-labelledby={`expense-group-${section.key}`}
              className="grid gap-1"
              key={section.key}
            >
              <h3
                className="font-medium text-muted-foreground text-xs uppercase tracking-wide"
                id={`expense-group-${section.key}`}
              >
                {section.label}
              </h3>
              <ul className="divide-y border-t">
                {section.items.map((category) => (
                  <li key={category.id}>
                    <CategoryRow
                      busyKey={busy}
                      category={category}
                      onRename={openForm}
                      onToggle={toggle}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
