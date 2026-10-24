import type { CategoryReadModel, ProductReadModel } from "@polaris/contracts";
import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUpIcon from "lucide-react/dist/esm/icons/chevron-up";
import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
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

/** The choice that clears the category: the Select has no empty value of its own. */
const NO_CATEGORY = "none";
const NAME_REQUIRED = "Informe o nome do produto.";

interface ProductFormProps {
  categories: CategoryReadModel[];
  draft: ProductDraft;
  editingProduct: ProductReadModel | null;
  /** Where the focus goes when the form is opened by an address (`?novo=1`): the title. */
  headingRef?: RefObject<HTMLDivElement | null>;
  isPending: boolean;
  onCancel: () => void;
  onChange: (field: keyof ProductDraft, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** The form came from an address: the first focus is on the title, not on the name. */
  startOnHeading?: boolean;
}

function submitLabelFor(isPending: boolean, editing: boolean): string {
  if (isPending) {
    return "Salvando…";
  }
  return editing ? "Salvar alterações" : "Cadastrar produto";
}

/** What the person finds in the form without asking: the name, the price and the stock. The rest is under "Mais detalhes". */
export function ProductForm({
  categories,
  draft,
  editingProduct,
  headingRef,
  isPending,
  onCancel,
  onChange,
  onSubmit,
  startOnHeading = false,
}: ProductFormProps) {
  const [showRequired, setShowRequired] = useState(false);
  const editing = editingProduct !== null;
  const [detailsOpen, setDetailsOpen] = useState(editing);
  const formRef = useRef<HTMLFormElement>(null);
  const nameMissing = draft.name.trim() === "";
  const nameError = showRequired && nameMissing ? NAME_REQUIRED : undefined;
  // only a new product has a price and a stock to say: an edit changes the name, the category and the description
  const opening = editing ? null : validateOpening(draft);
  const openingErrors = showRequired ? (opening?.errors ?? {}) : {};

  // opening the form (a new product, or an edit of another one) puts the cursor in the name; the details are open
  // for an edit, where the category and the description are what changes;
  // opened by an address, the first focus is on the title and the next Tab reaches the name
  const formKey = editingProduct?.id ?? "new";
  const firstFocus = useRef<boolean>(true);
  useEffect(() => {
    setShowRequired(false);
    setDetailsOpen(formKey !== "new");
    const onTitle = firstFocus.current && startOnHeading;
    firstFocus.current = false;
    focusLater(() =>
      onTitle
        ? headingRef?.current?.focus()
        : formRef.current?.querySelector("input")?.focus()
    );
  }, [formKey, headingRef, startOnHeading]);

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
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (nameMissing || (opening !== null && opening.value === null)) {
        event.preventDefault();
        setShowRequired(true);
        // the first field with an error, in the order of the screen (the errors are drawn by the render that follows)
        focusLater(() =>
          formRef.current
            ?.querySelector<HTMLElement>('[aria-invalid="true"]')
            ?.focus()
        );
        return;
      }
      onSubmit(event);
    },
    [nameMissing, onSubmit, opening]
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
    <Card
      aria-labelledby="product-form-heading"
      className="@container"
      role="region"
    >
      <form
        className="grid gap-4"
        noValidate
        onSubmit={handleSubmit}
        ref={formRef}
      >
        <CardHeader>
          <div className="outline-none" ref={headingRef} tabIndex={-1}>
            <CardTitle aria-level={2} id="product-form-heading" role="heading">
              {editing ? "Editar produto" : "Novo produto"}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="grid @min-[32rem]:grid-cols-2 @min-[45rem]:grid-cols-3 gap-4">
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
            className="col-span-full grid gap-4"
            onOpenChange={setDetailsOpen}
            open={detailsOpen}
          >
            <CollapsibleTrigger
              className="justify-self-start"
              render={<Button type="button" variant="ghost" />}
            >
              Mais detalhes
              <DetailsIcon aria-hidden="true" data-icon="inline-end" />
            </CollapsibleTrigger>
            {/* kept mounted while closed: what was typed in it survives closing and opening */}
            <CollapsiblePanel
              className="grid @min-[32rem]:grid-cols-2 gap-4"
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
        </CardContent>
        <CardContent className="flex flex-col-reverse gap-3 min-[30rem]:flex-row min-[30rem]:justify-end">
          <Button
            disabled={isPending}
            onClick={onCancel}
            type="button"
            variant="outline"
          >
            Cancelar
          </Button>
          <Button disabled={isPending} type="submit">
            {submitLabelFor(isPending, editing)}
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}
