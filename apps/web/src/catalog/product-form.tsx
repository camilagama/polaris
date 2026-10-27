import type { CategoryReadModel } from "@polaris/contracts";
import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUpIcon from "lucide-react/dist/esm/icons/chevron-up";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { focusLater } from "../lib/focus";
import { SelectField } from "../sales/sale-fields";
import { ProductTextAreaField, ProductTextField } from "./product-fields";
import {
  emptyOpeningDraft,
  PRODUCT_NAME_REQUIRED,
  type ProductOpeningDraft,
  validateOpening,
} from "./product-opening-model";

export interface ProductDraft extends ProductOpeningDraft {
  categoryId: string;
  description: string;
  name: string;
}

export const emptyDraft: ProductDraft = {
  ...emptyOpeningDraft,
  categoryId: "",
  description: "",
  name: "",
};

/** The `<form>` of the product's data: the footer's button of the dialog submits it from any tab (`form=`). */
export const PRODUCT_FORM_ID = "product-form";

/** The choice that clears the category: the Select has no empty value of its own. */
const NO_CATEGORY = "none";

/**
 * Whether the data cannot be sent as typed: no name, or (only for a new product, the only one with a price and a
 * stock to say) a price, a quantity or a cost that does not read.
 */
export function productFormHasErrors(
  draft: ProductDraft,
  editing: boolean
): boolean {
  return (
    draft.name.trim() === "" ||
    (!editing && validateOpening(draft).value === null)
  );
}

interface ProductFormProps {
  categories: CategoryReadModel[];
  /** Counts the refusals of the chosen category: each one opens "Mais detalhes" and takes the focus to the category. */
  categoryRefusal: number;
  draft: ProductDraft;
  editing: boolean;
  onChange: (field: keyof ProductDraft, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** A save was tried with errors: each field says its own. */
  showRequired: boolean;
}

/**
 * What the person finds without asking: the name and, for a new product, the price and the stock (the product in one
 * step, AC-24). The category and the description are under "Mais detalhes", open for an edit (where they are what
 * changes) and for a kept draft that already has them. The buttons are the dialog's.
 */
export function ProductForm({
  categories,
  categoryRefusal,
  draft,
  editing,
  onChange,
  onSubmit,
  showRequired,
}: ProductFormProps) {
  const [detailsOpen, setDetailsOpen] = useState(
    editing || draft.categoryId !== "" || draft.description !== ""
  );
  // a refusal of the category (the alert at the top says it) opens the details and puts the person on the category; the
  // count the form was born with is an older refusal, already handled
  const handledRefusal = useRef(categoryRefusal);
  useEffect(() => {
    if (categoryRefusal === handledRefusal.current) {
      return;
    }
    handledRefusal.current = categoryRefusal;
    setDetailsOpen(true);
    focusLater(() => document.getElementById("product-category")?.focus());
  }, [categoryRefusal]);
  const nameError =
    showRequired && draft.name.trim() === ""
      ? PRODUCT_NAME_REQUIRED
      : undefined;
  // only a new product has a price and a stock to say: an edit changes the name, the category and the description
  const opening = editing ? null : validateOpening(draft);
  const openingErrors = showRequired ? (opening?.errors ?? {}) : {};

  const handleName = useCallback(
    (value: string) => onChange("name", value),
    [onChange]
  );
  const handleListPrice = useCallback(
    (value: string) => onChange("listPrice", value),
    [onChange]
  );
  const handleQuantity = useCallback(
    (value: string) => onChange("quantity", value),
    [onChange]
  );
  const handleUnitCost = useCallback(
    (value: string) => onChange("unitCost", value),
    [onChange]
  );
  const handleDescription = useCallback(
    (value: string) => onChange("description", value),
    [onChange]
  );
  const handleCategory = useCallback(
    (value: string) =>
      onChange("categoryId", value === NO_CATEGORY ? "" : value),
    [onChange]
  );

  const options = [
    { id: NO_CATEGORY, label: "Sem categoria" },
    ...categories
      .filter(
        (category) =>
          category.status === "active" || category.id === draft.categoryId
      )
      .map((category) => ({
        id: category.id,
        label: `${category.name}${category.status === "archived" ? " (arquivada)" : ""}`,
      })),
  ];
  const DetailsIcon = detailsOpen ? ChevronUpIcon : ChevronDownIcon;

  return (
    <form
      className="grid gap-4 md:grid-cols-2"
      id={PRODUCT_FORM_ID}
      noValidate
      onSubmit={onSubmit}
    >
      <ProductTextField
        className="col-span-full"
        error={nameError}
        id="product-name"
        label="Nome do produto"
        onChange={handleName}
        value={draft.name}
      />
      {editing ? null : (
        <>
          <ProductTextField
            addon="R$"
            error={openingErrors.listPrice}
            id="product-list-price"
            inputMode="decimal"
            label="Preço de tabela"
            onChange={handleListPrice}
            optional
            placeholder="Ex.: 49,90"
            value={draft.listPrice}
          />
          <ProductTextField
            className="md:col-start-1"
            error={openingErrors.quantity}
            hint="Deixe vazio se ainda não tem estoque."
            id="product-quantity"
            inputMode="numeric"
            label="Quantos você tem agora"
            onChange={handleQuantity}
            value={draft.quantity}
          />
          <ProductTextField
            addon="R$"
            error={openingErrors.unitCost}
            id="product-unit-cost"
            inputMode="decimal"
            label="Custo de cada unidade"
            onChange={handleUnitCost}
            optional
            placeholder="Ex.: 12,50"
            value={draft.unitCost}
          />
        </>
      )}
      <Collapsible
        className="col-span-full grid gap-4 rounded-lg border border-border"
        onOpenChange={setDetailsOpen}
        open={detailsOpen}
      >
        <CollapsibleTrigger
          className="h-auto min-h-ctl-lg w-full justify-between whitespace-normal px-3 text-left"
          render={<Button type="button" variant="ghost" />}
        >
          Mais detalhes
          <span className="ms-auto font-normal text-muted-foreground text-support">
            categoria e descrição
          </span>
          <DetailsIcon aria-hidden="true" data-icon="inline-end" />
        </CollapsibleTrigger>
        {/* kept mounted while closed: what was typed in it survives closing and opening */}
        <CollapsiblePanel
          className="grid gap-4 px-3 pb-3 md:grid-cols-2"
          keepMounted
        >
          <SelectField
            id="product-category"
            label="Categoria"
            onChange={handleCategory}
            options={options}
            placeholder="Sem categoria"
            value={draft.categoryId === "" ? NO_CATEGORY : draft.categoryId}
          />
          <ProductTextAreaField
            className="col-span-full"
            id="product-description"
            label="Descrição"
            onChange={handleDescription}
            optional
            value={draft.description}
          />
        </CollapsiblePanel>
      </Collapsible>
      {editing ? null : (
        <p className="col-span-full text-muted-foreground text-support">
          Variações (cor, tamanho), SKU e fotos ficam nas abas do produto depois
          de salvar.
        </p>
      )}
    </form>
  );
}
