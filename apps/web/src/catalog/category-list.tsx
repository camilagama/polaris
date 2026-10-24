import type { CategoryReadModel } from "@polaris/contracts";
import MoreHorizontalIcon from "lucide-react/dist/esm/icons/ellipsis";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupInput } from "@/ui/input-group";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { focusLater } from "../lib/focus";
import {
  type CategoryListStatus,
  categoryNameCountLabel,
  categoryNameIsTooLong,
  EMPTY_TEXT,
  STATUS_LABELS,
} from "./categories-model";
import { formatDate, ListNotice } from "./screen-parts";

const BADGE_VARIANT = {
  active: "outline",
  archived: "warning",
  deleted: "destructive",
} as const;

/** What a row is doing besides showing the category. */
export type RowMode = "delete" | "rename" | null;

/** What an item of the menu that needs the connection looks like while there is none. */
const ITEM_OFFLINE =
  "aria-disabled:pointer-events-none aria-disabled:opacity-50";

interface RowActions {
  onArchive: (category: CategoryReadModel) => void;
  onDelete: (category: CategoryReadModel) => void;
  onDeleteCancel: () => void;
  onDeleteStart: (category: CategoryReadModel) => void;
  onRenameCancel: () => void;
  onRenameChange: (value: string) => void;
  onRenameStart: (category: CategoryReadModel) => void;
  onRenameSubmit: (category: CategoryReadModel) => void;
  onRestore: (category: CategoryReadModel) => void;
}

interface CategoryMenuProps {
  category: CategoryReadModel;
  onArchive: RowActions["onArchive"];
  onDeleteStart: RowActions["onDeleteStart"];
  onRenameStart: RowActions["onRenameStart"];
  onRestore: RowActions["onRestore"];
  online: boolean;
  pending: boolean;
}

