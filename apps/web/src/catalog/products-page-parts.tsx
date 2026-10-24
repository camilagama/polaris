import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import SearchIcon from "lucide-react/dist/esm/icons/search";
import type { ChangeEvent, MouseEvent, Ref } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import type { ProductListStatus } from "./product-list";

/* The small parts of the products screen: the title with its button, the notices, the search and the two lists. */

const productStatuses: ReadonlyArray<readonly [ProductListStatus, string]> = [
  ["active", "Ativos"],
  ["archived", "Arquivados"],
];

export function isProductListStatus(value: string): value is ProductListStatus {
  return value === "active" || value === "archived";
}

interface HeaderProps {
  buttonRef: Ref<HTMLButtonElement>;
  onNew: () => void;
  /** A new product is made in the active list only. */
  showNew: boolean;
}

export function ProductsHeader({ buttonRef, onNew, showNew }: HeaderProps) {
  return (
    <div className="grid gap-3 min-[30rem]:flex min-[30rem]:items-center min-[30rem]:justify-between">
      <h1 className="text-title">Produtos</h1>
      {showNew ? (
        <Button onClick={onNew} ref={buttonRef} type="button">
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          Novo produto
        </Button>
      ) : null}
    </div>
  );
}

/** The id of the offline notice: the archived notice's "Desfazer" points at it while it is off for lack of connection. */
export const OFFLINE_NOTICE_ID = "products-offline-notice";

/** Said while there is no connection: what still works and what waits. */
export function OfflineNotice() {
  return (
    <Alert id={OFFLINE_NOTICE_ID} variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem conexão.</AlertTitle>
      <AlertDescription>
        Cadastrar funciona e é enviado depois; editar, arquivar, variantes e
        imagens precisam de conexão.
      </AlertDescription>
    </Alert>
  );
}

interface FeedbackProps {
  error: string | null;
  notice: string | null;
  /** The error has its own "Tentar novamente" (the product of the address could not be read). */
  onRetryError?: (() => void) | undefined;
  /** Only the archived notice has it: restores the product just archived. */
  onUndo?: (() => void) | undefined;
  /** The focus goes here when an action ends, so a person far down the list reads the result. */
  regionRef: Ref<HTMLDivElement>;
  /** No connection or an action running: the restore cannot start. */
  undoDisabled?: boolean | undefined;
  /** The notice that says why the restore is off (no connection), when there is one; read with the button. */
  undoReasonId?: string | undefined;
}

/** What the last action did: nothing is drawn (not even a gap) without a message. */
export function ActionFeedback({
  error,
  notice,
  onRetryError,
  onUndo,
  regionRef,
  undoDisabled,
  undoReasonId,
}: FeedbackProps) {
  if (!(error || notice)) {
    return null;
  }
  return (
    <div className="grid gap-2 outline-none" ref={regionRef} tabIndex={-1}>
      {error ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription
            className={
              onRetryError
                ? "flex flex-wrap items-center gap-x-3 gap-y-1"
                : undefined
            }
          >
            {error}
            {onRetryError ? (
              <Button
                onClick={onRetryError}
                size="sm"
                type="button"
                variant="link"
              >
                Tentar novamente
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <CircleCheckIcon aria-hidden="true" />
          <AlertDescription
            className={
              onUndo ? "flex flex-wrap items-center gap-x-3 gap-y-1" : undefined
            }
          >
            {notice}
            {onUndo ? (
              // aria-disabled, not disabled: the button stays reachable and reads why it is off (the offline notice)
              <Button
                aria-describedby={undoDisabled ? undoReasonId : undefined}
                aria-disabled={undoDisabled || undefined}
                onClick={undoDisabled ? undefined : onUndo}
                size="sm"
                type="button"
                variant="link"
              >
                Desfazer
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

interface LoadErrorProps {
  message: string;
  onRetry: () => void;
}

export function LoadErrorNotice({ message, onRetry }: LoadErrorProps) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {message}
        <Button onClick={onRetry} size="sm" type="button" variant="link">
          Tentar novamente
        </Button>
      </AlertDescription>
    </Alert>
  );
}

interface SearchProps {
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  value: string;
}

export function ProductSearch({ onChange, value }: SearchProps) {
  return (
    <InputGroup className="md:max-w-sm">
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        aria-label="Buscar produto"
        autoComplete="off"
        onChange={onChange}
        placeholder="Buscar por nome"
        value={value}
      />
    </InputGroup>
  );
}

interface StatusNavProps {
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  status: ProductListStatus;
}

/** Active or archived: a line under the selected one, the buttons say which is pressed. */
export function ProductStatusNav({ onSelect, status }: StatusNavProps) {
  return (
    <nav
      aria-label="Estado dos produtos"
      className="flex gap-4 border-border border-b"
    >
      {productStatuses.map(([value, label]) => (
        <button
          aria-pressed={status === value}
          className="focus-ring touch-hit relative -mb-px inline-flex h-ctl-lg items-center border-transparent border-b-2 font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-foreground aria-pressed:text-foreground"
          data-product-status={value}
          key={value}
          onClick={onSelect}
          type="button"
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
