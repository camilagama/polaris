import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import type { ReactNode, Ref } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { SearchField } from "@/ui/search-field";
import type { ProductListStatus } from "./product-list";

/* The small parts of the products screen: the title with its button, the notices, the search and the two lists. */

export const PRODUCT_STATUS_OPTIONS: ReadonlyArray<
  readonly [ProductListStatus, string]
> = [
  ["active", "Ativos"],
  ["archived", "Arquivados"],
];

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
  /** What follows the error, on its own line (the way to the Pro after the plan's limit). */
  errorExtra?: ReactNode;
  notice: string | null;
  /** A button that goes with the notice ("Cadastrar outro" after a customer was made). */
  noticeAction?: { label: string; onClick: () => void } | undefined;
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

interface NoticeAlertProps {
  notice: string;
  noticeAction?: FeedbackProps["noticeAction"];
  onUndo?: FeedbackProps["onUndo"];
  undoDisabled?: FeedbackProps["undoDisabled"];
  undoReasonId?: FeedbackProps["undoReasonId"];
}

/** The success notice, with the button that may go with it ("Cadastrar outro", "Desfazer"). */
function NoticeAlert({
  notice,
  noticeAction,
  onUndo,
  undoDisabled,
  undoReasonId,
}: NoticeAlertProps) {
  return (
    <Alert>
      <CircleCheckIcon aria-hidden="true" />
      <AlertDescription
        className={
          onUndo || noticeAction
            ? "flex flex-wrap items-center gap-x-3 gap-y-1"
            : undefined
        }
      >
        {notice}
        {noticeAction ? (
          <Button
            onClick={noticeAction.onClick}
            size="sm"
            type="button"
            variant="link"
          >
            {noticeAction.label}
          </Button>
        ) : null}
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
  );
}

/** What the last action did: nothing is drawn (not even a gap) without a message. */
export function ActionFeedback({
  error,
  errorExtra,
  notice,
  noticeAction,
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
            {errorExtra}
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
        <NoticeAlert
          notice={notice}
          noticeAction={noticeAction}
          onUndo={onUndo}
          undoDisabled={undoDisabled}
          undoReasonId={undoReasonId}
        />
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
  onChange: (value: string) => void;
  value: string;
}

export function ProductSearch({ onChange, value }: SearchProps) {
  return (
    <SearchField
      className="md:max-w-sm"
      label="Buscar produto"
      onValueChange={onChange}
      placeholder="Nome do produto"
      value={value}
    />
  );
}
