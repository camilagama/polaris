import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import UploadIcon from "lucide-react/dist/esm/icons/upload";
import type { ReactNode, Ref } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { useConnectionOnline } from "../lib/browser-connection";
import { Button } from "@/ui/button";
import { RetryButton } from "@/ui/retry-button";
import { SearchField } from "@/ui/search-field";
import type { ProductListStatus } from "./product-list";
import {
  ScreenTitle,
  TITLE_ACTION_CLASS,
  TitleLine,
} from "../app-shell/screen-title";
import { withoutRetryAsk } from "@/lib/retry-notice";
import { useIsMobile } from "@/lib/use-mobile";

/* The small parts of the products screen: the title with its button, the notices, the search and the two lists. */

export const PRODUCT_STATUS_OPTIONS: ReadonlyArray<
  readonly [ProductListStatus, string]
> = [
  ["active", "Ativos"],
  ["archived", "Arquivados"],
];

interface HeaderProps {
  buttonRef: Ref<HTMLButtonElement>;
  importButtonRef: Ref<HTMLButtonElement>;
  /** The device's copy says there is no connection (the offline runtime). */
  isOffline: boolean;
  onImport: () => void;
  onNew: () => void;
  /** A new product is made in the active list only (and imported there too). */
  showNew: boolean;
}

/**
 * What Produtos says when the import closes on "Ver os produtos" (here, not in the import's chunk: the page says it).
 */
export function importedNotice(entered: number): string {
  if (entered === 0) {
    return "Nenhum produto importado.";
  }
  return entered === 1
    ? "1 produto importado."
    : `${entered} produtos importados.`;
}

/** Read with "Importar planilha" while it is off for lack of connection. */
const IMPORT_OFFLINE_REASON_ID = "products-import-offline-reason";

interface ImportButtonProps {
  importButtonRef: Ref<HTMLButtonElement>;
  isOffline: boolean;
  onImport: () => void;
}

/** "Importar planilha" with the reason it is off for lack of connection right under it. */
function ImportButton({
  className,
  importButtonRef,
  isOffline,
  onImport,
}: ImportButtonProps & { className?: string | undefined }) {
  // the import never goes to the offline queue: without a connection "Importar planilha" stays reachable, off, and
  // reads why
  const importOffline = !useConnectionOnline() || isOffline;
  return (
    <div className={className ? `grid gap-1 ${className}` : "grid gap-1"}>
      <Button
        aria-describedby={importOffline ? IMPORT_OFFLINE_REASON_ID : undefined}
        aria-disabled={importOffline || undefined}
        className={TITLE_ACTION_CLASS}
        onClick={importOffline ? undefined : onImport}
        ref={importButtonRef}
        type="button"
        variant="outline"
      >
        <UploadIcon aria-hidden="true" data-icon="inline-start" />
        Importar planilha
      </Button>
      {importOffline ? (
        <p
          className="text-muted-foreground text-support"
          id={IMPORT_OFFLINE_REASON_ID}
        >
          Importar planilha precisa de conexão.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The title line of Produtos: "Novo produto" is the main action and, from 760 px, "Importar planilha" is the outline
 * button beside it. On a phone the import is not a second 44 px button under the first: it comes after the list
 * (`ProductsImportFooter`).
 */
export function ProductsHeader({
  buttonRef,
  importButtonRef,
  isOffline,
  onImport,
  onNew,
  showNew,
}: HeaderProps) {
  const wide = !useIsMobile();
  return (
    <TitleLine
      canHaveAction
      tabNamesIt
      action={
        showNew ? (
          <>
            <Button
              className={`${TITLE_ACTION_CLASS} min-[47.5rem]:order-2`}
              onClick={onNew}
              ref={buttonRef}
              type="button"
            >
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              Novo produto
            </Button>
            {wide ? (
              <ImportButton
                className="min-[47.5rem]:order-1"
                importButtonRef={importButtonRef}
                isOffline={isOffline}
                onImport={onImport}
              />
            ) : null}
          </>
        ) : null
      }
    >
      <ScreenTitle>Produtos</ScreenTitle>
    </TitleLine>
  );
}

/** The import of a phone: after the list, with the reason it is off under it; from 760 px it is in the title line. */
export function ProductsImportFooter({
  importButtonRef,
  isOffline,
  onImport,
  showNew,
}: ImportButtonProps & { showNew: boolean }) {
  const phone = useIsMobile();
  return showNew && phone ? (
    <ImportButton
      importButtonRef={importButtonRef}
      isOffline={isOffline}
      onImport={onImport}
    />
  ) : null;
}

/** The id of the offline notice: the archived notice's "Desfazer" points at it while it is off for lack of connection. */
export const OFFLINE_NOTICE_ID = "products-offline-notice";

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
            ? "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 [overflow-wrap:anywhere]"
            : "min-w-0 [overflow-wrap:anywhere]"
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
    <div
      className="focus-ring grid gap-2 rounded-lg"
      ref={regionRef}
      tabIndex={-1}
    >
      {error ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription
            className={
              onRetryError ? "grid justify-items-start gap-2" : undefined
            }
          >
            {onRetryError ? withoutRetryAsk(error) : error}
            {errorExtra}
            {onRetryError ? <RetryButton onClick={onRetryError} /> : null}
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
      <AlertDescription className="grid justify-items-start gap-2">
        {withoutRetryAsk(message)}
        <RetryButton onClick={onRetry} />
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
