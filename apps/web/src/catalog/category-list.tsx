import type { CategoryReadModel } from "@polaris/contracts";
import MoreHorizontalIcon from "lucide-react/dist/esm/icons/ellipsis";
import TagIcon from "lucide-react/dist/esm/icons/tag";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { EmptyState } from "@/ui/empty-state";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupInput } from "@/ui/input-group";
import { InsetBlock } from "@/ui/inset-block";
import { ListBlock } from "@/ui/list-block";
import { Skeleton } from "@/ui/skeleton";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { focusLater } from "../lib/focus";
import {
  type CategoryListStatus,
  categoryNameCountLabel,
  categoryNameIsTooLong,
  EMPTY_TEXT,
  STATUS_LABELS,
} from "./categories-model";
import { NAME_REQUIRED } from "./category-form";
import { formatDate } from "./screen-parts";

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
      <DropdownMenuContent align="end" className="min-w-44">
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
  const [showRequired, setShowRequired] = useState(false);
  const tooLong = categoryNameIsTooLong(value);
  const id = `rename-category-${category.id}`;
  const error = tooLong
    ? categoryNameCountLabel(value)
    : (showRequired && value.trim() === "" && NAME_REQUIRED) || undefined;
  useEffect(() => {
    focusLater(() => inputRef.current?.focus());
  }, []);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setShowRequired(false);
      onChange(event.target.value);
    },
    [onChange]
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (value.trim() === "") {
        setShowRequired(true);
        inputRef.current?.focus();
        return;
      }
      // offline nothing leaves and nothing typed is touched: the button says why
      if (online) {
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
      <Field className="min-w-0" data-invalid={Boolean(error)}>
        <FieldLabel className="sr-only" htmlFor={id}>
          Novo nome para {category.name}
        </FieldLabel>
        <InputGroup>
          <InputGroupInput
            aria-describedby={`${id}-count`}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            id={id}
            onChange={handleChange}
            ref={inputRef}
            value={value}
          />
        </InputGroup>
        {error ? (
          <FieldError id={`${id}-count`}>{error}</FieldError>
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
  const groupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    focusLater(() => groupRef.current?.focus());
  }, []);
  const handleConfirm = useCallback(() => {
    if (online) {
      onConfirm(category);
    }
  }, [category, online, onConfirm]);
  return (
    <InsetBlock
      aria-label={`Confirmar remoção de ${category.name}`}
      className="grid w-full gap-3 p-3 outline-none focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-solid focus-visible:outline-offset-2"
      ref={groupRef}
      role="group"
      tabIndex={-1}
      tone="destructive"
    >
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
          className="h-auto! min-h-ctl-md whitespace-normal py-1.5 text-center"
          disabled={isPending}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Manter categoria
        </Button>
        <Button
          {...connectionControlProps(online)}
          className="h-auto! min-h-ctl-md whitespace-normal py-1.5 text-center"
          disabled={isPending}
          onClick={handleConfirm}
          type="button"
          variant="destructive"
        >
          Remover categoria
        </Button>
      </div>
    </InsetBlock>
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
      <ListBlock.Row className="py-2.5" data-category-id={category.id}>
        <RenameForm
          category={category}
          isPending={pending}
          onCancel={actions.onRenameCancel}
          onChange={actions.onRenameChange}
          onSubmit={actions.onRenameSubmit}
          online={online}
          value={renameValue}
        />
      </ListBlock.Row>
    );
  }
  if (mode === "delete") {
    return (
      <ListBlock.Row className="py-2.5" data-category-id={category.id}>
        <DeleteConfirm
          category={category}
          isPending={pending}
          onCancel={actions.onDeleteCancel}
          onConfirm={actions.onDelete}
          online={online}
        />
      </ListBlock.Row>
    );
  }
  return (
    <ListBlock.Row className="py-2.5" data-category-id={category.id}>
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
    </ListBlock.Row>
  );
}

const CATEGORY_LIST_TITLE = "Categorias cadastradas";

/** The shape of a row while the list loads: the name and the status line under it. */
function CategoryRowShape() {
  return (
    <div className="grid gap-1.5">
      <Skeleton className="h-3.5 w-1/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
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
      <ListBlock
        count=""
        skeleton={<CategoryRowShape />}
        state="loading"
        title={CATEGORY_LIST_TITLE}
      />
    );
  }
  if (categories.length === 0) {
    return <EmptyState afterRead icon={TagIcon} {...EMPTY_TEXT[status]} />;
  }
  const modeOf = (id: string): RowMode => {
    if (renamingCategoryId === id) {
      return "rename";
    }
    return pendingDeleteId === id ? "delete" : null;
  };
  return (
    <ListBlock state="rows" title={CATEGORY_LIST_TITLE}>
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
    </ListBlock>
  );
}
