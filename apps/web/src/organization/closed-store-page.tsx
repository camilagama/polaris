import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button, buttonVariants } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { documentTitle } from "../app-shell/navigation-model";
import {
  type DataExportCalls,
  DataExportCards,
} from "../data-export/data-export-cards";
import { listRefusal, requestRefusal } from "../data-export/data-export-model";
import { useConnectionOnline } from "../lib/browser-connection";
import {
  closedStorePath,
  closedStoreQuery,
  NEW_STORE_PATH,
  REOPENED_PATH,
} from "../lib/closed-store-path";
import {
  browserStorage,
  writePreferredOrganizationId,
} from "../lib/current-organization-model";
import { legalAcceptancePath } from "../lib/legal-acceptance";
import { orpcClient } from "../lib/orpc";
import { signInPath } from "../lib/sign-in-path";
import { LogoutControl } from "../offline/runtime/logout-control";
import { IdleRuntimeProvider } from "../offline/runtime/runtime-provider";
import { TEXT_LINK } from "../sign-in/entry-ui";
import { NEW_TAB_HINT } from "../sign-in/sign-in-texts";
import { ClosedQueueSection } from "./closed-queue-section";
import {
  type ClosedStore,
  closedExportFileHref,
  closedRequestRefusal,
  closedStoreExports,
  copyClosedText,
  copyRequestOpen,
  DOWNLOAD_BUTTON,
  justClosedText,
  loadAfterFailure,
  loadWhenReading,
  NEW_STORE_LINK,
  type NotRecoverableOutcome,
  notRecoverableOutcome,
  PANEL_BACK_HOME,
  PANEL_CHOOSE_TEXT,
  PANEL_LOAD_FAILED_TEXT,
  PANEL_LOADING_TEXT,
  PANEL_NOT_FOUND_TEXT,
  PANEL_OFFLINE_TEXT,
  PANEL_REFRESH_FAILED_TEXT,
  PANEL_REFRESH_RETRY,
  type PanelLoad,
  panelDates,
  panelLoadFailure,
  panelTitle,
  phaseLines,
  RENEWAL_TERM,
  renewalText,
  UNDO_BACK,
  UNDO_BUTTON,
  UNDO_CONFIRM,
  UNDO_EFFECTS_TEXT,
  UNDO_SENDING,
  UNDO_TITLE,
  type UndoFailure,
  undoFailure,
  undoOpen,
  undoOutcomeUnknown,
} from "./closed-store-model";
import {
  rememberClosedStore,
  rememberClosedStores,
} from "./closed-stores-memory";

const PAGE_TITLE = "Loja encerrada";
const COPY_SECTION_ID = "copia-dos-dados";
const OFFLINE_ID = "closed-store-offline";
const UNDO_DIALOG = "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md";
const OFF = "aria-disabled:pointer-events-none aria-disabled:opacity-50";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `setTimeout` takes no longer delay: a later end of the window is caught by the next read. */
const MAX_TIMER_MS = 2_147_483_647;

/** Each read also refreshes what the Início of an active store remembers of the closed ones (no read of its own). */
async function readStores(storeId: string | null): Promise<ClosedStore[]> {
  if (storeId !== null && UUID.test(storeId)) {
    const { organization } = await orpcClient.organization.closedStatus({
      organizationId: storeId,
    });
    rememberClosedStore(browserStorage(), storeId, organization);
    return organization ? [organization] : [];
  }
  const { organizations } = await orpcClient.organization.listClosed();
  rememberClosedStores(browserStorage(), organizations);
  return organizations;
}

/**
 * Read when the panel opens and on Atualizar only: no timer and no read on focus (the Workers Free plan counts each
 * call, AC-14).
 */
