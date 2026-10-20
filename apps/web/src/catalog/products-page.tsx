import type { CategoryReadModel, ProductReadModel } from "@polaris/contracts";
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
import { legalAcceptanceMessage } from "../lib/rpc-error";
import { isDraftChanged, useReportUnsentWork } from "../lib/unsent-work";
import {
  createOfflineProduct,
  type PendingProduct,
  pendingProducts,
} from "../offline/product-create";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import {
  listLocalCategories,
  listLocalProducts,
  toLocalProductRow,
} from "./local-products";
import { ProductMediaPanel } from "./product-media-panel";
import { ProductVariantsPanel } from "./product-variants-panel";
import "./products-page.css";

type ProductListStatus = "active" | "archived";
type ProductAction = "archive" | "restore";

interface ProductDraft {
  categoryId: string;
  description: string;
  name: string;
}

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });
const productStatuses: ReadonlyArray<readonly [ProductListStatus, string]> = [
  ["active", "Ativos"],
  ["archived", "Arquivados"],
];

const emptyDraft: ProductDraft = {
  categoryId: "",
  description: "",
  name: "",
};

function rpcErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

function errorMessage(
  error: unknown,
  action?: ProductAction | "create" | "update"
): string {
  const unaccepted = legalAcceptanceMessage(
    error,
    action === undefined ? "os produtos" : undefined
  );
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return action === undefined
      ? "Não foi possível carregar os produtos."
      : "O produto não foi alterado.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  if (code === "BAD_REQUEST") {
    return "Informe um nome de produto válido.";
  }
  if (code === "NOT_FOUND") {
    return "O produto não existe mais nesta organização.";
  }
  if (code === "CONFLICT" && action === "create") {
    return "A categoria selecionada não está mais disponível. Atualize a lista e tente novamente.";
  }
  if (code === "CONFLICT" && action === "update") {
    return "A categoria pode ter sido arquivada ou o produto mudou. Atualize a lista e tente novamente.";
  }
  if (code === "CONFLICT") {
    return "O produto mudou em outra solicitação. Atualize a lista e tente novamente.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O catálogo está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function statusLabel(status: ProductReadModel["status"]): string {
  return status === "active" ? "Ativo" : "Arquivado";
}

function isProductListStatus(value: string): value is ProductListStatus {
  return value === "active" || value === "archived";
}

