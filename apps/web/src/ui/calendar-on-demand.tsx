import { useCallback, useEffect, useState } from "react";
import { useHasUnsentWork } from "@/lib/unsent-work";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import type { CalendarProps } from "./calendar";

/**
 * How the pickers (and the gallery) draw the calendar: its chunk (react-day-picker, date-fns and `calendar.tsx`) is
 * downloaded when the first calendar is asked for, never with the shell's first script, the same way as the charts
 * (`charts/on-demand.tsx`). The service worker precaches the chunk, so it opens offline too once the app is
 * installed. Until it arrives a box of the size of a month holds the place; if the download fails the box says so,
 * and offers "Tentar novamente" (with no connection it says so and tries again by itself when it is back). Where the
 * browser does not name the chunk (Safari) the only second try is a new page load: the box offers "Recarregar a
 * página" (only on a click, never by itself), warns when that would take what the person filled in, and with no
 * connection says to connect and reload, with no button until the connection is back.
 *
 * The only module of the calendar that the rest of the app imports: it imports `calendar.tsx` as a type only, and a
 * guard of the budget plugin fails the build when a module of the calendar is in another chunk.
 */
export type { CalendarProps } from "./calendar";

type CalendarModule = typeof import("./calendar");

let loading: Promise<CalendarModule> | null = null;
let loaded: CalendarModule | null = null;
/** The path of the chunk whose download failed (`/assets/calendar-<hash>.js`), once the browser's message has named it. */
let failedChunk: string | null = null;
let retries = 0;
/** The calendars that show a failure, told when another one gets the chunk. */
const waitingForTheChunk = new Set<() => void>();