function useClosedStores(storeId: string | null) {
  const [load, setLoad] = useState<PanelLoad>({ status: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    setLoad((previous) => loadWhenReading(previous, round));
    readStores(storeId)
      .then((stores) => {
        if (current) {
          setLoad({ refreshFailed: false, status: "loaded", stores });
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setLoad((previous) =>
            loadAfterFailure(previous, panelLoadFailure(error))
          );
        }
      });
    return () => {
      current = false;
    };
  }, [round, storeId]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { load, reload };
}

function useNowUntil(first: number, second: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const current = Date.now();
    const next = Math.min(
      ...[first, second].filter((at) => at > current),
      Number.POSITIVE_INFINITY
    );
    const wait = next - current;
    if (wait > MAX_TIMER_MS) {
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(timer);
  }, [first, second, now]);
  return Math.max(now, Date.now());
}

function PanelDates({ now, store }: { now: number; store: ClosedStore }) {
  return (
    <dl className="m-0 grid gap-3 sm:grid-cols-[auto_1fr] sm:gap-x-6">
      {panelDates(store, now).map((date) => (
        <div className="contents" key={date.term}>
          <dt className="text-muted-foreground">{date.term}</dt>
          <dd className="m-0 -mt-2 sm:mt-0">
            <span className="font-medium">{date.value}</span>
            {date.left ? (
              <span className="text-muted-foreground"> · {date.left}</span>
            ) : null}
          </dd>
        </div>
      ))}
      <dt className="text-muted-foreground">{RENEWAL_TERM}</dt>
      <dd className="m-0 -mt-2 sm:mt-0">{renewalText(store.renewal)}</dd>
    </dl>
  );
}

interface StatusCardProps {
  now: number;
  online: boolean;
  onRefresh: () => void;
  onUndo: () => void;
  store: ClosedStore;
}

const offlineOff = (online: boolean) =>
  online
    ? {}
    : { "aria-describedby": OFFLINE_ID, "aria-disabled": true as const };

