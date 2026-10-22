import type { CategoryReadModel, ProductReadModel } from "@polaris/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { focusLater } from "../lib/focus";
import { SelectField } from "../sales/sale-fields";
import { ProductTextAreaField, ProductTextField } from "./product-fields";

export interface ProductDraft {
  categoryId: string;
  description: string;
  name: string;
}

export const emptyDraft: ProductDraft = {
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
  isPending: boolean;
  onCancel: () => void;
  onChange: (field: keyof ProductDraft, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function submitLabelFor(isPending: boolean, editing: boolean): string {
  if (isPending) {
    return "Salvando…";
  }
  return editing ? "Salvar alterações" : "Cadastrar produto";
}

/** The form of a new product or of the edit of one: name, category and a description. */
export function ProductForm({
  categories,
  draft,
  editingProduct,
  isPending,
  onCancel,
  onChange,
  onSubmit,
}: ProductFormProps) {
  const [showRequired, setShowRequired] = useState(false);
  const nameRef = useRef<HTMLDivElement>(null);
  const nameMissing = draft.name.trim() === "";
  const nameError = showRequired && nameMissing ? NAME_REQUIRED : undefined;

  // opening the form (a new product, or an edit of another one) puts the cursor in the name
  const formKey = editingProduct?.id ?? "new";
  useEffect(() => {
    setShowRequired(false);
    focusLater(() => nameRef.current?.querySelector("input")?.focus());
  }, [formKey]);

  const handleName = useCallback(
    (value: string) => onChange("name", value),
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
      if (nameMissing) {
        event.preventDefault();
        setShowRequired(true);
        focusLater(() => nameRef.current?.querySelector("input")?.focus());
        return;
      }
      onSubmit(event);
    },
    [nameMissing, onSubmit]
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

  return (
    <Card aria-labelledby="product-form-heading" role="region">
      <form className="grid gap-4" noValidate onSubmit={handleSubmit}>
        <CardHeader>
          <CardTitle aria-level={2} id="product-form-heading" role="heading">
            {editingProduct ? "Editar produto" : "Novo produto"}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 min-[48rem]:grid-cols-2">
          <div className="min-w-0" ref={nameRef}>
            <ProductTextField
              error={nameError}
              hint="Cada produto começa com uma variante padrão."
              id="product-name"
              label="Nome do produto"
              onChange={handleName}
              value={draft.name}
            />
          </div>
          <SelectField
            id="product-category"
            label="Categoria"
            onChange={handleCategory}
            options={options}
            placeholder="Sem categoria"
            value={draft.categoryId === "" ? NO_CATEGORY : draft.categoryId}
          />
          <ProductTextAreaField
            className="min-[48rem]:col-span-2"
            id="product-description"
            label="Descrição"
            onChange={handleDescription}
            optional
            value={draft.description}
          />
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
            {submitLabelFor(isPending, editingProduct !== null)}
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}
