import type { SaleDetailReadModel } from "@polaris/contracts";
import RefreshCwIcon from "lucide-react/dist/esm/icons/refresh-cw";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { HelpTip } from "@/ui/help-tip";
import { Skeleton } from "@/ui/skeleton";
import { type TitleBack, TitleLine } from "../app-shell/screen-title";
import { invalidatePreviousWindow } from "../home/previous-window-copy";
import { useConnectionOnline } from "../lib/browser-connection";
import { focusLater } from "../lib/focus";
import { useCurrentOrganization } from "../lib/current-organization";
import { browserStorage } from "../lib/current-organization-model";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import { armHistoryReturn } from "./history-return";
import {
  type SaleAction,
  SaleActionsMenu,
  type SaleActionsOffer,
} from "./sale-actions-menu";
import { sessionStorageOrNull } from "./sale-attempt-storage";
import { CurrentCustomerSummary } from "./customer-summary";
import { SaleCancelPanel } from "./sale-cancel-panel";
import type { SaleNotice } from "./sale-cancellation-model";
import {
  isLatestRequest,
  nextRequestToken,
  type RequestSequence,
  readSaleIdParam,
} from "./sale-customer-link-model";
import {
  CustomerDialogs,
  CustomerHistory,
  CustomerSaveError,
  type SaleCustomerLink,
  useSaleCustomerLink,
} from "./sale-customer-panel";
import type { Loadable } from "./sale-form-model";
import { SaleStatusBadges } from "./sale-history-list";
import {
  cancelOffer,
  detailLoadErrorMessage,
  type SaleDetailView,
  saleDetailView,
  saleTimelineEvents,
} from "./sale-history-model";
import { SaleIdMissing } from "./sale-id-missing";
import { SaleNoticeRegion } from "./sale-notice-region";
import { SaleReceipt } from "./sale-receipt";
import { SaleReturnPanel } from "./sale-return-panel";
import { SaleTimeline } from "./sale-timeline";

type DialogFinalFocus = ComponentProps<typeof SaleReturnPanel>["finalFocus"];

/** The root of a piece of the screen, as the other screens write it. */
const UI_ROOT = "grid gap-4 font-sans text-foreground text-sm antialiased";

function historyBack(saleId: string | null): TitleBack {
  return {
    href: "/sales/history",
    label: "Voltar para o histórico",
    onClick: (event) => {
      const plain =
        !(event.metaKey || event.ctrlKey || event.shiftKey) &&
        event.button === 0;
      if (plain && saleId !== null) {
        armHistoryReturn(sessionStorageOrNull(), saleId);
      }
    },
  };
}

function StateCard({ children }: { children: ReactNode }) {
  return (
    <Card className="items-center px-(--card-spacing) text-center">
      <p className="text-muted-foreground">{children}</p>
    </Card>
  );
}

const LOADING_ROWS = [0, 1, 2];

