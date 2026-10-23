import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { MAX_EXPENSE_CATEGORY_NAME_LENGTH } from "@polaris/domain/expenses/expense";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupInput } from "@/ui/input-group";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import { SelectField } from "../sales/sale-fields";
import { CollapsibleSection } from "./collapsible-section";
import { ActionNotice, ExpenseTextField, ListNote } from "./expense-fields";
import {
  EXPENSE_GROUP_ORDER,
  type ExpenseGroupKey,
  groupCategories,
} from "./expense-model";
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
  const online = useConnectionOnline();
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
      <form
        className="flex flex-wrap items-center gap-2 py-2"
        onSubmit={handleSubmit}
      >
        <InputGroup className="min-w-0 flex-[1_1_12rem]">
          <InputGroupInput
            aria-label={`Novo nome da categoria ${category.name}`}
            autoComplete="off"
            disabled={isBusy}
            id={nameFieldId}
            maxLength={MAX_EXPENSE_CATEGORY_NAME_LENGTH}
            onChange={handleName}
            required
            value={name}
          />
        </InputGroup>
        <div className="flex gap-2">
          <Button
            {...connectionControlProps(online)}
            disabled={isBusy}
            size="sm"
            type="submit"
          >
            Salvar
          </Button>
          <Button
            disabled={isBusy}
            onClick={handleCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancelar
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
      <span className="flex min-w-0 flex-[1_1_10rem] flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
        {category.name}
        {archived ? <Badge variant="warning">Arquivada</Badge> : null}
      </span>
      <span className="flex gap-2">
        <Button
          aria-label={`Renomear categoria ${category.name}`}
          disabled={isBusy}
          onClick={handleStart}
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

interface NewCategoryFormProps {
  busy: boolean;
  onCreate: (group: ExpenseGroupKey, name: string) => Promise<boolean>;
}

const GROUP_OPTIONS = EXPENSE_GROUP_ORDER.map((item) => ({
  id: item.key,
  label: item.label,
}));

function NewCategoryForm({ busy, onCreate }: NewCategoryFormProps) {
  const [group, setGroup] = useState<ExpenseGroupKey>("operational");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useReportUnsentWork(name.trim() !== "");
  const online = useConnectionOnline();

  const handleGroup = useCallback((value: string) => {
    const match = EXPENSE_GROUP_ORDER.find((item) => item.key === value);
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
    <form
      className="grid gap-4 border-t pt-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] md:items-start"
      noValidate
      onSubmit={handleSubmit}
    >
      <SelectField
        disabled={busy}
        id="expense-new-category-group"
        label="Grupo"
        onChange={handleGroup}
        options={GROUP_OPTIONS}
        placeholder="Escolha o grupo"
        value={group}
      />
      <ExpenseTextField
        disabled={busy}
        error={error ?? undefined}
        id="expense-new-category-name"
        label="Nome da categoria"
        maxLength={MAX_EXPENSE_CATEGORY_NAME_LENGTH}
        onChange={handleName}
        value={name}
      />
      {/* aligned with the fields, below their labels (the label line is 20 px plus the 6 px gap) */}
      <Button
        {...connectionControlProps(online)}
        className="justify-self-start md:mt-[1.625rem]"
        disabled={busy}
        type="submit"
      >
        Adicionar categoria
      </Button>
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

  return (
    <CollapsibleSection id="expense-categories" title="Categorias de despesa">
      <ActionNotice feedback={feedback} />
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
                    onRename={rename}
                    onToggle={toggle}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <NewCategoryForm busy={busy !== null} onCreate={create} />
    </CollapsibleSection>
  );
}
