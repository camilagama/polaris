import type { CategoryReadModel, ProductReadModel } from "@polaris/contracts";
import MoreHorizontalIcon from "lucide-react/dist/esm/icons/ellipsis";
import TagIcon from "lucide-react/dist/esm/icons/tag";
import { useCallback, useMemo } from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty-state";
import { ListBlock } from "@/ui/list-block";
import { RowInitials } from "@/ui/row-tile";
import { Skeleton } from "@/ui/skeleton";
import { TextLink } from "@/ui/text-link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useMediaThumbsEnabled } from "../lib/media-thumbs-flag";
import type { PendingProduct } from "../offline/product-create";
import { ProductThumbnail, useThumbnailSequence } from "./product-thumbnail";
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
  onDelete: (product: ProductReadModel) => void;
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
  onDelete,
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
  const handleDelete = useCallback(
    () => onDelete(product),
    [onDelete, product]
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
        {product.status === "archived" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={disabled}
              onClick={handleDelete}
              variant="destructive"
            >
              Excluir…
            </DropdownMenuItem>
          </>
        ) : null}
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

function RowMark({
  product,
  thumbs,
}: {
  product: ProductReadModel;
  thumbs: boolean;
}) {
  if (thumbs) {
    return (
      <ProductThumbnail
        assetId={product.coverAssetId}
        name={product.name}
        size={40}
      />
    );
  }
  return <RowInitials>{productInitials(product.name)}</RowInitials>;
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
  const thumbs = useMediaThumbsEnabled();
  return (
    <ListBlock.Row
      className={`grid items-stretch gap-0 py-0 ${OPENABLE_ROW_CLASS}`}
      data-product-id={product.id}
    >
      <div className="flex items-center gap-3">
        <RowOpenButton
          describedBy={describedBy}
          locked={lockedReason !== null || pending}
          onOpen={handleOpen}
        >
          <RowMark product={product} thumbs={thumbs} />
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
        <div className={`grid gap-0.5 pb-2.5 ${thumbs ? "pl-13" : "pl-12"}`}>
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
                <TextLink className="text-support" href="/attention">
                  Resolver em Pendências
                </TextLink>
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
    </ListBlock.Row>
  );
}

/** The id of the frame's title: "Carregar mais" finds the rows of the list by it. */
export const PRODUCT_LIST_TITLE_ID = "product-list-title";

const PRODUCT_LIST_TITLE = "Produtos cadastrados";

/** The shape of a row while the list loads: the mark, the name and the line under it. */
function ProductRowShape() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="grid flex-1 gap-1.5">
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

interface ProductListProps extends RowActions {
  categories: CategoryReadModel[];
  /** "1.248 produtos": the count beside the title, empty while it is not known. */
  count: string;
  isLoading: boolean;
  /** Working from this device's collections while the connection is down. */
  isOffline: boolean;
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

export function ProductList({
  categories,
  count,
  isLoading,
  isOffline,
  pendingAction,
  products,
  query,
  status,
  syncStates,
  total,
  ...actions
}: ProductListProps) {
  const coverIds = useMemo(
    () => products.map((product) => product.coverAssetId),
    [products]
  );
  useThumbnailSequence(coverIds);
  if (isLoading) {
    return (
      <ListBlock
        count={count}
        id={PRODUCT_LIST_TITLE_ID}
        skeleton={<ProductRowShape />}
        state="loading"
        title={PRODUCT_LIST_TITLE}
      />
    );
  }

  if (total === 0) {
    return (
      <EmptyState
        afterRead
        art={status === "active" ? "products" : undefined}
        icon={TagIcon}
        title={
          status === "active"
            ? "Nenhum produto ainda."
            : "Nenhum produto arquivado."
        }
      />
    );
  }

  if (products.length === 0) {
    return (
      <ListBlock
        count={count}
        emptyNotice={
          <p className="text-muted-foreground" role="status">
            Nenhum produto com “{query.trim()}”.
          </p>
        }
        id={PRODUCT_LIST_TITLE_ID}
        state="filtered-empty"
        title={PRODUCT_LIST_TITLE}
      />
    );
  }

  const categoryNames = new Map(
    categories.map((category) => [category.id, category.name])
  );
  return (
    <ListBlock
      count={count}
      id={PRODUCT_LIST_TITLE_ID}
      state="rows"
      title={PRODUCT_LIST_TITLE}
    >
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
    </ListBlock>
  );
}
