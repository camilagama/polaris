import type { ProductReadModel } from "@polaris/contracts";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import {
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { navigateInApp } from "../app-shell/address";
import { orpcClient } from "../lib/orpc";
import { INLINE_LINK } from "../sign-in/entry-ui";
import { isPlainClick } from "../lib/plain-click";
import type { ProductDeleteRefusal } from "./product-errors";
import { typedNameMatches } from "./product-search-model";

const NAME_FIELD_ID = "product-delete-name";
const NAME_REASON_ID = "product-delete-name-reason";
const OFFLINE_REASON_ID = "product-delete-offline";
const OFFLINE_TEXT = "Disponível quando houver conexão.";
const NAME_REASON_TEXT = "Digite o nome do produto para habilitar.";
function variantsSentence(count: number | null): string | null {
  if (count === null) {
    return "Este produto libera as variantes dele do seu plano.";
  }
  if (count === 0) {
    return null;
  }
  return count === 1
    ? "Este produto libera 1 variante do seu plano."
    : `Este produto libera ${count} variantes do seu plano.`;
}

type VariantRead =
  | { state: "loading" }
  | { state: "known"; count: number | null };

/** The variants the product holds in the plan: what excluding it frees. A failed read does not stop the dialog; it says it without the number. */
function useVariantCount(
  productId: string,
  organizationId: string
): VariantRead {
  const [read, setRead] = useState<VariantRead>({ state: "loading" });
  useEffect(() => {
    let current = true;
    setRead({ state: "loading" });
    orpcClient.product
      .getVariants({ id: productId, organizationId })
      .then((result) => {
        if (current) {
          setRead({ count: result.variants.length, state: "known" });
        }
      })
      .catch(() => {
        if (current) {
          setRead({ count: null, state: "known" });
        }
      });
    return () => {
      current = false;
    };
  }, [organizationId, productId]);
  return read;
}

interface RefusalProps {
  onGoToStock: (event: MouseEvent<HTMLAnchorElement>) => void;
  refusal: ProductDeleteRefusal;
  stockHref: string | null;
}

function RefusalAlert({ onGoToStock, refusal, stockHref }: RefusalProps) {
  return (
    <Alert role="alert" variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription>
        {refusal.text}
        {refusal.toStock && stockHref ? (
          <>
            {" "}
            <a className={INLINE_LINK} href={stockHref} onClick={onGoToStock}>
              Ir ao Estoque
            </a>
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

interface BodyProps {
  isOffline: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  organizationId: string;
  pending: boolean;
  product: ProductReadModel;
  refusal: ProductDeleteRefusal | null;
  stockHref: string | null;
}

/** Keyed by the product: what was typed for one never carries over to another. */
function DeleteBody({
  isOffline,
  onCancel,
  onConfirm,
  organizationId,
  pending,
  product,
  refusal,
  stockHref,
}: BodyProps) {
  const [typed, setTyped] = useState("");
  const [tried, setTried] = useState(false);
  const read = useVariantCount(product.id, organizationId);
  const wasPending = useRef<boolean>(false);
  // the field is off while the call runs and takes the focus with it: after a refusal it gets it back
  useEffect(() => {
    if (wasPending.current && !pending) {
      document.getElementById(NAME_FIELD_ID)?.focus();
    }
    wasPending.current = pending;
  }, [pending]);
  const matches = typedNameMatches(typed, product.name);
  const loading = read.state === "loading";
  const blockedByName = !(matches || pending);
  const blocked = pending || isOffline || blockedByName || loading;

  const handleTyped = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTyped(event.target.value);
    setTried(false);
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending || isOffline) {
        return;
      }
      if (!matches) {
        setTried(true);
        return;
      }
      if (!loading) {
        onConfirm();
      }
    },
    [isOffline, loading, matches, onConfirm, pending]
  );

  const handleGoToStock = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!(stockHref && isPlainClick(event))) {
        return;
      }
      event.preventDefault();
      navigateInApp(stockHref);
    },
    [stockHref]
  );

  const sentence = loading ? null : variantsSentence(read.count);
  let describedBy: string | undefined;
  if (isOffline) {
    describedBy = OFFLINE_REASON_ID;
  } else if (blockedByName) {
    describedBy = NAME_REASON_ID;
  }
  return (
    <form className="-m-4 grid gap-4 p-4" noValidate onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle className="[overflow-wrap:anywhere]">
          Excluir produto “{product.name}”?
        </DialogTitle>
        <DialogDescription render={<div />}>
          <p>
            Não tem volta. As vendas antigas continuam no histórico, com o nome
            que o item tinha. {sentence} O SKU não poderá ser usado de novo.
          </p>
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={NAME_FIELD_ID}>
          Digite o nome do produto para confirmar
        </FieldLabel>
        <Input
          aria-describedby={`${NAME_FIELD_ID}-hint`}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          disabled={pending}
          id={NAME_FIELD_ID}
          onChange={handleTyped}
          spellCheck={false}
          value={typed}
        />
        <FieldDescription id={`${NAME_FIELD_ID}-hint`}>
          Escreva “
          <strong className="font-semibold [overflow-wrap:anywhere]">
            {product.name}
          </strong>
          ” exatamente como aparece aqui.
        </FieldDescription>
        {tried && !matches ? (
          <p className="text-destructive text-support" role="alert">
            {NAME_REASON_TEXT}
          </p>
        ) : null}
      </Field>
      {refusal ? (
        <RefusalAlert
          onGoToStock={handleGoToStock}
          refusal={refusal}
          stockHref={stockHref}
        />
      ) : null}
      {isOffline ? (
        <p
          className="text-muted-foreground text-support"
          id={OFFLINE_REASON_ID}
        >
          {OFFLINE_TEXT}
        </p>
      ) : null}
      {blockedByName && !isOffline ? (
        <span className="sr-only" id={NAME_REASON_ID}>
          {NAME_REASON_TEXT}
        </span>
      ) : null}
      <DialogFooter>
        <Button
          aria-disabled={pending || undefined}
          onClick={pending ? undefined : onCancel}
          type="button"
          variant="outline"
        >
          Manter arquivado
        </Button>
        <Button
          aria-busy={pending}
          aria-describedby={describedBy}
          aria-disabled={blocked || undefined}
          className="h-auto! min-h-ctl-md whitespace-normal py-1.5 text-center"
          type="submit"
          variant="destructive"
        >
          {pending ? "Excluindo…" : "Excluir produto"}
        </Button>
      </DialogFooter>
    </form>
  );
}

