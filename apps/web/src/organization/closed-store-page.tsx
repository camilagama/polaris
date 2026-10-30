import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button, buttonVariants } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { documentTitle } from "../app-shell/navigation-model";
import {
  type DataExportCalls,
  DataExportCards,
} from "../data-export/data-export-cards";
import { listRefusal, requestRefusal } from "../data-export/data-export-model";
import { useConnectionOnline } from "../lib/browser-connection";
import { closedStorePath, closedStoreQuery } from "../lib/closed-store-path";
import { legalAcceptancePath } from "../lib/legal-acceptance";
import { orpcClient } from "../lib/orpc";
import { signInPath } from "../lib/sign-in-path";
import { LogoutControl } from "../offline/runtime/logout-control";
import { IdleRuntimeProvider } from "../offline/runtime/runtime-provider";
import { TEXT_LINK } from "../sign-in/entry-ui";
import { NEW_TAB_HINT } from "../sign-in/sign-in-texts";
import {
  type ClosedStore,
  closedExportFileHref,
  closedRequestRefusal,
  closedStoreExports,
  copyClosedText,
  copyRequestOpen,
  DOWNLOAD_BUTTON,
  justClosedText,
  PANEL_BACK_HOME,
  PANEL_CHOOSE_TEXT,
  PANEL_LOAD_FAILED_TEXT,
  PANEL_LOADING_TEXT,
  PANEL_NOT_FOUND_TEXT,
  PANEL_OFFLINE_TEXT,
  panelDates,
  panelLoadFailure,
  panelTitle,
  phaseLines,
  RENEWAL_TERM,
  renewalText,
  UNDO_BUTTON,
  UNDO_UNAVAILABLE_TEXT,
  undoOpen,
} from "./closed-store-model";

const PAGE_TITLE = "Loja encerrada";
const COPY_SECTION_ID = "copia-dos-dados";
const UNDO_REASON_ID = "closed-store-undo-reason";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `setTimeout` takes no longer delay: a later end of the window is caught by the next read. */
const MAX_TIMER_MS = 2_147_483_647;

type Load =
  | { status: "loading" }
  | { status: "error" }
  | { status: "session" }
  | { status: "acceptance" }
  | { status: "loaded"; stores: readonly ClosedStore[] };

async function readStores(storeId: string | null): Promise<ClosedStore[]> {
  if (storeId !== null && UUID.test(storeId)) {
    const { organization } = await orpcClient.organization.closedStatus({
      organizationId: storeId,
    });
    return organization ? [organization] : [];
  }
  return (await orpcClient.organization.listClosed()).organizations;
}

/**
 * Read when the panel opens and on Atualizar only: no timer and no read on focus (the Workers Free plan counts each
 * call, AC-14).
 */
function useClosedStores(storeId: string | null) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    setLoad((previous) =>
      previous.status === "loaded" && round > 0
        ? previous
        : { status: "loading" }
    );
    readStores(storeId)
      .then((stores) => {
        if (current) {
          setLoad({ status: "loaded", stores });
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setLoad({ status: panelLoadFailure(error) });
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
  onUndo?: ((store: ClosedStore) => void) | undefined;
  store: ClosedStore;
}

function StatusCard({
  now,
  online,
  onRefresh,
  onUndo,
  store,
}: StatusCardProps) {
  const undo = undoOpen(store, now);
  const handleUndo = useCallback(() => {
    if (online && onUndo) {
      onUndo(store);
    }
  }, [online, onUndo, store]);
  const undoOff = !(online && onUndo);
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
              aria-describedby={undoOff ? UNDO_REASON_ID : undefined}
              aria-disabled={undoOff ? true : undefined}
              className="max-sm:w-full"
              onClick={handleUndo}
              variant="outline"
            >
              {UNDO_BUTTON}
            </Button>
          ) : null}
          <Button
            className="max-sm:w-full"
            onClick={onRefresh}
            variant="outline"
            {...(online
              ? {}
              : {
                  "aria-describedby": "closed-store-offline",
                  "aria-disabled": true,
                })}
          >
            Atualizar
          </Button>
        </div>
        {undo && !onUndo ? (
          <p className="text-muted-foreground" id={UNDO_REASON_ID}>
            {UNDO_UNAVAILABLE_TEXT}
          </p>
        ) : null}
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

function StorePanel({
  justClosed,
  online,
  onRefresh,
  store,
}: {
  justClosed: boolean;
  online: boolean;
  onRefresh: () => void;
  store: ClosedStore;
}) {
  const now = useNowUntil(
    Date.parse(store.recoverUntil),
    Date.parse(store.exportOpenUntil)
  );
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
      <StatusCard
        now={now}
        online={online}
        onRefresh={onRefresh}
        store={store}
      />
      {store.phase === "purged" ? null : (
        <CopySection now={now} online={online} store={store} />
      )}
    </>
  );
}

function StoreChoice({ stores }: { stores: readonly ClosedStore[] }) {
  return (
    <>
      <h1 className="font-semibold text-2xl/8 tracking-tight">{PAGE_TITLE}</h1>
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
  load: Load;
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
  const [only] = load.stores;
  if (!only) {
    return (
      <>
        <h1 className="font-semibold text-2xl/8 tracking-tight">
          {PAGE_TITLE}
        </h1>
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
    return <StoreChoice stores={load.stores} />;
  }
  return (
    <StorePanel
      justClosed={justClosed}
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
        <p className="font-semibold text-[1.0625rem] tracking-tight">Polaris</p>
        {online ? null : (
          <Alert id="closed-store-offline" role="status" variant="warning">
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
          <a
            className={TEXT_LINK}
            href={LEGAL_PATHS.terms}
            rel="noopener noreferrer"
            target="_blank"
          >
            Termos de Uso
            <span className="sr-only"> ({NEW_TAB_HINT})</span>
          </a>
          <IdleRuntimeProvider>
            <LogoutControl
              reason="saiu"
              returnTo={`${window.location.pathname}${window.location.search}`}
            />
          </IdleRuntimeProvider>
        </footer>
      </main>
    </div>
  );
}