interface ProductFormProps {
  categories: CategoryReadModel[];
  draft: ProductDraft;
  editingProduct: ProductReadModel | null;
  isPending: boolean;
  onCancel: () => void;
  onChange: (field: keyof ProductDraft, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function ProductForm({
  categories,
  draft,
  editingProduct,
  isPending,
  onCancel,
  onChange,
  onSubmit,
}: ProductFormProps) {
  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange("name", event.currentTarget.value),
    [onChange]
  );
  const handleCategoryChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onChange("categoryId", event.currentTarget.value),
    [onChange]
  );
  const handleDescriptionChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      onChange("description", event.currentTarget.value),
    [onChange]
  );
  const availableCategories = categories.filter(
    (category) =>
      category.status === "active" || category.id === draft.categoryId
  );
  let submitLabel = "Cadastrar produto";
  if (isPending) {
    submitLabel = "Salvando…";
  } else if (editingProduct) {
    submitLabel = "Salvar alterações";
  }

  return (
    <section
      aria-labelledby="product-form-heading"
      className="product-form-panel"
    >
      <div className="product-form-heading">
        <div>
          <p className="categories-eyebrow">
            {editingProduct ? "Atualização" : "Cadastro"}
          </p>
          <h2 id="product-form-heading">
            {editingProduct ? "Editar produto" : "Novo produto"}
          </h2>
        </div>
        {editingProduct ? (
          <button
            className="quiet-button"
            disabled={isPending}
            onClick={onCancel}
            type="button"
          >
            Cancelar edição
          </button>
        ) : null}
      </div>
      <form className="product-form" onSubmit={onSubmit}>
        <div className="product-form-field">
          <label className="field-label" htmlFor="product-name">
            Nome do produto
          </label>
          <input
            autoComplete="off"
            id="product-name"
            onChange={handleNameChange}
            required
            value={draft.name}
          />
          <p className="field-help">
            Nomes repetidos são permitidos. Cada produto recebe uma variante
            padrão automaticamente.
          </p>
        </div>
        <div className="product-form-field">
          <label className="field-label" htmlFor="product-category">
            Categoria
          </label>
          <select
            id="product-category"
            onChange={handleCategoryChange}
            value={draft.categoryId}
          >
            <option value="">Sem categoria</option>
            {availableCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {category.status === "archived" ? " (arquivada)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="product-form-field product-description-field">
          <label className="field-label" htmlFor="product-description">
            Descrição <span className="field-optional">Opcional</span>
          </label>
          <textarea
            id="product-description"
            onChange={handleDescriptionChange}
            rows={3}
            value={draft.description}
          />
        </div>
        <div className="product-form-actions">
          <button className="primary-button" disabled={isPending} type="submit">
            {submitLabel}
          </button>
        </div>
      </form>
    </section>
  );
}

interface ProductListProps {
  categories: CategoryReadModel[];
  isLoading: boolean;
  /** Working from this device's collections while the connection is down. */
  isOffline: boolean;
  onArchive: (product: ProductReadModel) => void;
  onEdit: (product: ProductReadModel) => void;
  onManageMedia: (product: ProductReadModel) => void;
  onManageVariants: (product: ProductReadModel) => void;
  onRestore: (product: ProductReadModel) => void;
  pendingAction: string | null;
  products: ProductReadModel[];
  status: ProductListStatus;
  /** Products created on this device that the server has not confirmed yet. */
  syncStates: ReadonlyMap<string, PendingProduct>;
}

/** Everything but creating needs the server to know the product and to be reachable. */
function lockedReasonFor(
  syncState: PendingProduct | undefined,
  isOffline: boolean
): string | null {
  if (syncState) {
    return "Disponível depois que o servidor confirmar o cadastro.";
  }
  return isOffline ? "Disponível quando houver conexão." : null;
}

interface ProductCardProps {
  categoryName: string | null;
  /** Why editing, archiving, variants and images are unavailable for this product, or null. */
  lockedReason: string | null;
  onArchive: (product: ProductReadModel) => void;
  onEdit: (product: ProductReadModel) => void;
  onManageMedia: (product: ProductReadModel) => void;
  onManageVariants: (product: ProductReadModel) => void;
  onRestore: (product: ProductReadModel) => void;
  pendingAction: string | null;
  product: ProductReadModel;
  /** The product was created on this device and the server has not confirmed it yet. */
  syncState: PendingProduct | undefined;
}

function syncStateLabel(syncState: PendingProduct): string {
  if (syncState.state === "rejected") {
    return "Recusado pelo servidor";
  }
  return syncState.state === "sending" ? "Enviando…" : "Aguardando envio";
}

function ProductCard({
  categoryName,
  lockedReason,
  onArchive,
  onEdit,
  onManageMedia,
  onManageVariants,
  onRestore,
  pendingAction,
  product,
  syncState,
}: ProductCardProps) {
  const isPending = pendingAction?.endsWith(product.id) ?? false;
  const locked = lockedReason !== null;
  const isArchiving = pendingAction === `archive:${product.id}`;
  const isRestoring = pendingAction === `restore:${product.id}`;
  const handleEdit = useCallback(() => onEdit(product), [onEdit, product]);
  const handleArchive = useCallback(
    () => onArchive(product),
    [onArchive, product]
  );
  const handleRestore = useCallback(
    () => onRestore(product),
    [onRestore, product]
  );
  const handleManageVariants = useCallback(
    () => onManageVariants(product),
    [onManageVariants, product]
  );
  const handleManageMedia = useCallback(
    () => onManageMedia(product),
    [onManageMedia, product]
  );

  return (
    <article className="product-card">
      <div className="product-card-main">
        <div className="product-card-title-row">
          <h3>{product.name}</h3>
          <span className={`category-status status-${product.status}`}>
            {statusLabel(product.status)}
          </span>
          {syncState ? (
            <span
              className="product-sync-state"
              data-state={syncState.state}
              role="status"
            >
              {syncStateLabel(syncState)}
            </span>
          ) : null}
        </div>
        {product.description ? (
          <p className="product-description">{product.description}</p>
        ) : null}
        <div className="product-meta">
          <span>
            {categoryName ? `Categoria: ${categoryName}` : "Sem categoria"}
          </span>
          <span>Versão {product.version}</span>
          <span>Atualizado em {formatDate(product.updatedAt)}</span>
        </div>
        {syncState?.state === "rejected" ? (
          <p className="product-meta">
            <a href="/attention">Resolver em Pendências</a>
          </p>
        ) : null}
        {lockedReason ? <p className="product-meta">{lockedReason}</p> : null}
      </div>
      <div className="product-card-actions">
        <button
          className="quiet-button"
          disabled={isPending || locked}
          onClick={handleManageVariants}
          type="button"
        >
          Variantes
        </button>
        {product.status === "active" ? (
          <button
            className="quiet-button"
            disabled={isPending || locked}
            onClick={handleManageMedia}
            type="button"
          >
            Imagens
          </button>
        ) : null}
        <button
          className="quiet-button"
          disabled={isPending || locked}
          onClick={handleEdit}
          type="button"
        >
          Editar
        </button>
        {product.status === "active" ? (
          <button
            className="quiet-button"
            disabled={isPending || locked}
            onClick={handleArchive}
            type="button"
          >
            {isArchiving ? "Arquivando…" : "Arquivar"}
          </button>
        ) : (
          <button
            className="quiet-button"
            disabled={isPending || locked}
            onClick={handleRestore}
            type="button"
          >
            {isRestoring ? "Restaurando…" : "Restaurar"}
          </button>
        )}
      </div>
    </article>
  );
}

interface ProductListContentProps extends Omit<ProductListProps, "categories"> {
  categoryNames: Map<string, string>;
}

function ProductListContent({
  categoryNames,
  isLoading,
  isOffline,
  syncStates,
  onArchive,
  onEdit,
  onManageMedia,
  onManageVariants,
  onRestore,
  pendingAction,
  products,
  status,
}: ProductListContentProps) {
  if (isLoading) {
    return (
      <p className="product-empty-state" role="status">
        Carregando produtos…
      </p>
    );
  }

  if (products.length === 0) {
    return (
      <p className="product-empty-state">
        {status === "active"
          ? "Nenhum produto cadastrado. O primeiro item começa com uma variante padrão."
          : "Nenhum produto arquivado."}
      </p>
    );
  }

  return (
    <ul className="product-list">
      {products.map((product) => {
        const categoryName = product.categoryId
          ? (categoryNames.get(product.categoryId) ?? "Categoria vinculada")
          : null;
        return (
          <li className="product-list-item" key={product.id}>
            <ProductCard
              categoryName={categoryName}
              lockedReason={lockedReasonFor(
                syncStates.get(product.id),
                isOffline
              )}
              onArchive={onArchive}
              onEdit={onEdit}
              onManageMedia={onManageMedia}
              onManageVariants={onManageVariants}
              onRestore={onRestore}
              pendingAction={pendingAction}
              product={product}
              syncState={syncStates.get(product.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}

function ProductList({
  categories,
  isLoading,
  isOffline,
  syncStates,
  onArchive,
  onEdit,
  onManageMedia,
  onManageVariants,
  onRestore,
  pendingAction,
  products,
  status,
}: ProductListProps) {
  const categoryNames = new Map(
    categories.map((category) => [category.id, category.name])
  );

  return (
    <section
      aria-labelledby="product-list-heading"
      className="product-list-panel"
    >
      <div className="product-list-heading">
        <div>
          <p className="categories-eyebrow">Organização ativa</p>
          <h2 id="product-list-heading">
            {status === "active" ? "Produtos ativos" : "Produtos arquivados"}
          </h2>
        </div>
        <span className="category-count">
          {isLoading ? "Carregando" : products.length}
        </span>
      </div>
      <ProductListContent
        categoryNames={categoryNames}
        isLoading={isLoading}
        isOffline={isOffline}
        onArchive={onArchive}
        onEdit={onEdit}
        onManageMedia={onManageMedia}
        onManageVariants={onManageVariants}
        onRestore={onRestore}
        pendingAction={pendingAction}
        products={products}
        status={status}
        syncStates={syncStates}
      />
    </section>
  );
}

/**
 * After the server changed a product, the same row goes into the local
 * collection (when the runtime is on), so the list read from the device shows
 * it at once instead of waiting for the next pull.
 */
async function keepLocalRow(
  workspace: ReturnType<typeof useLocalWorkspace>,
  product: ProductReadModel
): Promise<void> {
  if (workspace) {
    await workspace.stores.writer.upsert("products", [
      toLocalProductRow(product),
    ]);
  }
}

/**
 * Creates a product and says what happened. With the offline runtime ready it is
 * queued on this device and shown at once (sent now when there is a connection);
 * without it, it is created on the server as before.
 */
async function createProduct(
  workspace: ReturnType<typeof useLocalWorkspace>,
  organizationId: string,
  input: { categoryId: string | null; description: string | null; name: string }
): Promise<string> {
  if (!workspace) {
    const product = await orpcClient.product.create({
      ...input,
      organizationId,
    });
    return `Produto “${product.name}” cadastrado.`;
  }
  const stores = workspace.runtime.context();
  if (!stores || stores.organizationId !== organizationId) {
    // not ready, or the organization changed under the screen: nothing is queued
    throw new Error("offline_runtime_unavailable");
  }
  await createOfflineProduct({
    deviceId: stores.deviceId,
    input,
    lease: stores.lease,
    organizationId,
    outbox: stores.outbox,
    writer: stores.writer,
  });
  const name = input.name.trim();
  if (workspace.online) {
    workspace.runtime.syncNow().catch(() => undefined);
    return `Produto “${name}” cadastrado.`;
  }
  return `Produto “${name}” salvo neste aparelho. Ele será enviado quando a conexão voltar.`;
}

export function ProductsPage() {
  const { organizationId } = useCurrentOrganization();
  const workspace = useLocalWorkspace(organizationId);
  const [syncStates, setSyncStates] = useState<
    ReadonlyMap<string, PendingProduct>
  >(new Map());
  const [status, setStatus] = useState<ProductListStatus>("active");
  const [products, setProducts] = useState<ProductReadModel[]>([]);
  const [categories, setCategories] = useState<CategoryReadModel[]>([]);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [variantsProductId, setVariantsProductId] = useState<string | null>(
    null
  );
  const [mediaProductId, setMediaProductId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const usesLocalRows = workspace !== null;
  useEffect(() => {
    if (usesLocalRows) {
      return;
    }
    let current = true;
    setIsLoading(true);
    Promise.all([
      orpcClient.product.list({ organizationId, status }),
      orpcClient.category.list({ organizationId, status: "all" }),
    ])
      .then(([productResult, categoryResult]) => {
        if (current) {
          setProducts(productResult.products);
          setCategories(categoryResult.categories);
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
  }, [organizationId, refreshVersion, status, usesLocalRows]);

  // With the offline runtime ready the list comes from this device, and is read
  // again whenever the runtime says the local rows may have changed.
  useEffect(() => {
    if (!workspace) {
      return;
    }
    let current = true;
    const { outbox, writer } = workspace.stores;
    Promise.all([
      writer.rows("products"),
      writer.rows("categories"),
      pendingProducts(outbox),
    ])
      .then(([productRows, categoryRows, pending]) => {
        if (!current) {
          return;
        }
        setProducts(listLocalProducts(productRows, organizationId, status));
        setCategories(listLocalCategories(categoryRows, organizationId));
        setSyncStates(new Map(pending.map((item) => [item.productId, item])));
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(errorMessage(cause));
          setIsLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [workspace, organizationId, status]);

  /** Shows the change: the local rows are read again, or the server's list is. */
  const refresh = useCallback(() => {
    if (workspace) {
      workspace.runtime.refreshCounts().catch(() => undefined);
      workspace.runtime.localDataChanged();
      return;
    }
    setRefreshVersion((version) => version + 1);
  }, [workspace]);

  const handleDraftChange = useCallback(
    (field: keyof ProductDraft, value: string) => {
      setDraft((current) => ({ ...current, [field]: value }));
    },
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const editingProduct = products.find(
        (product) => product.id === editingProductId
      );
      if (editingProductId && !editingProduct) {
        setError("Atualize a lista antes de editar este produto novamente.");
        refresh();
        return;
      }
      const action = editingProduct ? "update" : "create";
      setPendingAction(action);
      setError(null);
      setNotice(null);
      try {
        const description = draft.description.trim() || null;
        const categoryId = draft.categoryId || null;
        if (editingProduct) {
          const result = await orpcClient.product.update({
            categoryId,
            description,
            expectedVersion: editingProduct.version,
            id: editingProduct.id,
            name: draft.name,
            organizationId,
          });
          await keepLocalRow(workspace, result.product);
          setNotice(
            result.changed
              ? `Produto “${result.product.name}” atualizado.`
              : `O produto “${result.product.name}” continua sem alterações.`
          );
        } else {
          setNotice(
            await createProduct(workspace, organizationId, {
              categoryId,
              description,
              name: draft.name,
            })
          );
        }
        setEditingProductId(null);
        setDraft(emptyDraft);
        refresh();
      } catch (cause: unknown) {
        setError(errorMessage(cause, action));
        refresh();
      } finally {
        setPendingAction(null);
      }
    },
    [draft, editingProductId, organizationId, products, refresh, workspace]
  );

  const handleEdit = useCallback((product: ProductReadModel) => {
    setVariantsProductId(null);
    setMediaProductId(null);
    setEditingProductId(product.id);
    setDraft({
      categoryId: product.categoryId ?? "",
      description: product.description ?? "",
      name: product.name,
    });
    setError(null);
    setNotice(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingProductId(null);
    setDraft(emptyDraft);
    setError(null);
  }, []);

  const handleManageVariants = useCallback((product: ProductReadModel) => {
    setEditingProductId(null);
    setMediaProductId(null);
    setDraft(emptyDraft);
    setVariantsProductId(product.id);
    setError(null);
    setNotice(null);
  }, []);

  const handleCloseVariants = useCallback(() => {
    setVariantsProductId(null);
  }, []);

  const handleManageMedia = useCallback((product: ProductReadModel) => {
    setEditingProductId(null);
    setVariantsProductId(null);
    setDraft(emptyDraft);
    setMediaProductId(product.id);
    setError(null);
    setNotice(null);
  }, []);

  const handleCloseMedia = useCallback(() => {
    setMediaProductId(null);
  }, []);

  const handleVariantsUpdated = useCallback(
    (_product: ProductReadModel) => {
      // The variants live on the server: bring them to this device, then show them.
      workspace?.runtime.syncNow().catch(() => undefined);
      refresh();
    },
    [refresh, workspace]
  );

  const handleProductAction = useCallback(
    async (product: ProductReadModel, action: ProductAction) => {
      setPendingAction(`${action}:${product.id}`);
      setError(null);
      setNotice(null);
      try {
        const result = await orpcClient.product[action]({
          expectedVersion: product.version,
          id: product.id,
          organizationId,
        });
        await keepLocalRow(workspace, result.product);
        const actionLabel = action === "archive" ? "arquivado" : "restaurado";
        setNotice(
          result.changed
            ? `Produto “${result.product.name}” ${actionLabel}.`
            : `O produto “${result.product.name}” já estava nesse estado.`
        );
        refresh();
      } catch (cause: unknown) {
        setError(errorMessage(cause, action));
        refresh();
      } finally {
        setPendingAction(null);
      }
    },
    [organizationId, refresh, workspace]
  );

  const handleArchiveProduct = useCallback(
    (product: ProductReadModel) => handleProductAction(product, "archive"),
    [handleProductAction]
  );
  const handleRestoreProduct = useCallback(
    (product: ProductReadModel) => handleProductAction(product, "restore"),
    [handleProductAction]
  );

  const handleStatusClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const value = event.currentTarget.dataset.productStatus;
      if (value && isProductListStatus(value)) {
        setStatus(value);
        setEditingProductId(null);
        setVariantsProductId(null);
        setMediaProductId(null);
        setDraft(emptyDraft);
        setError(null);
        setNotice(null);
      }
    },
    []
  );

  const editingProduct =
    products.find((product) => product.id === editingProductId) ?? null;
  // typed and not sent: the form against an empty one, or against the product being edited
  useReportUnsentWork(
    isDraftChanged(
      draft,
      editingProduct
        ? {
            categoryId: editingProduct.categoryId ?? "",
            description: editingProduct.description ?? "",
            name: editingProduct.name,
          }
        : emptyDraft
    )
  );
  const variantsProduct =
    products.find((product) => product.id === variantsProductId) ?? null;
  const mediaProduct =
    products.find((product) => product.id === mediaProductId) ?? null;

  return (
    <div className="products-page">
      <section className="categories-heading">
        <div>
          <p className="categories-eyebrow">Gestão de catálogo</p>
          <h1>Produtos</h1>
          <p className="categories-intro-copy">
            Cadastre os itens da organização e defina combinações vendáveis
            explicitamente. As quantidades em estoque ficam na tela{" "}
            <a href="/inventory">Estoque</a>, onde você recebe, conta e baixa
            cada variante.
          </p>
        </div>
      </section>

      {workspace && !workspace.online ? (
        <p className="categories-message is-success" role="status">
          Sem conexão. Você pode cadastrar produtos; eles são enviados quando a
          conexão voltar. Editar, arquivar, variantes e imagens precisam de
          conexão.
        </p>
      ) : null}

      <nav aria-label="Estado dos produtos" className="category-tabs">
        {productStatuses.map(([value, label]) => (
          <button
            aria-pressed={status === value}
            className={
              status === value ? "category-tab is-selected" : "category-tab"
            }
            data-product-status={value}
            key={value}
            onClick={handleStatusClick}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>

      {status === "active" || editingProduct ? (
        <ProductForm
          categories={categories}
          draft={draft}
          editingProduct={editingProduct}
          isPending={pendingAction !== null}
          onCancel={handleCancelEdit}
          onChange={handleDraftChange}
          onSubmit={handleSubmit}
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

      <ProductList
        categories={categories}
        isLoading={isLoading}
        isOffline={workspace !== null && !workspace.online}
        onArchive={handleArchiveProduct}
        onEdit={handleEdit}
        onManageMedia={handleManageMedia}
        onManageVariants={handleManageVariants}
        onRestore={handleRestoreProduct}
        pendingAction={pendingAction}
        products={products}
        status={status}
        syncStates={syncStates}
      />

      {variantsProduct ? (
        <ProductVariantsPanel
          key={variantsProduct.id}
          onClose={handleCloseVariants}
          onProductUpdated={handleVariantsUpdated}
          organizationId={organizationId}
          product={variantsProduct}
        />
      ) : null}
      {mediaProduct ? (
        <ProductMediaPanel
          key={mediaProduct.id}
          onClose={handleCloseMedia}
          organizationId={organizationId}
          product={mediaProduct}
        />
      ) : null}
    </div>
  );
}