const CHUNK_URL = /https?:\/\/[^\s"')?#]*\/assets\/calendar-[\w-]+\.js/;

/**
 * The path of the calendar chunk in the message of a failed `import()`: Chrome ("Failed to fetch dynamically imported
 * module: <url>") and Firefox ("error loading dynamically imported module: <url>") name it, Safari ("Importing a
 * module script failed.") does not. Only a chunk of this page's own origin counts (the second try asks for the path,
 * never for a URL the message carried). Null when the message does not name the calendar chunk of `origin`.
 */
export function calendarChunkPath(
  error: unknown,
  origin: string
): string | null {
  const found =
    error instanceof Error ? CHUNK_URL.exec(error.message)?.[0] : undefined;
  if (!found) {
    return null;
  }
  const url = new URL(found);
  return url.origin === origin ? url.pathname : null;
}

/**
 * The browser keeps a module whose download failed in its module map, so a second `import("./calendar")` fails at
 * once without asking the network (the same reason the screens' "Tentar novamente" reloads the page,
 * `app-shell/chunk-load-error.ts`). The chunk never ran, so asking for its path with a new query is a clean second try
 * that shares its dependencies with the first.
 */
function importCalendar(): Promise<CalendarModule> {
  if (failedChunk) {
    retries += 1;
    return import(/* @vite-ignore */ `${failedChunk}?retry=${retries}`);
  }
  return import("./calendar");
}

/** Starts the download, once; a failed one is tried again by the next call. */
function preloadCalendar(): Promise<CalendarModule> {
  if (!loading) {
    loading = importCalendar().then(
      (module) => {
        loaded = module;
        for (const tell of waitingForTheChunk) {
          tell();
        }
        return module;
      },
      (error: unknown) => {
        // a failed download is tried again by the next calendar that asks, which may find the connection back
        loading = null;
        failedChunk =
          calendarChunkPath(error, window.location.origin) ?? failedChunk;
        throw error;
      }
    );
  }
  return loading;
}

/**
 * `preloadCalendar` for the pickers' buttons (pointer or focus on them): a failed download here stays quiet, and the
 * calendar that opens next asks again and says so.
 */
export function warmCalendar(): void {
  preloadCalendar().catch(() => undefined);
}

type State =
  | { module: CalendarModule; status: "ready" }
  | {
      /** Whether the chunk can be asked for again without a new page load (its path is known). */
      inPlace: boolean;
      offline: boolean;
      status: "failed";
    }
  | { status: "loading" };

/** Whether the device says it has no connection (the same read of `navigator.onLine` as the app's chip). */
const deviceOffline = () =>
  typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * Calls `back` once the device is online: at once when it already is (the connection came back between the failure
 * and now, so no event is coming), else on the `online` event. Returns the function that stops listening.
 */
export function whenBackOnline(back: () => void): () => void {
  if (!deviceOffline()) {
    back();
    return () => undefined;
  }
  window.addEventListener("online", back);
  return () => window.removeEventListener("online", back);
}

function useCalendarModule(): {
  reload: () => void;
  retry: () => void;
  state: State;
} {
  // a chunk already downloaded draws on the first render: no box in its place, no jump
  const [state, setState] = useState<State>(
    loaded ? { module: loaded, status: "ready" } : { status: "loading" }
  );
  const waiting = state.status === "loading";
  const failed = state.status === "failed";
  const inPlace = failed && state.inPlace;
  const again = inPlace && state.offline;
  const offlineWithoutRetry = failed && !state.inPlace && state.offline;
  const retry = useCallback(() => setState({ status: "loading" }), []);
  // the browser did not say which chunk failed (Safari), so it cannot be asked for again by its path: a new page load
  // is the only second try, and only the person's click starts it
  const reload = useCallback(() => window.location.reload(), []);
  useEffect(() => {
    if (!waiting) {
      return;
    }
    let current = true;
    preloadCalendar().then(
      (module) => current && setState({ module, status: "ready" }),
      () =>
        current &&
        setState({
          inPlace: failedChunk !== null,
          offline: deviceOffline(),
          status: "failed",
        })
    );
    return () => {
      current = false;
    };
  }, [waiting]);
  useEffect(() => {
    // another calendar (or a warm-up) got the chunk while this one shows the failure
    if (!failed) {
      return;
    }
    const arrived = () =>
      loaded && setState({ module: loaded, status: "ready" });
    arrived();
    waitingForTheChunk.add(arrived);
    return () => {
      waitingForTheChunk.delete(arrived);
    };
  }, [failed]);
  useEffect(() => {
    // "abre quando a conexão voltar": with no connection the calendar asks again by itself when it is back (never by
    // reloading the page, which would take what the person typed: only when the chunk can be asked for again)
    return again ? whenBackOnline(retry) : undefined;
  }, [again, retry]);
  useEffect(() => {
    // no way to ask again without a new page load: when the connection is back the box swaps its text for the one
    // with the button to reload, and the click stays the person's
    if (!offlineWithoutRetry) {
      return;
    }
    return whenBackOnline(() =>
      setState((now) =>
        now.status === "failed" ? { ...now, offline: false } : now
      )
    );
  }, [offlineWithoutRetry]);
  return { reload, retry, state };
}

/** The texts of the box that holds the place of the calendar (DESIGN.md, "Datas"). */
const LOADING_TEXT = "Abrindo o calendário…";
const FAILED_TEXT = "O calendário não abriu.";
const OFFLINE_TEXT = "Sem internet. O calendário abre quando a conexão voltar.";
const OFFLINE_RELOAD_TEXT =
  "Sem internet. Conecte-se e recarregue a página para abrir o calendário.";
const RELOAD_WARNING =
  "Recarregar a página apaga o que você preencheu nesta tela.";

interface FailureProps {
  inPlace: boolean;
  offline: boolean;
  onReload: () => void;
  onRetry: () => void;
  /** Whether a screen holds work that is typed and not sent (a reload would take it). */
  unsent: boolean;
}

/** What the box says and offers once the download failed, for each way the second try can be made. */
export function CalendarFailure({
  inPlace,
  offline,
  onReload,
  onRetry,
  unsent,
}: FailureProps) {
  if (inPlace) {
    return (
      <>
        <p>{offline ? OFFLINE_TEXT : FAILED_TEXT}</p>
        {offline ? null : (
          <Button onClick={onRetry} size="sm" variant="outline">
            Tentar novamente
          </Button>
        )}
      </>
    );
  }
  if (offline) {
    return <p>{OFFLINE_RELOAD_TEXT}</p>;
  }
  return (
    <>
      <p>{unsent ? `${FAILED_TEXT} ${RELOAD_WARNING}` : FAILED_TEXT}</p>
      <Button onClick={onReload} size="sm" variant="outline">
        Recarregar a página
      </Button>
    </>
  );
}

/** `CalendarFailure` with the page's unsent work read live (the work can change while the box is shown). */
function FailedBox(props: Omit<FailureProps, "unsent">) {
  const unsent = useHasUnsentWork();
  return <CalendarFailure {...props} unsent={unsent} />;
}

export function OnDemandCalendar(props: CalendarProps) {
  const { reload, retry, state } = useCalendarModule();
  if (state.status === "ready") {
    return <state.module.Calendar {...props} />;
  }
  // the size of the month (six weeks, the caption and the weekdays: 7 cells and 51 px), so the popover does not grow
  // when it arrives
  return (
    <div
      className={cn(
        "grid h-[calc(var(--cell-size)*7+3.1875rem)] w-[calc(var(--cell-size)*7)] place-items-center content-center justify-items-center gap-3 p-2 text-center text-muted-foreground text-support [--cell-size:2.25rem] touch:[--cell-size:min(2.75rem,calc((100vw_-_3rem)/7))]",
        // the calendar's own class (the gallery narrows the cells to fit its frame): the box takes it too, same size
        props.className
      )}
      data-calendar-loading={state.status === "loading" ? "" : undefined}
      role={state.status === "loading" ? "status" : "alert"}
    >
      {state.status === "loading" ? (
        <span className="sr-only">{LOADING_TEXT}</span>
      ) : (
        <FailedBox
          inPlace={state.inPlace}
          offline={state.offline}
          onReload={reload}
          onRetry={retry}
        />
      )}
    </div>
  );
}
