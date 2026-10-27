import type { CategoryReadModel, ProductReadModel } from "@polaris/contracts";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { FORM_ELEMENT_CLASS, FORM_NOTICE_CLASS } from "@/ui/dialog-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { tryConnectionNow } from "../lib/browser-connection";
import { focusLater } from "../lib/focus";
import { UnsentWorkScope, useUnsentWorkScope } from "../lib/unsent-work";
import {
  PRODUCT_FORM_ID,
  type ProductDraft,
  ProductForm,
  productFormHasErrors,
} from "./product-form";
import { ProductMediaPanel } from "./product-media-panel";
import type { VariantConfigurationDraft } from "./product-variants-model";
import { ProductVariantsPanel } from "./product-variants-panel";
import { ActionFeedback } from "./products-page-parts";

/** The three tabs of a product that exists; a new one has only its data (the product in one step, AC-24). */
export type ProductTab = "dados" | "imagens" | "variantes";

const TAB_LABELS: Record<ProductTab, string> = {
  dados: "Dados",
  imagens: "Imagens",
  variantes: "Variantes",
};

/** The line the save button reads while there is no connection, above the footer. */
const OFFLINE_REASON_ID = "product-dialog-offline-reason";

interface ProductDialogProps {
  categories: CategoryReadModel[];
  /** Counts the refusals of the chosen category: the data open "Mais detalhes" with the focus on the category. */
  categoryRefusal: number;
  draft: ProductDraft;
  /** What the last action said: the dialog covers the top of the screen, so it is said here while it is open. */
  error: string | null;
  /** What follows the error (the way to the Pro after the plan's limit). */
  errorExtra?: ReactNode;
  /** The focus goes here when an action ends while the dialog is open: the alert at the top of its body. */
  feedbackRef: Ref<HTMLDivElement>;
  /** Where the focus goes when the dialog closes: the notice, or the control that opened it. */
  finalFocus: () => HTMLElement | boolean;
  isOffline: boolean;
  isPending: boolean;
  notice: string | null;
  /** "Cancelar": the dialog closes and the typed data is thrown away. */
  onCancel: () => void;
  onChange: (field: keyof ProductDraft, value: string) => void;
  /** The dialog has finished closing: the draft can be emptied without the form changing under the fade. */
  onClosed: () => void;
  /** Esc, "Fechar" and the step back of the phone: the dialog closes and the typed data is kept for the next opening. */
  onDismiss: () => void;
  onProductUpdated: (product: ProductReadModel) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTabChange: (tab: ProductTab) => void;
  /** The tabs other than "Dados" that hold work not saved yet (a save of the data must not close over it). */
  onUnsentTabsChange: (tabs: ProductTab[]) => void;
  /** Each change of what is typed in the configuration of the variants, kept by the page as the data are. */
  onVariantsDraftChange: (
    productId: string,
    draft: VariantConfigurationDraft | null
  ) => void;
  open: boolean;
  organizationId: string;
  /** The product being changed; `null` is a new product. */
  product: ProductReadModel | null;
  tab: ProductTab;
  /** The configuration of the variants typed for this product and kept by Esc, × or the step back. */
  variantsDraft: VariantConfigurationDraft | null;
}

