import type { ProductReadModel } from "@polaris/contracts";
import {
  type ComponentType,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useCurrentOrganization } from "../lib/current-organization";
import { browserConnection } from "../lib/browser-connection";
import { calendarDayInTimezone } from "../lib/dates";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { keepForReturn, takeKept } from "../lib/kept-for-return";
import { isDraftChanged, useReportUnsentWork } from "../lib/unsent-work";
import { useLocalWorkspace } from "../offline/runtime/use-local-workspace";
import {
  LimitHelp,
  LimitLeaveScope,
  useLimitHelp,
} from "../subscription/limit-help";
import { isLimitReached } from "../subscription/limit-help-model";
import {
  createProduct,
  keepLocalRow,
  type NewProductIds,
  newProductIds,
} from "./product-commands";
import { ProductDialog, type ProductTab } from "./product-dialog";
import type { ProductImportDialogProps } from "./product-import/product-import-dialog";
import {
  isCategoryUnavailable,
  isProductAlreadyCreated,
  PRODUCT_LIMIT_REACHED,
  type ProductAction,
  productErrorMessage,
} from "./product-errors";
import { emptyDraft, type ProductDraft } from "./product-form";
import { ProductList, type ProductListStatus } from "./product-list";
import { validateOpening } from "./product-opening-model";
import { filterByName } from "./product-search-model";
import type { VariantConfigurationDraft } from "./product-variants-model";
import type { ProductLinkFailure } from "./products-link-model";
import {
  ActionFeedback,
  LoadErrorNotice,
  OFFLINE_NOTICE_ID,
  OfflineNotice,
  importedNotice,
  PRODUCT_STATUS_OPTIONS,
  ProductSearch,
  ProductsHeader,
} from "./products-page-parts";
import { StatusNav } from "./screen-parts";
import { useProductsData } from "./use-products-data";
import { useProductsLink } from "./use-products-link";

/** The data of a product as the form shows it, to edit or to compare with what was typed. */
function draftOf(product: ProductReadModel): ProductDraft {
  return {
    ...emptyDraft,
    categoryId: product.categoryId ?? "",
    description: product.description ?? "",
    name: product.name,
  };
}

/** The tabs still holding work, in the order of the dialog, as the notice says them: "Variantes e Imagens". */
function tabsText(tabs: ProductTab[]): string {
  return (["variantes", "imagens"] as const)
    .filter((tab) => tabs.includes(tab))
    .map((tab) => (tab === "variantes" ? "Variantes" : "Imagens"))
    .join(" e ");
}

/** The version an edit is sent with: the list's, or the newer one a save that kept the dialog open answered with. */
function versionToSend(
  product: ProductReadModel,
  saved: { id: string; version: number } | null
): number {
  return saved?.id === product.id
    ? Math.max(product.version, saved.version)
    : product.version;
}

/** What a saved edit says; with work left in another tab (the dialog stays open), it says that too. */
function editNotice(
  product: ProductReadModel,
  changed: boolean,
  unsent: ProductTab[]
): string {
  const saved = changed
    ? `Produto “${product.name}” atualizado.`
    : `O produto “${product.name}” continua sem alterações.`;
  if (unsent.length === 0) {
    return saved;
  }
  return `${saved} ${tabsText(unsent)} ainda têm alterações sem salvar.`;
}

/**
 * Creates the product of the draft with its opening stock, and says what was done; `null` when the draft does not
 * read (the dialog checked the fields before it sent: the same check gives what to send).
 */
async function createFromDraft(
  workspace: Parameters<typeof createProduct>[0],
  organizationId: string,
  draft: ProductDraft,
  options: Parameters<typeof createProduct>[3]
): Promise<string | null> {
  const opening = validateOpening(draft).value;
  if (!opening) {
    return null;
  }
  return await createProduct(
    workspace,
    organizationId,
    {
      categoryId: draft.categoryId || null,
      description: draft.description.trim() || null,
      initialStock: opening.initialStock,
      listPrice: opening.listPrice,
      name: draft.name,
    },
    options
  );
}

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

