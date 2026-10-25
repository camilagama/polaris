import type { ProductReadModel } from "@polaris/contracts";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useCurrentOrganization } from "../lib/current-organization";
import { calendarDayInTimezone } from "../lib/dates";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { isDraftChanged, useReportUnsentWork } from "../lib/unsent-work";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import {
  createProduct,
  keepLocalRow,
  type NewProductIds,
  newProductIds,
} from "./product-commands";
import {
  isProductAlreadyCreated,
  type ProductAction,
  type ProductLimitHelp,
  productErrorMessage,
} from "./product-errors";
import { emptyDraft, type ProductDraft, ProductForm } from "./product-form";
import { LimitHelp, useLimitHelp } from "./product-limit-help";
import { ProductList, type ProductListStatus } from "./product-list";
import { ProductMediaPanel } from "./product-media-panel";
import { validateOpening } from "./product-opening-model";
import { filterByName } from "./product-search-model";
import { ProductVariantsPanel } from "./product-variants-panel";
import {
  ActionFeedback,
  LoadErrorNotice,
  OFFLINE_NOTICE_ID,
  OfflineNotice,
  PRODUCT_STATUS_OPTIONS,
  ProductSearch,
  ProductsHeader,
} from "./products-page-parts";
import { StatusNav } from "./screen-parts";
import { useProductsData } from "./use-products-data";
import type { ProductLinkFailure } from "./products-link-model";
import { useProductsLink } from "./use-products-link";

function countTextFor(shown: number, total: number, query: string): string {
  if (query.trim() !== "") {
    return `${shown} de ${total}`;
  }
  return `${total} ${total === 1 ? "produto" : "produtos"}`;
}

/**
 * An action's error comes first; the failed read of the address's product is said only once the list is shown, so
 * a server that is out says it once (the list's alert, which also reads the product again).
 */
function linkFeedbackError(
  error: string | null,
  failure: ProductLinkFailure | null,
  listIsShown: boolean,
  retry: () => void
): {
  fromLink: boolean;
  message: string | null;
  onRetry: (() => void) | undefined;
} {
  if (error === null && failure && listIsShown) {
    return {
      fromLink: true,
      message: failure.message,
      onRetry: failure.retryable ? retry : undefined,
    };
  }
  return { fromLink: false, message: error, onRetry: undefined };
}