/** Loading: three rows of skeleton in the card, and the line that says it for the screen reader. */
function LoadingCard({ message }: { message: string }) {
  return (
    <Card aria-busy="true" className="gap-3 px-(--card-spacing)" role="status">
      <p className="sr-only">{message}</p>
      {LOADING_ROWS.map((row) => (
        <div aria-hidden="true" className="grid gap-1.5" key={row}>
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </Card>
  );
}

interface DetailContentProps {
  back: TitleBack;
  organizationId: string;
  saleId: string;
}

/** The title of the screen, and its one `h1`. */
function DetailTitle() {
  return (
    <div className="flex items-center gap-1">
      <h1 className="text-title">Detalhe da venda</h1>
      <HelpTip about="Detalhe da venda">
        A venda confirmada é um registro que não muda. Cancelamento e cliente
        são registros à parte.
      </HelpTip>
    </div>
  );
}

/** The line of the receipt that names the customer of the sale, with the way to read it again when that failed. */
function CustomerLine({ link }: { link: SaleCustomerLink }) {
  const { currentView } = link;
  const retry =
    currentView.kind === "error" ? link.handleRetry : link.retryName;
  const failed =
    currentView.kind === "error" || currentView.kind === "customer-error";
  return (
    <div className="grid gap-3" data-sale-customer="">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 [overflow-wrap:anywhere]">
        <span className="text-muted-foreground">Cliente:</span>
        <span
          className={
            failed
              ? "focus-ring rounded-sm text-destructive"
              : "focus-ring rounded-sm font-medium"
          }
          data-sale-customer-name=""
          ref={link.nameLine}
          role="status"
          tabIndex={-1}
        >
          {currentView.label}
        </span>
        {failed ? (
          <Button onClick={retry} size="sm" type="button" variant="link">
            <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
            Tentar novamente
          </Button>
        ) : null}
      </p>
      <CurrentCustomerSummary
        customerId={link.linkedCustomerId}
        load={link.state.currentCustomer}
      />
    </div>
  );
}

function offerOf(
  detail: SaleDetailReadModel | null,
  refreshing: boolean,
  link: SaleCustomerLink
): SaleActionsOffer {
  if (detail === null) {
    return {
      cancel: false,
      choose: null,
      linking: false,
      remove: false,
      return: false,
    };
  }
  const view = saleDetailView(detail);
  return {
    cancel: cancelOffer(view, refreshing) === "panel",
    choose: link.chooseAction?.action ?? null,
    linking: link.status.kind === "submitting",
    remove: link.removeAction !== undefined,
    return: view.canReturn,
  };
}

function SaleDetailContent({
  back,
  organizationId,
  saleId,
}: DetailContentProps) {
  const [load, setLoad] = useState<Loadable<SaleDetailReadModel>>({
    status: "loading",
  });
  const [notice, setNotice] = useState<SaleNotice | null>(null);
  // the sale changed and the detail is being read again: what the page offers is still the old state
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const sequence = useRef<RequestSequence>({ current: 0 });
  // the store's date of the sale, from the last read: a return or a cancellation of a sale from before the open month
  // changes the days the Início keeps ("janela anterior")
  const occurredOn = useRef<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // where the focus goes when a dialog closes: the button that opened the menu, or the notice of a result
  const afterClose = useRef<"notice" | "trigger">("trigger");
  const online = useConnectionOnline();

  const announce = useCallback((next: SaleNotice) => {
    afterClose.current = "notice";
    setNotice(next);
  }, []);
  const link = useSaleCustomerLink({
    onSaved: useCallback(
      (message: string) => announce({ message, ok: true }),
      [announce]
    ),
    organizationId,
    saleId,
  });

  const detail = load.status === "ready" ? load.value : null;
  const open = openDialogs(dialog, detail);
  // a dialog whose panel is gone (the sale changed under it) is not left "open" for the next one with the same key
  const stale = dialog !== null && !open.cancel && !open.return;
  useEffect(() => {
    if (stale) {
      setDialog(null);
      // after the dialog that went away has given the focus back to what opened it
      focusLater(() => noticeRef.current?.focus());
    }
  }, [stale]);
  // a result goes to the notice at once, unless a dialog is still open over it (a failure that keeps its dialog)
  const anyDialogOpen =
    open.cancel || open.return || link.choosing || link.removing;
  const dialogOpen = useRef<boolean>(anyDialogOpen);
  useEffect(() => {
    dialogOpen.current = anyDialogOpen;
  }, [anyDialogOpen]);
  useEffect(() => {
    if (notice !== null && !dialogOpen.current) {
      noticeRef.current?.focus();
    }
  }, [notice]);

  // the summary of the customer counts the sale as it was read: when the sale changes under the page (cancelled or
  // returned here, or from another device), it is read again, which the customer link alone would not do
  const refreshLink = useRef(link.handleRefresh);
  refreshLink.current = link.handleRefresh;
  const saleView = detail === null ? null : saleDetailView(detail);
  const saleState =
    saleView === null
      ? null
      : `${saleView.cancellation === null ? "confirmed" : "cancelled"}:${saleView.returnPanelKey}`;
  const readSaleState = useRef<string | null>(null);
  useEffect(() => {
    if (saleState === null) {
      return;
    }
    if (readSaleState.current !== null && readSaleState.current !== saleState) {
      refreshLink.current();
    }
    readSaleState.current = saleState;
  }, [saleState]);

  const loadDetail = useCallback(async () => {
    const token = nextRequestToken(sequence.current);
    setLoad((current) =>
      current.status === "ready" ? current : { status: "loading" }
    );
    try {
      const value = await readWithRetry(
        () => orpcClient.sale.get({ organizationId, saleId }),
        { isCurrent: () => isLatestRequest(sequence.current, token) }
      );
      if (isLatestRequest(sequence.current, token)) {
        occurredOn.current = value.sale.sale.occurredOn;
        setLoad({ status: "ready", value });
      }
    } catch (error) {
      if (isLatestRequest(sequence.current, token)) {
        setLoad({ message: detailLoadErrorMessage(error), status: "error" });
      }
    }
  }, [organizationId, saleId]);

  useEffect(() => {
    loadDetail().catch(() => undefined);
  }, [loadDetail]);

  const handleRetry = useCallback(() => {
    loadDetail().catch(() => undefined);
  }, [loadDetail]);
  const handleSaleChanged = useCallback(
    (next: SaleNotice) => {
      // also after a failure that asks to reload: the server may have taken the attempt, and a copy that may be old is
      // worse than one more read
      invalidatePreviousWindow(
        browserStorage(),
        organizationId,
        occurredOn.current
      );
      announce(next);
      // only after a success, whose dialog is done: a failure keeps the dialog open, with its locked attempt
      setRefreshing(next.ok);
      loadDetail()
        .catch(() => undefined)
        .then(() => setRefreshing(false));
    },
    [announce, loadDetail, organizationId]
  );
  const handleAction = useCallback(
    (action: SaleAction) => {
      afterClose.current = "trigger";
      if (action === "choose") {
        link.openChoice();
      } else if (action === "remove") {
        link.askRemove();
      } else {
        setDialog({
          action,
          panelKey:
            detail === null ? "" : saleDetailView(detail).returnPanelKey,
        });
      }
    },
    [detail, link.askRemove, link.openChoice]
  );
  const handleDialogClose = useCallback(() => setDialog(null), []);
  const finalFocus = useCallback(
    () =>
      afterClose.current === "notice" && noticeRef.current
        ? noticeRef.current
        : triggerRef.current,
    []
  );

  return (
    <div className={UI_ROOT}>
      <header>
        <TitleLine
          action={
            <SaleActionsMenu
              offer={offerOf(detail, refreshing, link)}
              onAction={handleAction}
              online={online}
              triggerRef={triggerRef}
            />
          }
          back={back}
        >
          <DetailTitle />
        </TitleLine>
      </header>
      <SaleNoticeRegion notice={notice} noticeRef={noticeRef} />
      <CustomerSaveError link={link} />
      {link.status.kind === "submitting" ? (
        <p className="text-muted-foreground" role="status">
          {link.status.message}
        </p>
      ) : null}
      {load.status === "loading" ? (
        <LoadingCard message="Carregando venda…" />
      ) : null}
      {load.status === "error" ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {load.message}
            <Button
              onClick={handleRetry}
              size="sm"
              type="button"
              variant="link"
            >
              <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {detail ? (
        <>
          <ReadyDetailTop
            customer={<CustomerLine link={link} />}
            detail={detail}
            refreshing={refreshing}
          />
          {link.history.length > 0 ? (
            <section aria-label="Histórico de atribuição do cliente">
              <Card className="gap-0 py-0">
                <CardContent className="py-(--card-spacing)">
                  <CustomerHistory level={2} link={link} />
                </CardContent>
              </Card>
            </section>
          ) : null}
          <ReadyDetailDialogs
            detail={detail}
            open={open}
            finalFocus={finalFocus}
            onClose={handleDialogClose}
            onSaleChanged={handleSaleChanged}
            organizationId={organizationId}
            saleId={saleId}
          />
        </>
      ) : null}
      <CustomerDialogs finalFocus={finalFocus} link={link} />
    </div>
  );
}

/** Returns already made. */
function ReturnsHistory({ view }: { view: SaleDetailView }) {
  if (view.returnsHistory.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="sale-returns-title">
      <Card className="gap-0 py-0">
        <CardContent className="grid gap-3 py-(--card-spacing)">
          <h2 className="text-section" id="sale-returns-title">
            Devoluções
          </h2>
          <ul className="grid gap-3">
            {view.returnsHistory.map((entry) => (
              <li
                className="grid gap-1 border-border border-t pt-3 first:border-t-0 first:pt-0"
                key={entry.id}
              >
                <p className="[overflow-wrap:anywhere]">
                  <strong className="font-medium">{entry.dateText}</strong> ·{" "}
                  {entry.reasonText}
                </p>
                {entry.noteText ? (
                  <p className="text-muted-foreground text-support [overflow-wrap:anywhere]">
                    Observação: {entry.noteText}
                  </p>
                ) : null}
                <ul className="grid gap-0.5 text-support">
                  {entry.lines.map((line) => (
                    <li key={line.key}>{line.text}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}

interface ReadyDetailTopProps {
  /** The line that names the customer, in the receipt. */
  customer?: ReactNode;
  detail: SaleDetailReadModel;
  refreshing: boolean;
}

/** What the detail shows on the new interface: the receipt, the timeline, the returns made, and the notes about what is offered. */
export function ReadyDetailTop({
  customer,
  detail,
  refreshing,
}: ReadyDetailTopProps) {
  const view = saleDetailView(detail);
  const offer = cancelOffer(view, refreshing);
  return (
    <>
      <SaleReceipt
        customer={customer}
        before={
          view.cancellation ? (
            <Alert role="note" variant="destructive">
              <AlertTitle>Venda cancelada</AlertTitle>
              <AlertDescription className="grid gap-2">
                <p>
                  O registro original abaixo foi preservado, sem edição. O
                  cancelamento não pode ser desfeito.
                </p>
                <dl className="grid gap-2 sm:grid-cols-2">
                  {view.cancellation.rows.map((row) => (
                    <div className="grid gap-0.5" key={row.label}>
                      <dt className="opacity-80">{row.label}</dt>
                      <dd className="[overflow-wrap:anywhere]">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </AlertDescription>
            </Alert>
          ) : null
        }
        sale={view.sale}
        status={
          <SaleStatusBadges
            returnsBadge={view.returnsBadge}
            statusLabel={view.statusLabel}
            statusTone={view.statusTone}
          />
        }
      />
      <SaleTimeline events={saleTimelineEvents(detail)} />
      <ReturnsHistory view={view} />
      {view.allReturnedMessage ? (
        <StateCard>{view.allReturnedMessage}</StateCard>
      ) : null}
      {view.cancelBlockedReason ? (
        <Alert variant="warning">
          <AlertDescription>{view.cancelBlockedReason}</AlertDescription>
        </Alert>
      ) : null}
      {offer === "waiting" ? (
        <p className="text-muted-foreground" role="status">
          Atualizando a venda…
        </p>
      ) : null}
    </>
  );
}

/** The dialog the menu opened, and the quantities it was opened on: a return whose quantities changed closes. */
interface OpenDialog {
  action: "cancel" | "return";
  panelKey: string;
}

/** Which of the two dialogs is open: only while its panel is still there and, for the return, on the same quantities. */
function openDialogs(
  dialog: OpenDialog | null,
  detail: SaleDetailReadModel | null
) {
  const view = detail === null ? null : saleDetailView(detail);
  return {
    cancel: dialog?.action === "cancel" && view?.canCancel === true,
    return:
      dialog?.action === "return" &&
      view?.canReturn === true &&
      dialog.panelKey === view.returnPanelKey,
  };
}

interface ReadyDetailDialogsProps {
  detail: SaleDetailReadModel;
  finalFocus: DialogFinalFocus;
  onClose: () => void;
  onSaleChanged: (notice: SaleNotice) => void;
  open: ReturnType<typeof openDialogs>;
  organizationId: string;
  saleId: string;
}

/** The forms of the return and of the cancellation, in dialogs that the menu of the title opens. */
function ReadyDetailDialogs({
  detail,
  finalFocus,
  onClose,
  onSaleChanged,
  open,
  organizationId,
  saleId,
}: ReadyDetailDialogsProps) {
  const view = saleDetailView(detail);
  return (
    <>
      {view.canReturn ? (
        <SaleReturnPanel
          finalFocus={finalFocus}
          key={view.returnPanelKey}
          onClose={onClose}
          onSaleChanged={onSaleChanged}
          open={open.return}
          organizationId={organizationId}
          rows={view.returnRows}
          saleId={saleId}
        />
      ) : null}
      {view.canCancel ? (
        <SaleCancelPanel
          finalFocus={finalFocus}
          key={saleId}
          onClose={onClose}
          onSaleChanged={onSaleChanged}
          open={open.cancel}
          organizationId={organizationId}
          saleId={saleId}
          saleItemCount={detail.sale.items.length}
        />
      ) : null}
    </>
  );
}

/** One sale in full: its receipt, its customer, and the actions that change it, in the menu of the title. */
export function SaleDetailPage() {
  const { organizationId } = useCurrentOrganization();
  const [param] = useState(() => readSaleIdParam(window.location.search));
  const back = historyBack(param.kind === "valid" ? param.saleId : null);
  if (param.kind === "valid") {
    return (
      <div className="grid gap-4">
        <SaleDetailContent
          back={back}
          key={param.saleId}
          organizationId={organizationId}
          saleId={param.saleId}
        />
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <div className={UI_ROOT}>
        <header>
          <TitleLine back={back}>
            <DetailTitle />
          </TitleLine>
        </header>
        <SaleIdMissing param={param} />
      </div>
    </div>
  );
}
