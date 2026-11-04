import type { CategoryReadModel, ProductReadModel } from "@polaris/contracts";
import MoreHorizontalIcon from "lucide-react/dist/esm/icons/ellipsis";
import PackageIcon from "lucide-react/dist/esm/icons/package";
import { type ReactNode, useCallback } from "react";
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
import type { PendingProduct } from "../offline/product-create";
import { productInitials } from "./product-search-model";
import { OFFLINE_NOTICE_ID } from "./products-page-parts";
import { OPENABLE_ROW_CLASS, RowOpenButton } from "./screen-parts";

export type ProductListStatus = "active" | "archived";

/** Everything but creating needs the server to know the product and to be reachable. */
export function lockedReasonFor(
  syncState: PendingProduct | undefined,
  isOffline: boolean
): string | null {
  if (syncState) {
    return "Disponível depois que o servidor confirmar o cadastro.";
  }
  return isOffline ? "Disponível quando houver conexão." : null;
}

function syncStateLabel(syncState: PendingProduct): string {
  if (syncState.state === "rejected") {
    return "Recusado pelo servidor";
  }
  return syncState.state === "sending" ? "Enviando…" : "Aguardando envio";
}

interface RowActions {
  onArchive: (product: ProductReadModel) => void;
  onEdit: (product: ProductReadModel) => void;
  onManageMedia: (product: ProductReadModel) => void;
  onManageVariants: (product: ProductReadModel) => void;
  onRestore: (product: ProductReadModel) => void;
}

interface ProductMenuProps extends Omit<RowActions, "onEdit"> {
  locked: boolean;
  pending: boolean;
  product: ProductReadModel;
}

/**
 * The actions of one product besides opening it (the row itself opens it). A locked product (not confirmed yet, or
 * no connection) keeps the menu and shows why in its row.
 */