/** The variants typed and kept for a product, if they are of the product the dialog shows. */
interface KeptVariants {
  draft: VariantConfigurationDraft;
  productId: string;
}

function keptVariantsOf(
  kept: KeptVariants | null,
  productId: string | null
): VariantConfigurationDraft | null {
  return kept !== null && kept.productId === productId ? kept.draft : null;
}

/** Variants kept for a product still in the list: one that left it (archived, removed) holds no work to warn about. */
function isKeptFor(
  kept: KeptVariants | null,
  products: ProductReadModel[]
): boolean {
  return (
    kept !== null && products.some((product) => product.id === kept.productId)
  );
}

/**
 * What the page kept when the app took the person to another screen with no load ("Conhecer o Pro"): the draft closed
 * as by Esc, and the variants typed, back on "voltar" (corte 1.6, AC-7).
 */
interface ProductsReturn {
  dialogProductId: string | null;
  draft: ProductDraft;
  keptKey: string | null;
  names: NewProductIds | null;
  variantsDraft: KeptVariants | null;
}

const returnKey = (organizationId: string) => `products:${organizationId}`;

const NOTHING_KEPT: ProductsReturn = {
  dialogProductId: null,
  draft: emptyDraft,
  keptKey: null,
  names: null,
  variantsDraft: null,
};

/** What the page keeps when it leaves the tree: only a draft kept by Esc, or variants typed. */
function toKeep(state: ProductsReturn): ProductsReturn | null {
  return state.keptKey === null && state.variantsDraft === null ? null : state;
}

const IMPORT_NEEDS_CONNECTION = "Importar planilha precisa de conexão.";

/** Said when the chunk of the import could not be downloaded (a deploy since the page loaded, or the network). */
const IMPORT_LOAD_FAILED =
  "Não foi possível abrir a importação. Recarregue a página e tente de novo.";

/**
 * The import of a spreadsheet (corte 2.5): its code and the reading of the CSV are a chunk of their own, downloaded the
 * first time the person opens it and kept out of the precache (there is no import offline, `pwa/service-worker-plugin.ts`).
 */
function useImportDialog(onLoadFailed: () => void) {
  const [open, setOpen] = useState(false);
  const [Dialog, setDialog] =
    useState<ComponentType<ProductImportDialogProps> | null>(null);
  const loading = useRef<boolean>(false);
  const failedRef = useRef(onLoadFailed);
  failedRef.current = onLoadFailed;
  const openImport = useCallback(() => {
    setOpen(true);
    if (loading.current) {
      return;
    }
    loading.current = true;
    import("./product-import/product-import-dialog")
      .then((module) => setDialog(() => module.ProductImportDialog))
      .catch(() => {
        loading.current = false;
        setOpen(false);
        failedRef.current();
      });
  }, []);
  const closeImport = useCallback(() => setOpen(false), []);
  return { closeImport, Dialog, open, openImport };
}

/**
 * The dialog of the import once its chunk arrived. "Conhecer o Pro" inside it closes it before the Assinatura opens; the
 * file read lives in this page only, so it does not come back on "voltar" (a new file is read again).
 */
function ImportDialogSlot({
  Dialog,
  ...props
}: ProductImportDialogProps & {
  Dialog: ComponentType<ProductImportDialogProps> | null;
}) {
  return Dialog ? (
    <LimitLeaveScope value={props.onClose}>
      <Dialog {...props} />
    </LimitLeaveScope>
  ) : null;
}

/** A new product refused because of its category: the category takes the focus, not the alert. */
function isCategoryRefusal(
  cause: unknown,
  action: "create" | "update"
): boolean {
  return action === "create" && isCategoryUnavailable(cause);
}