export function ProductsPage() {
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  const workspace = useLocalWorkspace(organizationId);
  const [status, setStatus] = useState<ProductListStatus>("active");
  const { categories, isLoading, loadError, products, refresh, syncStates } =
    useProductsData(workspace, organizationId, status);
  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [variantsProductId, setVariantsProductId] = useState<string | null>(
    null
  );
  const [mediaProductId, setMediaProductId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft);
  const [notice, setNotice] = useState<string | null>(null);
  // the product the last action archived: the notice offers to restore it
  const [undoProduct, setUndoProduct] = useState<ProductReadModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  // what goes with the plan's limit refusal (stage 2 of the corte 61b); shown only while that error is shown
  const [limitHelp, setLimitHelp] = useState<ProductLimitHelp>(null);
  const showLimitHelp = useLimitHelp(setLimitHelp, {
    billingSelfService,
    organizationId,
    role: organization.role,
  });
  // the product of the address could not be read: what to say and whether trying again can help
  const [linkFailure, setLinkFailure] = useState<ProductLinkFailure | null>(
    null
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // the names of the product the open form creates: born with the first try, kept for its retries, dropped with the form
  const newProductNames = useRef<NewProductIds | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const variantsHeadingRef = useRef<HTMLDivElement>(null);
  const mediaHeadingRef = useRef<HTMLDivElement>(null);

  /**
   * The result of an action is said at the top of the screen, and a person far down the list is taken to it. The
   * focus moves in an effect, after the render that draws the message: a timer could run before it.
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

  /** Back to where the person was: the menu of the product, or the button that opens a new one. */
  const focusRow = useCallback((productId: string | null) => {
    focusLater(() => {
      const trigger = productId
        ? rootRef.current?.querySelector<HTMLElement>(
            `[data-product-id="${productId}"] [aria-haspopup]`
          )
        : null;
      (trigger ?? newButtonRef.current)?.focus();
    });
  }, []);

  /** Only one of the form, the variants and the images is open at a time, and a new message starts empty. */
  const openOnly = useCallback(
    (panel: {
      editing?: string | null;
      form?: boolean;
      media?: string | null;
      variants?: string | null;
    }) => {
      newProductNames.current = null;
      setEditingProductId(panel.editing ?? null);
      setFormOpen(panel.form ?? false);
      setMediaProductId(panel.media ?? null);
      setVariantsProductId(panel.variants ?? null);
      setError(null);
      setLinkFailure(null);
      setNotice(null);
      setUndoProduct(null);
    },
    []
  );

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
        focusFeedback();
        refresh();
        return;
      }
      const action = editingProduct ? "update" : "create";
      setPendingAction(action);
      setError(null);
      setNotice(null);
      setUndoProduct(null);
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
          // the form has checked the fields before it sends; the same check gives what to send
          const opening = validateOpening(draft).value;
          if (!opening) {
            return;
          }
          newProductNames.current ??= newProductIds();
          setNotice(
            await createProduct(
              workspace,
              organizationId,
              {
                categoryId,
                description,
                initialStock: opening.initialStock,
                listPrice: opening.listPrice,
                name: draft.name,
              },
              {
                ids: newProductNames.current,
                today: calendarDayInTimezone(new Date(), organization.timezone),
              }
            )
          );
          newProductNames.current = null;
        }
        setEditingProductId(null);
        setFormOpen(false);
        setDraft(emptyDraft);
        refresh();
      } catch (cause: unknown) {
        if (isProductAlreadyCreated(cause)) {
          // the first try was saved with other data: the next one is a new product, not a retry
          newProductNames.current = null;
        }
        setError(productErrorMessage(cause, action));
        showLimitHelp(cause, action);
        refresh();
      } finally {
        setPendingAction(null);
        focusFeedback();
      }
    },
    [
      draft,
      showLimitHelp,
      editingProductId,
      focusFeedback,
      organization.timezone,
      organizationId,
      products,
      refresh,
      workspace,
    ]
  );

  // `?produto=` and `?novo=1`: the panel the address names opens and takes the focus on its title
  const formHeadingRef = useRef<HTMLDivElement>(null);
  const [formStartsOnHeading, setFormStartsOnHeading] = useState(false);
  const { retry: retryLink } = useProductsLink(workspace, organizationId, {
    onNew: () => {
      openOnly({ form: true });
      setDraft(emptyDraft);
      setFormStartsOnHeading(true);
    },
    onNotice: (message) => {
      setLinkFailure(null);
      setError(message);
      focusFeedback();
    },
    onProduct: (product) => {
      setStatus(product.status === "archived" ? "archived" : "active");
      openOnly({ variants: product.id });
      setDraft(emptyDraft);
    },
    onReadFailed: setLinkFailure,
  });
  const handleRetryLink = useCallback(() => {
    setLinkFailure(null);
    retryLink();
  }, [retryLink]);
  // the list's "Tentar novamente" also reads the product of the address again, so the panel opens on the second try
  const handleRetryList = useCallback(() => {
    handleRetryLink();
    refresh();
  }, [handleRetryLink, refresh]);

  const handleNew = useCallback(() => {
    if (formOpen) {
      // what was typed is not thrown away by a tap on the button: the person goes back to the form
      focusLater(() =>
        rootRef.current?.querySelector<HTMLElement>("#product-name")?.focus()
      );
      return;
    }
    setFormStartsOnHeading(false);
    openOnly({ form: true });
    setDraft(emptyDraft);
  }, [formOpen, openOnly]);

  const handleEdit = useCallback(
    (product: ProductReadModel) => {
      setFormStartsOnHeading(false);
      openOnly({ editing: product.id, form: true });
      setDraft({
        ...emptyDraft,
        categoryId: product.categoryId ?? "",
        description: product.description ?? "",
        name: product.name,
      });
    },
    [openOnly]
  );

  const handleCancelForm = useCallback(() => {
    focusRow(editingProductId);
    openOnly({});
    setDraft(emptyDraft);
  }, [editingProductId, focusRow, openOnly]);

  const handleManageVariants = useCallback(
    (product: ProductReadModel) => {
      openOnly({ variants: product.id });
      setDraft(emptyDraft);
    },
    [openOnly]
  );

  const handleCloseVariants = useCallback(() => {
    focusRow(variantsProductId);
    setVariantsProductId(null);
  }, [focusRow, variantsProductId]);

  const handleManageMedia = useCallback(
    (product: ProductReadModel) => {
      openOnly({ media: product.id });
      setDraft(emptyDraft);
    },
    [openOnly]
  );

  const handleCloseMedia = useCallback(() => {
    focusRow(mediaProductId);
    setMediaProductId(null);
  }, [focusRow, mediaProductId]);

  // the images panel opens away from the row that asked: the person is taken to it
  useEffect(() => {
    if (mediaProductId) {
      focusLater(() => mediaHeadingRef.current?.focus());
    }
  }, [mediaProductId]);

  const handleVariantsUpdated = useCallback(
    (_product: ProductReadModel) => {
      // The variants live on the server: bring them to this device, then show them.
      workspace?.runtime.syncNow().catch(() => undefined);
      refresh();
    },
    [refresh, workspace]
  );

  const handleProductAction = useCallback(
    async (
      product: ProductReadModel,
      action: ProductAction,
      isUndo = false
    ) => {
      setPendingAction(`${action}:${product.id}`);
      setError(null);
      // the undo keeps the archived notice (and its button) until the restore works: a failure can be tried again
      if (!isUndo) {
        setNotice(null);
        setUndoProduct(null);
      }
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
        setUndoProduct(
          action === "archive" && result.changed ? result.product : null
        );
        refresh();
      } catch (cause: unknown) {
        setError(productErrorMessage(cause, action));
        refresh();
      } finally {
        setPendingAction(null);
        focusFeedback();
      }
    },
    [focusFeedback, organizationId, refresh, workspace]
  );

  const handleArchiveProduct = useCallback(
    (product: ProductReadModel) => handleProductAction(product, "archive"),
    [handleProductAction]
  );
  const handleRestoreProduct = useCallback(
    (product: ProductReadModel) => handleProductAction(product, "restore"),
    [handleProductAction]
  );

  const handleUndoArchive = useCallback(() => {
    if (undoProduct) {
      handleProductAction(undoProduct, "restore", true);
    }
  }, [handleProductAction, undoProduct]);

  const handleStatus = useCallback(
    (value: ProductListStatus) => {
      setStatus(value);
      openOnly({});
      setDraft(emptyDraft);
    },
    [openOnly]
  );

  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
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
            ...emptyDraft,
            categoryId: editingProduct.categoryId ?? "",
            description: editingProduct.description ?? "",
            name: editingProduct.name,
          }
        : emptyDraft
    )
  );
  const variantsProduct =
    products.find((product) => product.id === variantsProductId) ?? null;
  // the variants panel opens away from the row that asked (or from an address that named the product, which
  // is drawn only once its list has come): the person is taken to it when it is on the screen
  const variantsPanelId = variantsProduct?.id ?? null;
  useEffect(() => {
    if (variantsPanelId) {
      focusLater(() => variantsHeadingRef.current?.focus());
    }
  }, [variantsPanelId]);
  const mediaProduct =
    products.find((product) => product.id === mediaProductId) ?? null;
  const visibleProducts = filterByName(products, query);
  const isOffline = workspace !== null && !workspace.online;
  const listIsShown = !(isLoading || loadError);
  const feedbackError = linkFeedbackError(
    error,
    linkFailure,
    listIsShown,
    handleRetryLink
  );
  // the person is taken to the alert of the address when it appears (not before: the list's own may replace it)
  const linkAlertShown = feedbackError.fromLink;
  useEffect(() => {
    if (linkAlertShown) {
      focusFeedback();
    }
  }, [focusFeedback, linkAlertShown]);

  return (
    <div className="products-page" ref={rootRef}>
      <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
        <ProductsHeader
          buttonRef={newButtonRef}
          onNew={handleNew}
          showNew={status === "active"}
        />
        {isOffline ? <OfflineNotice /> : null}
        <ActionFeedback
          error={feedbackError.message}
          errorExtra={
            <LimitHelp error={feedbackError.message} help={limitHelp} />
          }
          notice={notice}
          onRetryError={feedbackError.onRetry}
          onUndo={undoProduct ? handleUndoArchive : undefined}
          regionRef={feedbackRef}
          undoDisabled={isOffline || pendingAction !== null}
          undoReasonId={isOffline ? OFFLINE_NOTICE_ID : undefined}
        />

        {formOpen ? (
          <ProductForm
            categories={categories}
            draft={draft}
            editingProduct={editingProduct}
            headingRef={formHeadingRef}
            isPending={pendingAction === "create" || pendingAction === "update"}
            onCancel={handleCancelForm}
            onChange={handleDraftChange}
            onSubmit={handleSubmit}
            startOnHeading={formStartsOnHeading}
          />
        ) : null}
        {variantsProduct ? (
          <ProductVariantsPanel
            headingRef={variantsHeadingRef}
            key={variantsProduct.id}
            onClose={handleCloseVariants}
            onProductUpdated={handleVariantsUpdated}
            organizationId={organizationId}
            product={variantsProduct}
          />
        ) : null}
        {mediaProduct ? (
          <ProductMediaPanel
            headingRef={mediaHeadingRef}
            key={mediaProduct.id}
            onClose={handleCloseMedia}
            organizationId={organizationId}
            product={mediaProduct}
          />
        ) : null}

        <ProductSearch onChange={handleQueryChange} value={query} />
        <StatusNav
          label="Estado dos produtos"
          onSelect={handleStatus}
          options={PRODUCT_STATUS_OPTIONS}
          value={status}
        />

        {loadError ? (
          <LoadErrorNotice message={loadError} onRetry={handleRetryList} />
        ) : (
          <ProductList
            categories={categories}
            isLoading={isLoading}
            isOffline={isOffline}
            onArchive={handleArchiveProduct}
            onEdit={handleEdit}
            onManageMedia={handleManageMedia}
            onManageVariants={handleManageVariants}
            onNew={handleNew}
            onRestore={handleRestoreProduct}
            pendingAction={pendingAction}
            products={visibleProducts}
            query={query}
            status={status}
            syncStates={syncStates}
            total={products.length}
          />
        )}
        {listIsShown && visibleProducts.length > 0 ? (
          <p aria-live="polite" className="text-muted-foreground text-support">
            {countTextFor(visibleProducts.length, products.length, query)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