interface ProductDeleteDialogProps {
  /** Where the focus goes when the dialog closes without a message to read. */
  finalFocus: () => HTMLElement | boolean | null;
  isOffline: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  organizationId: string;
  pending: boolean;
  /** The archived product being asked about; the dialog is open while there is one. */
  product: ProductReadModel | null;
  refusal: ProductDeleteRefusal | null;
  stockHref: string | null;
}

/**
 * "Excluir produto": the one permanent act of the catalog. It says what
 * happens, asks for the name of the product typed, and sends nothing while the name does not match, while there is no
 * connection or while a call runs. Esc, a press outside and "Manter arquivado" close it without deleting.
 */
export function ProductDeleteDialog({
  finalFocus,
  onCancel,
  pending,
  product,
  ...rest
}: ProductDeleteDialogProps) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!(open || pending)) {
        onCancel();
      }
    },
    [onCancel, pending]
  );
  const initialFocus = useCallback(
    () => document.getElementById(NAME_FIELD_ID) ?? true,
    []
  );
  return (
    <Dialog onOpenChange={handleOpenChange} open={product !== null}>
      <DialogContent
        finalFocus={finalFocus}
        initialFocus={initialFocus}
        showCloseButton={!pending}
      >
        {product ? (
          <DeleteBody
            {...rest}
            key={product.id}
            onCancel={onCancel}
            pending={pending}
            product={product}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