/** Said in the dialog while there is no connection: the strip of the shell and of the page are under its veil. */
function OfflineAlert({ isNew }: { isNew: boolean }) {
  const [trying, setTrying] = useState(false);
  const handleTry = useCallback(() => {
    if (trying) {
      return;
    }
    setTrying(true);
    tryConnectionNow().finally(() => setTrying(false));
  }, [trying]);
  return (
    <Alert variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem internet.</AlertTitle>
      <AlertDescription className="grid justify-items-start gap-2">
        {isNew
          ? "Cadastrar funciona e é enviado depois."
          : "Esta tela precisa de conexão para salvar. O que você digitou fica aqui enquanto esta janela estiver aberta."}
        {isNew ? null : (
          <Button
            aria-busy={trying}
            onClick={handleTry}
            size="sm"
            type="button"
            variant="outline"
          >
            {trying ? "Tentando…" : "Tentar agora"}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

interface TabLabelProps {
  invalid: boolean;
  label: string;
}

/** The name of a tab, with the mark of an error in it (an icon, and the words for a screen reader). */
export function TabLabel({ invalid, label }: TabLabelProps) {
  return (
    <>
      {label}
      {invalid ? (
        <>
          <CircleAlertIcon aria-hidden="true" className="text-destructive" />
          <span className="sr-only"> (com erro)</span>
        </>
      ) : null}
    </>
  );
}

/**
 * Reports to its scope's owner whether the forms of one tab hold unsent work; the page-wide sign is unchanged.
 */
function TabScope({
  children,
  onUnsent,
  tab,
}: {
  children: ReactNode;
  onUnsent: (tab: ProductTab, unsent: boolean) => void;
  tab: ProductTab;
}) {
  const [report, unsent] = useUnsentWorkScope();
  useEffect(() => {
    onUnsent(tab, unsent);
  }, [onUnsent, tab, unsent]);
  return <UnsentWorkScope value={report}>{children}</UnsentWorkScope>;
}

/** Without a connection the strip at the top of the body says it: the line under the title does not repeat it. */
function dialogTexts(
  editing: boolean,
  isPending: boolean
): { description: string; submitLabel: string } {
  let submitLabel = editing ? "Salvar alterações" : "Cadastrar produto";
  if (isPending) {
    submitLabel = "Salvando…";
  }
  const description = editing
    ? "Produto"
    : "Um passo só: o produto pode nascer com o estoque.";
  return { description, submitLabel };
}

interface ProductTabsProps {
  dataInvalid: boolean;
  /** The form of the data, drawn in the first tab. */
  form: ReactNode;
  onProductUpdated: (product: ProductReadModel) => void;
  onTabChange: (tab: ProductTab) => void;
  onUnsent: (tab: ProductTab, unsent: boolean) => void;
  onVariantsDraftChange: (
    productId: string,
    draft: VariantConfigurationDraft | null
  ) => void;
  organizationId: string;
  product: ProductReadModel;
  tab: ProductTab;
  variantsDraft: VariantConfigurationDraft | null;
}

/** The tabs of a product that exists; an archived one has no images (as its menu). */
function ProductTabs({
  dataInvalid,
  form,
  onProductUpdated,
  onTabChange,
  onUnsent,
  onVariantsDraftChange,
  organizationId,
  product,
  tab,
  variantsDraft,
}: ProductTabsProps) {
  // a tab is drawn the first time it opens (its reads start then) and stays, hidden, so what was typed in it is kept
  const [seen, setSeen] = useState<ReadonlySet<ProductTab>>(
    () => new Set([tab])
  );
  useEffect(() => {
    setSeen((current) =>
      current.has(tab) ? current : new Set([...current, tab])
    );
  }, [tab]);
  const handleTab = useCallback(
    (value: unknown) => onTabChange(value as ProductTab),
    [onTabChange]
  );
  const tabs: ProductTab[] =
    product.status === "active"
      ? ["dados", "variantes", "imagens"]
      : ["dados", "variantes"];
  return (
    <Tabs className="gap-4" onValueChange={handleTab} value={tab}>
      <TabsList
        activateOnFocus
        aria-label="Partes do produto"
        className="w-full"
      >
        {tabs.map((value) => (
          <TabsTrigger key={value} value={value}>
            <TabLabel
              invalid={value === "dados" && dataInvalid}
              label={TAB_LABELS[value]}
            />
          </TabsTrigger>
        ))}
      </TabsList>
      {/* the data is always in the page: the footer's button submits its form from any tab */}
      <TabsContent keepMounted value="dados">
        {form}
      </TabsContent>
      <TabsContent keepMounted value="variantes">
        {seen.has("variantes") ? (
          <TabScope onUnsent={onUnsent} tab="variantes">
            <ProductVariantsPanel
              configurationDraft={variantsDraft}
              onConfigurationDraftChange={onVariantsDraftChange}
              onProductUpdated={onProductUpdated}
              organizationId={organizationId}
              product={product}
            />
          </TabScope>
        ) : null}
      </TabsContent>
      {tabs.includes("imagens") ? (
        <TabsContent keepMounted value="imagens">
          {seen.has("imagens") ? (
            <TabScope onUnsent={onUnsent} tab="imagens">
              <ProductMediaPanel
                organizationId={organizationId}
                product={product}
              />
            </TabScope>
          ) : null}
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

type BodyProps = Omit<
  ProductDialogProps,
  "finalFocus" | "onClosed" | "onDismiss" | "open"
>;

/**
 * What the open dialog holds: its own state (the errors shown, the tabs seen) starts again at each opening, because
 * the popup leaves the page when the dialog closes.
 */
function ProductDialogBody({
  categories,
  categoryRefusal,
  draft,
  error,
  errorExtra,
  feedbackRef,
  isOffline,
  isPending,
  notice,
  onCancel,
  onChange,
  onProductUpdated,
  onSubmit,
  onTabChange,
  onUnsentTabsChange,
  onVariantsDraftChange,
  organizationId,
  product,
  tab,
  variantsDraft,
}: BodyProps) {
  const editing = product !== null;
  const [showRequired, setShowRequired] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dataInvalid = showRequired && productFormHasErrors(draft, editing);
  const offlineEdit = isOffline && editing;

  const unsentTabs = useRef(new Set<ProductTab>());
  const handleUnsent = useCallback(
    (which: ProductTab, unsent: boolean) => {
      if (unsentTabs.current.has(which) === unsent) {
        return;
      }
      if (unsent) {
        unsentTabs.current.add(which);
      } else {
        unsentTabs.current.delete(which);
      }
      onUnsentTabsChange([...unsentTabs.current]);
    },
    [onUnsentTabsChange]
  );
  // closing takes the tabs (and their work) away
  useEffect(() => () => onUnsentTabsChange([]), [onUnsentTabsChange]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // the button says why it is off (the line above the footer); Enter in a field sends nothing either
      if (offlineEdit) {
        return;
      }
      if (productFormHasErrors(draft, editing)) {
        setShowRequired(true);
        // the error may be in the data while another tab is on screen: that tab opens, marked, and the first field
        // with an error takes the focus (the errors are drawn by the render that follows)
        onTabChange("dados");
        focusLater(() =>
          bodyRef.current
            ?.querySelector<HTMLElement>('[aria-invalid="true"]')
            ?.focus()
        );
        return;
      }
      onSubmit(event);
    },
    [draft, editing, offlineEdit, onSubmit, onTabChange]
  );

  const form = (
    <ProductForm
      categories={categories}
      categoryRefusal={categoryRefusal}
      draft={draft}
      editing={editing}
      onChange={onChange}
      onSubmit={handleSubmit}
      showRequired={showRequired}
    />
  );

  const { description, submitLabel } = dialogTexts(editing, isPending);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="[overflow-wrap:anywhere]">
          {product ? product.name : "Novo produto"}
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className={FORM_ELEMENT_CLASS}>
        <DialogBody className="scroll-pb-20" ref={bodyRef}>
          <ActionFeedback
            error={error}
            errorExtra={errorExtra}
            notice={notice}
            regionRef={feedbackRef}
          />
          {isOffline ? <OfflineAlert isNew={!editing} /> : null}
          {product ? (
            <ProductTabs
              dataInvalid={dataInvalid}
              form={form}
              onProductUpdated={onProductUpdated}
              onTabChange={onTabChange}
              onUnsent={handleUnsent}
              onVariantsDraftChange={onVariantsDraftChange}
              organizationId={organizationId}
              product={product}
              tab={tab}
              variantsDraft={variantsDraft}
            />
          ) : (
            form
          )}
        </DialogBody>
        {offlineEdit ? (
          <p
            className={`${FORM_NOTICE_CLASS} text-muted-foreground text-support`}
            id={OFFLINE_REASON_ID}
          >
            Sem internet: salvar precisa de conexão.
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={isPending}
            onClick={onCancel}
            type="button"
            variant="outline"
          >
            Cancelar
          </Button>
          <Button
            aria-describedby={offlineEdit ? OFFLINE_REASON_ID : undefined}
            aria-disabled={offlineEdit || undefined}
            disabled={isPending}
            form={PRODUCT_FORM_ID}
            type="submit"
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </div>
    </>
  );
}

/** The first focus: the name for the data, the tab itself for the variants and the images (the arrows move on). */
function firstFocus(tab: ProductTab): () => HTMLElement | boolean {
  return () =>
    (tab === "dados"
      ? document.getElementById("product-name")
      : document.querySelector<HTMLElement>(
          '[data-slot="dialog-content"] [role="tab"][aria-selected="true"]'
        )) ?? true;
}

/**
 * A product in the form dialog (the whole screen on a phone): a new one in one step (name, price, stock, and
 * "Mais detalhes"), and one that exists in three tabs, Dados · Variantes · Imagens. Changing tabs is not a step of the
 * history and loses nothing typed in another tab. Esc, "Fechar" and the step back close it and keep the data typed;
 * only "Cancelar" and a save throw it away. Nothing closes while a save is on its way, and a tap on the veil does
 * nothing.
 */
export function ProductDialog({
  finalFocus,
  onClosed,
  onDismiss,
  open,
  ...body
}: ProductDialogProps) {
  const { isPending, product, tab } = body;
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!(next || isPending)) {
        onDismiss();
      }
    },
    [isPending, onDismiss]
  );
  const handleOpenChangeComplete = useCallback(
    (next: boolean) => {
      if (!next) {
        onClosed();
      }
    },
    [onClosed]
  );
  return (
    <Dialog
      disablePointerDismissal
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={handleOpenChangeComplete}
      open={open}
    >
      <DialogContent
        className={product ? undefined : "md:max-w-[36rem]"}
        finalFocus={finalFocus}
        initialFocus={firstFocus(product ? tab : "dados")}
        layout="form"
      >
        <ProductDialogBody {...body} />
      </DialogContent>
    </Dialog>
  );
}