export function ProductsPage() {
  const { organization, organizationId } = useCurrentOrganization();
  const workspace = useLocalWorkspace(organizationId);
  const [status, setStatus] = useState<ProductListStatus>("active");
  const { categories, isLoading, loadError, products, refresh, syncStates } =
    useProductsData(workspace, organizationId, status);
  const [query, setQuery] = useState("");
  // what the page kept when it was left for another screen of the app, back once
  const [returned] = useState(
    () => takeKept<ProductsReturn>(returnKey(organizationId)) ?? NOTHING_KEPT
  );
  // the product dialog: a new product (`null`) or one that exists, on one of its tabs
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogProductId, setDialogProductId] = useState<string | null>(
    returned.dialogProductId
  );
  const [dialogTab, setDialogTab] = useState<ProductTab>("dados");
  // the draft kept when the dialog was closed by Esc, "Fechar" or the step back: "new", or the id of the product
  const keptRef = useRef<string | null>(returned.keptKey);
  // where the focus goes back to when the dialog closes without a message to read: what opened it
  const originRef = useRef<() => HTMLElement | null>(() => null);
  // the tabs of the dialog with work not saved yet: a save of the data does not close the dialog over it
  const unsentTabsRef = useRef<ProductTab[]>([]);
  // the version a save that kept the dialog open answered with, until the list read again brings it
  const savedVersionRef = useRef<{ id: string; version: number } | null>(null);
  const [draft, setDraft] = useState<ProductDraft>(returned.draft);
  // the configuration of the variants typed in the dialog and not saved, kept like the data by Esc, × and the step back
  // (the dialog's popup leaves the page when it closes, and the form with it); "Cancelar" and its save drop it
  const [variantsDraft, setVariantsDraft] = useState<KeptVariants | null>(
    returned.variantsDraft
  );
  // counts the refusals of the chosen category: the form opens "Mais detalhes" and takes the focus to it
  const [categoryRefusal, setCategoryRefusal] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // the product the last action archived: the notice offers to restore it
  const [undoProduct, setUndoProduct] = useState<ProductReadModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  // what goes with the plan's limit refusal (corte 61b, corte 1.6); shown only while that error is shown
  const { help: limitHelp, show: showLimitHelp } = useLimitHelp();
  const showLimitHelpOn = useCallback(
    (cause: unknown, action: "create" | "update") => {
      if (action === "create" && isLimitReached(cause)) {
        showLimitHelp("variants");
      }
    },
    [showLimitHelp]
  );
  // the product of the address could not be read: what to say and whether trying again can help
  const [linkFailure, setLinkFailure] = useState<ProductLinkFailure | null>(
    null
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // the names of the product the open form creates: born with the first try, kept for its retries, dropped with the form
  const newProductNames = useRef<NewProductIds | null>(returned.names);
  const rootRef = useRef<HTMLDivElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<string | null>(null);
  noticeRef.current = notice;

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
  /** After a save: the alert takes the focus, or the category when the category was refused (the form moves it). */
  const focusAfterSave = useCallback(
    (categoryRefused: boolean) => {
      if (categoryRefused) {
        setCategoryRefusal((count) => count + 1);
      } else {
        focusFeedback();
      }
    },
    [focusFeedback]
  );

  /** What the last action said goes away when another starts. */
  const clearMessages = useCallback(() => {
    setError(null);
    setLinkFailure(null);
    setNotice(null);
    setUndoProduct(null);
  }, []);

  const handleImportLoadFailed = useCallback(() => {
    setError(IMPORT_LOAD_FAILED);
    focusFeedback();
  }, [focusFeedback]);
  const {
    closeImport,
    Dialog: ImportDialog,
    open: importOpen,
    openImport,
  } = useImportDialog(handleImportLoadFailed);
  const handleImport = useCallback(() => {
    clearMessages();
    // the address (`?importar=1`) opens it too: without a connection it says why instead of a download that fails
    if (!browserConnection.isOnline()) {
      setError(IMPORT_NEEDS_CONNECTION);
      focusFeedback();
      return;
    }
    openImport();
  }, [clearMessages, focusFeedback, openImport]);
  // after "Ver os produtos" the focus goes to the notice of what entered, not back to the button
  const importFinalFocus = useCallback(
    () => (noticeRef.current ? false : (importButtonRef.current ?? true)),
    []
  );
  const handleShowImported = useCallback(
    (entered: number) => {
      clearMessages();
      setNotice(importedNotice(entered));
      closeImport();
    },
    [clearMessages, closeImport]
  );
  // what the import said takes the focus once the dialog is gone, on the notice itself (as `handleDialogClosed`)
  const handleImportClosed = useCallback(() => {
    if (noticeRef.current) {
      focusLater(() => feedbackRef.current?.focus());
    }
  }, []);
  const handleImported = useCallback(() => {
    // the products live on the server: bring them to this device, then show them
    workspace?.runtime.syncNow().catch(() => undefined);
    refresh();
  }, [refresh, workspace]);

  /**
   * Opens the dialog of a product (or of a new one) on a tab. A draft kept by Esc for the same product comes back;
   * any other starts from the product (or empty), and a new product gets new names at its first try.
   */
  const openDialog = useCallback(
    (product: ProductReadModel | null, tab: ProductTab) => {
      const key = product?.id ?? "new";
      if (keptRef.current !== key) {
        newProductNames.current = null;
        setDraft(product ? draftOf(product) : emptyDraft);
      }
      // the variants typed for this product come back; those of another are dropped, as its data
      setVariantsDraft((current) =>
        current?.productId === product?.id ? current : null
      );
      keptRef.current = null;
      // back to where the person was: the menu of the product, or the button that opens a new one
      originRef.current = () =>
        product
          ? (rootRef.current?.querySelector<HTMLElement>(
              `[data-product-id="${product.id}"] [aria-haspopup]`
            ) ?? newButtonRef.current)
          : newButtonRef.current;
      setDialogProductId(product?.id ?? null);
      setDialogTab(tab);
      clearMessages();
      setDialogOpen(true);
    },
    [clearMessages]
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
        (product) => product.id === dialogProductId
      );
      if (dialogProductId && !editingProduct) {
        setError("Atualize a lista antes de editar este produto novamente.");
        focusFeedback();
        refresh();
        return;
      }
      const action = editingProduct ? "update" : "create";
      // a refusal of the category takes the focus to the category instead of the alert
      let categoryRefused = false;
      setPendingAction(action);
      setError(null);
      setNotice(null);
      setUndoProduct(null);
      try {
        if (editingProduct) {
          const result = await orpcClient.product.update({
            categoryId: draft.categoryId || null,
            description: draft.description.trim() || null,
            expectedVersion: versionToSend(
              editingProduct,
              savedVersionRef.current
            ),
            id: editingProduct.id,
            name: draft.name,
            organizationId,
          });
          await keepLocalRow(workspace, result.product);
          const unsent = unsentTabsRef.current;
          setNotice(editNotice(result.product, result.changed, unsent));
          if (unsent.length > 0) {
            // the variants or the images typed in another tab are not sent by this button: the dialog stays
            savedVersionRef.current = {
              id: result.product.id,
              version: result.product.version,
            };
            setDraft(draftOf(result.product));
            refresh();
            return;
          }
        } else {
          newProductNames.current ??= newProductIds();
          const created = await createFromDraft(
            workspace,
            organizationId,
            draft,
            {
              ids: newProductNames.current,
              today: calendarDayInTimezone(new Date(), organization.timezone),
            }
          );
          if (created === null) {
            return;
          }
          setNotice(created);
          newProductNames.current = null;
        }
        keptRef.current = null;
        setDialogOpen(false);
        refresh();
      } catch (cause: unknown) {
        if (isProductAlreadyCreated(cause)) {
          // the first try was saved with other data: the next one is a new product, not a retry
          newProductNames.current = null;
        }
        setError(productErrorMessage(cause, action));
        showLimitHelpOn(cause, action);
        categoryRefused = isCategoryRefusal(cause, action);
        refresh();
      } finally {
        setPendingAction(null);
        focusAfterSave(categoryRefused);
      }
    },
    [
      dialogProductId,
      draft,
      showLimitHelpOn,
      focusAfterSave,
      organization.timezone,
      organizationId,
      products,
      refresh,
      workspace,
    ]
  );

  // `?produto=` and `?novo=1`: the dialog the address names opens, on the variants of the product or for a new one
  const { retry: retryLink } = useProductsLink(workspace, organizationId, {
    onImport: handleImport,
    onNew: () => openDialog(null, "dados"),
    onNotice: (message) => {
      setLinkFailure(null);
      setError(message);
      focusFeedback();
    },
    onProduct: (product) => {
      setStatus(product.status === "archived" ? "archived" : "active");
      openDialog(product, "variantes");
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

  const handleNew = useCallback(() => openDialog(null, "dados"), [openDialog]);
  const handleEdit = useCallback(
    (product: ProductReadModel) => openDialog(product, "dados"),
    [openDialog]
  );
  const handleManageVariants = useCallback(
    (product: ProductReadModel) => openDialog(product, "variantes"),
    [openDialog]
  );
  const handleManageMedia = useCallback(
    (product: ProductReadModel) => openDialog(product, "imagens"),
    [openDialog]
  );

  /** "Cancelar": the dialog closes and what was typed is thrown away. */
  const handleCancelDialog = useCallback(() => {
    keptRef.current = null;
    setVariantsDraft(null);
    setDialogOpen(false);
    setError(null);
    setNotice(null);
  }, []);

  /**
   * Esc, "Fechar" and the step back: the dialog closes and a draft that changed stays, in memory, for its next opening
   * (one that did not change is not kept: the next opening starts from the product as the list has it then).
   */
  const handleDismissDialog = useCallback(() => {
    const product = products.find((item) => item.id === dialogProductId);
    const changed = isDraftChanged(
      draft,
      product ? draftOf(product) : emptyDraft
    );
    keptRef.current = changed ? (dialogProductId ?? "new") : null;
    setDialogOpen(false);
    setError(null);
    setNotice(null);
  }, [dialogProductId, draft, products]);

  /** The draft is empty again only once the dialog has finished closing (and only when nothing was kept). */
  const handleDialogClosed = useCallback(() => {
    // on purpose, `dialogProductId` outlives an Esc that kept a draft: the page-wide unsent sign compares the kept data
    // with that product, and a product that left the list drops its draft (handleStatus)
    if (keptRef.current === null) {
      newProductNames.current = null;
      setDialogProductId(null);
      setDraft(emptyDraft);
    }
    // what the save said takes the focus, on the notice itself
    if (noticeRef.current) {
      focusLater(() => feedbackRef.current?.focus());
    }
  }, []);

  /** With a message to read the focus goes to it once the dialog is gone; without one, back to what opened it. */
  const finalFocus = useCallback(
    () => (noticeRef.current ? false : (originRef.current() ?? true)),
    []
  );

  const handleUnsentTabs = useCallback((tabs: ProductTab[]) => {
    unsentTabsRef.current = tabs;
  }, []);

  const handleVariantsDraftChange = useCallback(
    (productId: string, next: VariantConfigurationDraft | null) => {
      setVariantsDraft((current) => {
        if (next !== null) {
          return { draft: next, productId };
        }
        return current?.productId === productId ? null : current;
      });
    },
    []
  );

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
      clearMessages();
      // the variants typed for a product of the other list go with it
      if (value !== status) {
        setVariantsDraft(null);
      }
      // the draft kept for a product of the other list goes with it (a new product's draft stays)
      if (keptRef.current !== null && keptRef.current !== "new") {
        keptRef.current = null;
        setDialogProductId(null);
        setDraft(emptyDraft);
      }
    },
    [clearMessages, status]
  );

  const dialogProduct =
    products.find((product) => product.id === dialogProductId) ?? null;
  const dialogShown =
    dialogOpen && (dialogProductId === null || dialogProduct !== null);
  // the product left the list while its dialog was open (archived on another device and synced): the dialog closes and
  // keeps the draft, instead of turning into a new product; an address waiting for its product is not this
  const dialogWasShown = useRef(false);
  useEffect(() => {
    if (dialogShown) {
      dialogWasShown.current = true;
      return;
    }
    if (dialogOpen && dialogWasShown.current) {
      keptRef.current = dialogProductId;
      setDialogOpen(false);
    }
    dialogWasShown.current = false;
  }, [dialogOpen, dialogProductId, dialogShown]);
  // typed and not sent: the form against an empty one, or against the product being edited
  useReportUnsentWork(
    isDraftChanged(
      draft,
      dialogProduct ? draftOf(dialogProduct) : emptyDraft
    ) || isKeptFor(variantsDraft, products)
  );
  // the page leaves the tree when the app opens another screen with no load: a kept draft waits for "voltar"
  const toReturn = useRef<ProductsReturn | null>(null);
  toReturn.current = toKeep({
    dialogProductId,
    draft,
    keptKey: keptRef.current,
    names: newProductNames.current,
    variantsDraft,
  });
  useEffect(
    () => () => keepForReturn(returnKey(organizationId), toReturn.current),
    [organizationId]
  );
  const visibleProducts = filterByName(products, query);
  const isOffline = workspace !== null && !workspace.online;
  const listIsShown = !(isLoading || loadError);
  const feedbackError = linkFeedbackError(
    error,
    linkFailure,
    listIsShown,
    handleRetryLink
  );
  const shownLimitHelp =
    feedbackError.message === PRODUCT_LIMIT_REACHED ? limitHelp : null;
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
          importButtonRef={importButtonRef}
          isOffline={isOffline}
          onImport={handleImport}
          onNew={handleNew}
          showNew={status === "active"}
        />
        {isOffline ? <OfflineNotice /> : null}
        {/* while the dialog is open it covers this part of the screen: what the actions say is said inside it */}
        <ActionFeedback
          error={dialogShown ? null : feedbackError.message}
          errorExtra={<LimitHelp help={shownLimitHelp} />}
          notice={dialogShown ? null : notice}
          onRetryError={feedbackError.onRetry}
          onUndo={undoProduct ? handleUndoArchive : undefined}
          regionRef={feedbackRef}
          undoDisabled={isOffline || pendingAction !== null}
          undoReasonId={isOffline ? OFFLINE_NOTICE_ID : undefined}
        />

        {/* the dialog of a product that exists opens once the product is in the list (an address can name it first);
            "Conhecer o Pro" inside it closes it as Esc does, keeping the draft */}
        <LimitLeaveScope value={handleDismissDialog}>
          <ProductDialog
            categories={categories}
            categoryRefusal={categoryRefusal}
            draft={draft}
            error={dialogShown ? feedbackError.message : null}
            errorExtra={<LimitHelp help={shownLimitHelp} />}
            feedbackRef={feedbackRef}
            finalFocus={finalFocus}
            isOffline={isOffline}
            isPending={pendingAction === "create" || pendingAction === "update"}
            notice={dialogShown ? notice : null}
            onCancel={handleCancelDialog}
            onChange={handleDraftChange}
            onClosed={handleDialogClosed}
            onDismiss={handleDismissDialog}
            onProductUpdated={handleVariantsUpdated}
            onSubmit={handleSubmit}
            onTabChange={setDialogTab}
            onUnsentTabsChange={handleUnsentTabs}
            onVariantsDraftChange={handleVariantsDraftChange}
            open={dialogShown}
            organizationId={organizationId}
            product={dialogProduct}
            tab={dialogTab}
            variantsDraft={keptVariantsOf(variantsDraft, dialogProductId)}
          />
        </LimitLeaveScope>

        <ImportDialogSlot
          categories={categories}
          Dialog={ImportDialog}
          finalFocus={importFinalFocus}
          onClose={closeImport}
          onClosed={handleImportClosed}
          onEntered={handleImported}
          onShowProducts={handleShowImported}
          open={importOpen}
        />

        <ProductSearch onChange={setQuery} value={query} />
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