/** The actions of one category (an archived one is restored instead of archived). */
function CategoryMenu({
  category,
  onArchive,
  onDeleteStart,
  onRenameStart,
  onRestore,
  online,
  pending,
}: CategoryMenuProps) {
  const handleRename = useCallback(
    () => onRenameStart(category),
    [category, onRenameStart]
  );
  const handleArchive = useCallback(
    () => onArchive(category),
    [category, onArchive]
  );
  const handleRestore = useCallback(
    () => onRestore(category),
    [category, onRestore]
  );
  const handleDelete = useCallback(
    () => onDeleteStart(category),
    [category, onDeleteStart]
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Mais ações para ${category.name}`}
            disabled={pending}
            size="icon"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width="wide">
        <DropdownMenuItem onClick={handleRename}>Renomear</DropdownMenuItem>
        {category.status === "active" ? (
          <DropdownMenuItem
            {...connectionControlProps(online)}
            className={ITEM_OFFLINE}
            onClick={handleArchive}
          >
            Arquivar
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            {...connectionControlProps(online)}
            className={ITEM_OFFLINE}
            onClick={handleRestore}
          >
            Restaurar
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleDelete}>Remover</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface RenameFormProps {
  category: CategoryReadModel;
  isPending: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: (category: CategoryReadModel) => void;
  online: boolean;
  value: string;
}

/** The name of a category edited in its own row. */
function RenameForm({
  category,
  isPending,
  onCancel,
  onChange,
  onSubmit,
  online,
  value,
}: RenameFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const tooLong = categoryNameIsTooLong(value);
  const id = `rename-category-${category.id}`;
  useEffect(() => {
    focusLater(() => inputRef.current?.focus());
  }, []);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // offline nothing leaves and nothing typed is touched: the button says why
      if (online && value.trim() !== "") {
        onSubmit(category);
      }
    },
    [category, online, onSubmit, value]
  );
  return (
    <form
      className="grid w-full gap-3 min-[30rem]:grid-cols-[1fr_auto]"
      data-category-id={category.id}
      noValidate
      onSubmit={handleSubmit}
    >
      <Field className="min-w-0" data-invalid={tooLong}>
        <FieldLabel className="sr-only" htmlFor={id}>
          Novo nome para {category.name}
        </FieldLabel>
        <InputGroup>
          <InputGroupInput
            aria-describedby={`${id}-count`}
            aria-invalid={tooLong ? true : undefined}
            autoComplete="off"
            id={id}
            onChange={handleChange}
            ref={inputRef}
            value={value}
          />
        </InputGroup>
        {tooLong ? (
          <FieldError id={`${id}-count`}>
            {categoryNameCountLabel(value)}
          </FieldError>
        ) : (
          <FieldDescription id={`${id}-count`}>
            {categoryNameCountLabel(value)}
          </FieldDescription>
        )}
      </Field>
      <div className="flex gap-3 min-[30rem]:items-start">
        <Button
          {...connectionControlProps(online)}
          disabled={isPending || tooLong}
          type="submit"
        >
          Salvar
        </Button>
        <Button
          disabled={isPending}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancelar
        </Button>
      </div>
    </form>
  );
}

interface DeleteConfirmProps {
  category: CategoryReadModel;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (category: CategoryReadModel) => void;
  online: boolean;
}

/** Removing is the one action with no way back: it asks again, in the row, and says what stays. */
function DeleteConfirm({
  category,
  isPending,
  onCancel,
  onConfirm,
  online,
}: DeleteConfirmProps) {
  const groupRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    focusLater(() => groupRef.current?.focus());
  }, []);
  const handleConfirm = useCallback(() => {
    if (online) {
      onConfirm(category);
    }
  }, [category, online, onConfirm]);
  return (
    <fieldset
      className="grid w-full min-w-0 gap-3 outline-none"
      ref={groupRef}
      tabIndex={-1}
    >
      <legend className="sr-only">Confirmar remoção de {category.name}</legend>
      <p className="text-support">
        Remover{" "}
        <strong className="font-medium [overflow-wrap:anywhere]">
          “{category.name}”
        </strong>
        ? Ela some da lista e não pode ser restaurada. O histórico de vendas
        continua igual.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={isPending}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancelar
        </Button>
        <Button
          {...connectionControlProps(online)}
          disabled={isPending}
          onClick={handleConfirm}
          type="button"
          variant="destructive"
        >
          Remover categoria
        </Button>
      </div>
    </fieldset>
  );
}

interface CategoryRowProps extends RowActions {
  category: CategoryReadModel;
  mode: RowMode;
  online: boolean;
  pendingAction: string | null;
  renameValue: string;
}

function CategoryRow({
  category,
  mode,
  online,
  pendingAction,
  renameValue,
  ...actions
}: CategoryRowProps) {
  const pending = pendingAction?.endsWith(category.id) ?? false;
  if (mode === "rename") {
    return (
      <li className="flex px-3 py-2.5 md:px-4" data-category-id={category.id}>
        <RenameForm
          category={category}
          isPending={pending}
          onCancel={actions.onRenameCancel}
          onChange={actions.onRenameChange}
          onSubmit={actions.onRenameSubmit}
          online={online}
          value={renameValue}
        />
      </li>
    );
  }
  if (mode === "delete") {
    return (
      <li className="flex px-3 py-2.5 md:px-4" data-category-id={category.id}>
        <DeleteConfirm
          category={category}
          isPending={pending}
          onCancel={actions.onDeleteCancel}
          onConfirm={actions.onDelete}
          online={online}
        />
      </li>
    );
  }
  return (
    <li
      className="flex items-center gap-3 px-3 py-2.5 md:px-4"
      data-category-id={category.id}
    >
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="font-medium [overflow-wrap:anywhere]">{category.name}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant={BADGE_VARIANT[category.status]}>
            {STATUS_LABELS[category.status]}
          </Badge>
          <span className="text-muted-foreground text-support">
            Atualizada em {formatDate(category.updatedAt)}
          </span>
        </div>
        {category.status === "deleted" ? (
          <p className="text-muted-foreground text-support">
            Histórico preservado; não pode ser restaurada.
          </p>
        ) : null}
        {pending ? (
          <p className="text-muted-foreground text-support" role="status">
            Atualizando…
          </p>
        ) : null}
      </div>
      {category.status === "deleted" ? null : (
        <CategoryMenu
          category={category}
          onArchive={actions.onArchive}
          onDeleteStart={actions.onDeleteStart}
          onRenameStart={actions.onRenameStart}
          onRestore={actions.onRestore}
          online={online}
          pending={pending}
        />
      )}
    </li>
  );
}

interface CategoryListProps extends RowActions {
  categories: CategoryReadModel[];
  isLoading: boolean;
  online: boolean;
  pendingAction: string | null;
  pendingDeleteId: string | null;
  renameValue: string;
  renamingCategoryId: string | null;
  status: CategoryListStatus;
}

export function CategoryList({
  categories,
  isLoading,
  online,
  pendingAction,
  pendingDeleteId,
  renameValue,
  renamingCategoryId,
  status,
  ...actions
}: CategoryListProps) {
  if (isLoading) {
    return (
      <ListNotice>
        <p className="text-muted-foreground" role="status">
          Carregando categorias…
        </p>
      </ListNotice>
    );
  }
  if (categories.length === 0) {
    return (
      <ListNotice>
        <p className="text-muted-foreground">{EMPTY_TEXT[status]}</p>
      </ListNotice>
    );
  }
  const modeOf = (id: string): RowMode => {
    if (renamingCategoryId === id) {
      return "rename";
    }
    return pendingDeleteId === id ? "delete" : null;
  };
  return (
    <Card gap="none" pad="none">
      <ul aria-label="Categorias" className="divide-y divide-border">
        {categories.map((category) => (
          <CategoryRow
            {...actions}
            category={category}
            key={category.id}
            mode={modeOf(category.id)}
            online={online}
            pendingAction={pendingAction}
            renameValue={renameValue}
          />
        ))}
      </ul>
    </Card>
  );
}