function StatusCard({
  now,
  online,
  onRefresh,
  onUndo,
  store,
}: StatusCardProps) {
  const undo = undoOpen(store, now);
  const handleUndo = useCallback(() => {
    if (online) {
      onUndo();
    }
  }, [online, onUndo]);
  return (
    <Card>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          {phaseLines(store, now).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <PanelDates now={now} store={store} />
        <div className="flex flex-wrap gap-3">
          {store.phase === "purged" ? null : (
            <a
              className={cn(buttonVariants(), "max-sm:w-full")}
              href={`#${COPY_SECTION_ID}`}
            >
              {DOWNLOAD_BUTTON}
            </a>
          )}
          {undo ? (
            <Button
              className="max-sm:w-full"
              onClick={handleUndo}
              variant="outline"
              {...offlineOff(online)}
            >
              {UNDO_BUTTON}
            </Button>
          ) : null}
          <Button
            className="max-sm:w-full"
            onClick={onRefresh}
            variant="outline"
            {...offlineOff(online)}
          >
            Atualizar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CopySection({
  now,
  online,
  store,
}: {
  now: number;
  online: boolean;
  store: ClosedStore;
}) {
  const calls = useMemo<DataExportCalls>(
    () => ({
      list: async () =>
        closedStoreExports(
          (
            await orpcClient.dataExport.listClosed({
              organizationId: store.id,
            })
          ).exports
        ),
      listRefusal,
      request: (formats) =>
        orpcClient.dataExport.requestClosed({
          formats,
          organizationId: store.id,
        }),
      requestRefusal: (error) =>
        closedRequestRefusal(error, store) ?? requestRefusal(error),
    }),
    // an Atualizar of the panel brings a new object with the same store: the list is not read again for it
    [store.id, store.deletionDate, store.exportOpenUntil, store.timezone]
  );
  const open = copyRequestOpen(store, now);
  return (
    <section
      aria-labelledby={`${COPY_SECTION_ID}-title`}
      className="grid scroll-mt-4 gap-4"
      id={COPY_SECTION_ID}
    >
      <h2 className="text-section" id={`${COPY_SECTION_ID}-title`}>
        Cópia dos dados
      </h2>
      <DataExportCards
        calls={calls}
        fileHref={closedExportFileHref}
        online={online}
        requestClosedText={open ? null : copyClosedText(store)}
        timeZone={store.timezone}
      />
    </section>
  );
}

interface UndoDialogProps {
  onBack: () => void;
  onConfirm: () => void;
  open: boolean;
  pending: boolean;
}

function UndoDialog({ onBack, onConfirm, open, pending }: UndoDialogProps) {
  const guarded = useCallback(
    (next: boolean) => {
      if (!(next || pending)) {
        onBack();
      }
    },
    [onBack, pending]
  );
  return (
    <Dialog onOpenChange={guarded} open={open}>
      <DialogContent className={UNDO_DIALOG} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{UNDO_TITLE}</DialogTitle>
          <DialogDescription>{UNDO_EFFECTS_TEXT}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-3">
          <Button
            aria-disabled={pending || undefined}
            className={OFF}
            onClick={pending ? undefined : onBack}
            type="button"
            variant="outline"
          >
            {UNDO_BACK}
          </Button>
          <Button
            aria-disabled={pending || undefined}
            className={OFF}
            onClick={pending ? undefined : onConfirm}
            type="button"
          >
            {pending ? UNDO_SENDING : UNDO_CONFIRM}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface UndoResult {
  from: ClosedStore;
  notice: string;
  store: ClosedStore;
}

function leaveForSession(kind: "acceptance" | "session") {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(
    kind === "session"
      ? signInPath({ reason: "sessao", returnTo })
      : legalAcceptancePath(returnTo)
  );
}

function leaveForReopened(storeId: string) {
  const storage = browserStorage();
  rememberClosedStore(storage, storeId, null);
  writePreferredOrganizationId(storage, storeId);
  window.location.assign(REOPENED_PATH);
}

/** One read of the store after a refusal that does not say which phase it is in; a failed read says nothing of it. */
async function rereadAfterRefusal(
  storeId: string
): Promise<ClosedStore | null | undefined | "acceptance" | "session"> {
  try {
    const [fresh] = await readStores(storeId);
    return fresh ?? null;
  } catch (error: unknown) {
    const failure = panelLoadFailure(error);
    return failure === "error" ? undefined : failure;
  }
}

async function refusedOutcome(
  failure: Extract<UndoFailure, { kind: "not_recoverable" | "said" }>,
  storeId: string
): Promise<NotRecoverableOutcome | "acceptance" | "session"> {
  if (failure.kind === "said") {
    return { kind: "said", store: null, text: failure.text };
  }
  const reread = await rereadAfterRefusal(storeId);
  return typeof reread === "string"
    ? reread
    : notRecoverableOutcome(reread, Date.now());
}

/**
 * The undo: one request however many taps, the dialog held while it is on its way, and the answer said as it is. Only
 * "recovered" says "reaberta" (on the Início it goes to). A refusal that may mean an ended window or a store already
 * reopened is told by a new read of the server (its phase and canRecover), not by the device alone.
 */
function useUndo(store: ClosedStore) {
  const [dialog, setDialog] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<UndoResult | null>(null);
  const sending = useRef<boolean>(false);
  const shown = result?.from === store ? result : null;

  const confirm = useCallback(async () => {
    if (sending.current) {
      return;
    }
    sending.current = true;
    setPending(true);
    try {
      await orpcClient.organization.recoverClosure({
        organizationId: store.id,
      });
      // the button stays locked until the Início replaces the page: a second tap would be refused as "not undone"
      leaveForReopened(store.id);
    } catch (error: unknown) {
      const failure = undoFailure(error);
      if (failure.kind === "session" || failure.kind === "acceptance") {
        leaveForSession(failure.kind);
        return;
      }
      const outcome = await refusedOutcome(failure, store.id);
      if (outcome === "session" || outcome === "acceptance") {
        leaveForSession(outcome);
        return;
      }
      setResult({
        from: store,
        notice: outcome.text,
        store: outcome.store ?? store,
      });
      if (outcome.kind === "reopened") {
        leaveForReopened(store.id);
        return;
      }
      setDialog(false);
      sending.current = false;
      setPending(false);
    }
  }, [store]);

  const open = useCallback(() => {
    setResult(null);
    setDialog(true);
  }, []);
  const back = useCallback(() => setDialog(false), []);
  return {
    back,
    confirm,
    dialog,
    notice: shown?.notice ?? null,
    open,
    pending,
    store: shown?.store ?? store,
  };
}

function UndoNotice({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Alert
      ref={ref}
      role="alert"
      tabIndex={-1}
      // the outcome is not known: a warning, not a refusal
      variant={undoOutcomeUnknown(text) ? "warning" : "destructive"}
    >
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

function RefreshFailedNotice({
  online,
  onRefresh,
}: {
  online: boolean;
  onRefresh: () => void;
}) {
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    retry.current?.focus();
  }, []);
  return (
    <Alert role="alert" variant="warning">
      <AlertDescription className="grid gap-3">
        <span>{PANEL_REFRESH_FAILED_TEXT}</span>
        <Button
          className="w-fit max-sm:w-full"
          onClick={onRefresh}
          ref={retry}
          variant="outline"
          {...offlineOff(online)}
        >
          {PANEL_REFRESH_RETRY}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function StorePanel({
  justClosed,
  notice,
  online,
  onRefresh,
  store: read,
}: {
  justClosed: boolean;
  notice: ReactNode;
  online: boolean;
  onRefresh: () => void;
  store: ClosedStore;
}) {
  const undo = useUndo(read);
  const { store } = undo;
  const now = useNowUntil(
    Date.parse(store.recoverUntil),
    Date.parse(store.exportOpenUntil)
  );
  // the window ends with the dialog open: it closes, unless the request is already on its way
  const dialogOpen = undo.dialog && (undo.pending || undoOpen(store, now));
  return (
    <>
      <h1 className="text-balance font-semibold text-2xl/8 tracking-tight">
        {panelTitle(store)}
      </h1>
      {justClosed ? (
        <Alert role="status">
          <AlertDescription className="text-foreground">
            {justClosedText(store)}
          </AlertDescription>
        </Alert>
      ) : null}
      {notice}
      {undo.notice ? <UndoNotice key={undo.notice} text={undo.notice} /> : null}
      <StatusCard
        now={now}
        online={online}
        onRefresh={onRefresh}
        onUndo={undo.open}
        store={store}
      />
      <UndoDialog
        onBack={undo.back}
        onConfirm={undo.confirm}
        open={dialogOpen}
        pending={undo.pending}
      />
      <ClosedQueueSection store={store} />
      {store.phase === "purged" ? null : (
        <CopySection now={now} online={online} store={store} />
      )}
    </>
  );
}

function StoreChoice({
  notice,
  stores,
}: {
  notice: ReactNode;
  stores: readonly ClosedStore[];
}) {
  return (
    <>
      <h1 className="font-semibold text-2xl/8 tracking-tight">{PAGE_TITLE}</h1>
      {notice}
      <p>{PANEL_CHOOSE_TEXT}</p>
      <ul className="m-0 grid list-none gap-3 p-0">
        {stores.map((store) => (
          <li key={store.id}>
            <a
              className={TEXT_LINK}
              href={closedStorePath({ storeId: store.id })}
            >
              {panelTitle(store)}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

function PanelBody({
  justClosed,
  load,
  online,
  onRefresh,
}: {
  justClosed: boolean;
  load: PanelLoad;
  online: boolean;
  onRefresh: () => void;
}) {
  if (
    load.status === "loading" ||
    load.status === "session" ||
    load.status === "acceptance"
  ) {
    return (
      <p aria-busy="true" className="text-muted-foreground" role="status">
        {PANEL_LOADING_TEXT}
      </p>
    );
  }
  if (load.status === "error") {
    return (
      <>
        <h1 className="font-semibold text-2xl/8 tracking-tight">
          {PAGE_TITLE}
        </h1>
        <Alert role="alert" variant="destructive">
          <AlertDescription>{PANEL_LOAD_FAILED_TEXT}</AlertDescription>
        </Alert>
        <Button
          className="w-fit max-sm:w-full"
          onClick={onRefresh}
          variant="outline"
        >
          Tentar novamente
        </Button>
      </>
    );
  }
  const notice = load.refreshFailed ? (
    <RefreshFailedNotice online={online} onRefresh={onRefresh} />
  ) : null;
  const [only] = load.stores;
  if (!only) {
    return (
      <>
        <h1 className="font-semibold text-2xl/8 tracking-tight">
          {PAGE_TITLE}
        </h1>
        {notice}
        <p>{PANEL_NOT_FOUND_TEXT}</p>
        <a
          className={cn(
            buttonVariants({ variant: "outline" }),
            "w-fit max-sm:w-full"
          )}
          href="/"
        >
          {PANEL_BACK_HOME}
        </a>
      </>
    );
  }
  if (load.stores.length > 1) {
    return <StoreChoice notice={notice} stores={load.stores} />;
  }
  return (
    <StorePanel
      justClosed={justClosed}
      notice={notice}
      online={online}
      onRefresh={onRefresh}
      store={only}
    />
  );
}

export function ClosedStorePage() {
  const [{ justClosed, storeId }] = useState(() =>
    closedStoreQuery(window.location.search)
  );
  const online = useConnectionOnline();
  const { load, reload } = useClosedStores(storeId);

  useEffect(() => {
    document.title = documentTitle(PAGE_TITLE);
    if (justClosed) {
      window.history.replaceState(
        window.history.state,
        "",
        closedStorePath({ storeId: storeId ?? undefined })
      );
    }
  }, [justClosed, storeId]);

  useEffect(() => {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    if (load.status === "session") {
      window.location.assign(signInPath({ reason: "sessao", returnTo }));
    }
    if (load.status === "acceptance") {
      window.location.assign(legalAcceptancePath(returnTo));
    }
  }, [load.status]);

  const handleRefresh = useCallback(() => {
    if (online) {
      reload();
    }
  }, [online, reload]);

  return (
    <div className="min-h-dvh bg-background font-sans text-foreground text-sm antialiased">
      <main
        className="mx-auto grid w-full min-w-0 max-w-2xl content-start gap-4 px-(--gutter) py-8"
        id="conteudo"
      >
        <IdleRuntimeProvider>
          <p className="font-semibold text-[1.0625rem] tracking-tight">
            Polaris
          </p>
          {online ? null : (
            <Alert id={OFFLINE_ID} role="status" variant="warning">
              <AlertDescription>{PANEL_OFFLINE_TEXT}</AlertDescription>
            </Alert>
          )}
          <PanelBody
            justClosed={justClosed}
            load={load}
            online={online}
            onRefresh={handleRefresh}
          />
          <footer className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-border border-t pt-4">
            <a className={TEXT_LINK} href={NEW_STORE_PATH}>
              {NEW_STORE_LINK}
            </a>
            <a
              className={TEXT_LINK}
              href={LEGAL_PATHS.terms}
              rel="noopener noreferrer"
              target="_blank"
            >
              Termos de Uso
              <span className="sr-only"> ({NEW_TAB_HINT})</span>
            </a>
            <LogoutControl
              reason="saiu"
              returnTo={`${window.location.pathname}${window.location.search}`}
            />
          </footer>
        </IdleRuntimeProvider>
      </main>
    </div>
  );
}