function ProductMenu({
  locked,
  onArchive,
  onManageMedia,
  onManageVariants,
  onRestore,
  pending,
  product,
}: ProductMenuProps) {
  const handleVariants = useCallback(
    () => onManageVariants(product),
    [onManageVariants, product]
  );
  const handleMedia = useCallback(
    () => onManageMedia(product),
    [onManageMedia, product]
  );
  const handleArchive = useCallback(
    () => onArchive(product),
    [onArchive, product]
  );
  const handleRestore = useCallback(
    () => onRestore(product),
    [onRestore, product]
  );
  const disabled = locked || pending;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Mais ações para ${product.name}`}
            disabled={pending}
            size="icon"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem disabled={disabled} onClick={handleVariants}>
          Variantes
        </DropdownMenuItem>
        {product.status === "active" ? (
          <DropdownMenuItem disabled={disabled} onClick={handleMedia}>
            Imagens
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {product.status === "active" ? (
          <DropdownMenuItem disabled={disabled} onClick={handleArchive}>
            Arquivar
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={disabled} onClick={handleRestore}>
            Restaurar
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ProductRowProps extends RowActions {
  categoryName: string | null;
  /**
   * Why the actions are unavailable for this product, or null. Said in the row only for a product the server has not
   * confirmed; without a connection the notice at the top of the screen says it once for all of them.
   */
  lockedReason: string | null;
  pendingAction: string | null;
  product: ProductReadModel;
  /** The product was created on this device and the server has not confirmed it yet. */
  syncState: PendingProduct | undefined;
}

function pendingLabelFor(
  pendingAction: string | null,
  productId: string
): string | null {
  if (pendingAction === `archive:${productId}`) {
    return "Arquivando…";
  }
  return pendingAction === `restore:${productId}` ? "Restaurando…" : null;
}

/** The reason is in the row for a product not confirmed yet, and in the notice at the top without a connection. */
function reasonRef(
  lockedReason: string | null,
  syncState: PendingProduct | undefined,
  reasonId: string
): string | undefined {
  if (lockedReason === null) {
    return undefined;
  }
  return syncState ? reasonId : OFFLINE_NOTICE_ID;
}

function supportLine(
  categoryName: string | null,
  description: string | null
): string {
  const text = description?.replace(/\s+/g, " ").trim();
  return [categoryName ?? "Sem categoria", text].filter(Boolean).join(" · ");
}

function ProductRow({
  categoryName,
  lockedReason,
  pendingAction,
  product,
  syncState,
  onEdit,
  ...actions
}: ProductRowProps) {
  const pending = pendingAction?.endsWith(product.id) ?? false;
  const pendingLabel = pendingLabelFor(pendingAction, product.id);
  const handleOpen = useCallback(() => onEdit(product), [onEdit, product]);
  const reasonId = `product-locked-${product.id}`;
  const supportId = `product-support-${product.id}`;
  const pendingId = `product-pending-${product.id}`;
  const describedBy = [
    supportId,
    reasonRef(lockedReason, syncState, reasonId),
    pendingLabel ? pendingId : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const hasExtras = Boolean(syncState || pendingLabel);
  return (
    <li
      className={`grid px-3 md:px-4 ${OPENABLE_ROW_CLASS}`}
      data-product-id={product.id}
    >
      <div className="flex items-center gap-3">
        <RowOpenButton
          describedBy={describedBy}
          locked={lockedReason !== null || pending}
          onOpen={handleOpen}
        >
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-muted font-medium text-muted-foreground text-xs"
          >
            {productInitials(product.name)}
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="font-medium [overflow-wrap:anywhere]">
              <span className="sr-only">Editar </span>
              {product.name}
            </span>
            <span
              aria-hidden="true"
              className="line-clamp-1 text-muted-foreground text-support [overflow-wrap:anywhere]"
              id={supportId}
            >
              {supportLine(categoryName, product.description)}
            </span>
          </span>
        </RowOpenButton>
        <ProductMenu
          {...actions}
          locked={lockedReason !== null}
          pending={pending}
          product={product}
        />
      </div>
      {hasExtras ? (
        // under the text of the row, out of its button: a status and a link are their own parts
        <div className="grid gap-0.5 pb-2.5 pl-12">
          {syncState ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Badge
                data-sync-state={syncState.state}
                role="status"
                variant={
                  syncState.state === "rejected" ? "destructive" : "outline"
                }
              >
                {syncStateLabel(syncState)}
              </Badge>
              {syncState.state === "rejected" ? (
                <a
                  className="focus-ring touch-hit rounded-sm text-support underline decoration-input underline-offset-4 hover:decoration-foreground"
                  href="/attention"
                >
                  Resolver em Pendências
                </a>
              ) : null}
            </div>
          ) : null}
          {syncState && lockedReason ? (
            <p className="text-muted-foreground text-support" id={reasonId}>
              {lockedReason}
            </p>
          ) : null}
          {pendingLabel ? (
            <p
              className="text-muted-foreground text-support"
              id={pendingId}
              role="status"
            >
              {pendingLabel}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

interface ProductListProps extends RowActions {
  categories: CategoryReadModel[];
  isLoading: boolean;
  /** Working from this device's collections while the connection is down. */
  isOffline: boolean;
  onNew: () => void;
  pendingAction: string | null;
  /** The products that match the search. */
  products: ProductReadModel[];
  /** The typed search; empty when none. */
  query: string;
  status: ProductListStatus;
  /** Products created on this device that the server has not confirmed yet. */
  syncStates: ReadonlyMap<string, PendingProduct>;
  /** How many products the status has, before the search. */
  total: number;
}

function ListNotice({ children }: { children: ReactNode }) {
  return (
    <Card className="py-6">
      <div className="grid justify-items-center gap-3 px-4 text-center">
        {children}
      </div>
    </Card>
  );
}

export function ProductList({
  categories,
  isLoading,
  isOffline,
  onNew,
  pendingAction,
  products,
  query,
  status,
  syncStates,
  total,
  ...actions
}: ProductListProps) {
  if (isLoading) {
    return (
      <ListNotice>
        <p className="text-muted-foreground" role="status">
          Carregando produtos…
        </p>
      </ListNotice>
    );
  }

  if (total === 0) {
    return (
      <ListNotice>
        {status === "active" ? (
          <>
            <PackageIcon
              aria-hidden="true"
              className="size-6 text-muted-foreground"
            />
            <p className="font-medium">Nenhum produto ainda</p>
            <Button onClick={onNew} type="button">
              Novo produto
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground">Nenhum produto arquivado.</p>
        )}
      </ListNotice>
    );
  }

  if (products.length === 0) {
    return (
      <ListNotice>
        <p className="text-muted-foreground" role="status">
          Nenhum produto com “{query.trim()}”.
        </p>
      </ListNotice>
    );
  }

  const categoryNames = new Map(
    categories.map((category) => [category.id, category.name])
  );
  return (
    <Card className="gap-0 py-0">
      <ul aria-label="Produtos" className="divide-y divide-border">
        {products.map((product) => {
          const syncState = syncStates.get(product.id);
          return (
            <ProductRow
              {...actions}
              categoryName={
                product.categoryId
                  ? (categoryNames.get(product.categoryId) ??
                    "Categoria vinculada")
                  : null
              }
              key={product.id}
              lockedReason={lockedReasonFor(syncState, isOffline)}
              pendingAction={pendingAction}
              product={product}
              syncState={syncState}
            />
          );
        })}
      </ul>
    </Card>
  );
}
