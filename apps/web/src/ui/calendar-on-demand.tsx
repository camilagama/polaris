import { useCallback, useEffect, useState } from "react";
import { Button } from "@/ui/button";
import type { CalendarProps } from "./calendar";

/**
 * How the pickers (and the gallery) draw the calendar: its chunk (react-day-picker, date-fns and `calendar.tsx`) is
 * downloaded when the first calendar is asked for, never with the shell's first script, the same way as the charts
 * (`charts/on-demand.tsx`). The service worker precaches the chunk, so it opens offline too once the app is
 * installed. Until it arrives a box of the size of a month holds the place; if the download fails the box says so,
 * and offers "Tentar novamente" (with no connection it says so and tries again by itself when it is back).
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

function useCalendarModule(): { retry: () => void; state: State } {
  // a chunk already downloaded draws on the first render: no box in its place, no jump
  const [state, setState] = useState<State>(
    loaded ? { module: loaded, status: "ready" } : { status: "loading" }
  );
  const waiting = state.status === "loading";
  const failed = state.status === "failed";
  const again = failed && state.inPlace && state.offline;
  const inPlace = failed && state.inPlace;
  const retry = useCallback(() => {
    if (!inPlace) {
      // the browser did not say which chunk failed (Safari), so it cannot be asked for again by its path: a new page
      // load is the only second try
      window.location.reload();
      return;
    }
    setState({ status: "loading" });
  }, [inPlace]);
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
    if (!again) {
      return;
    }
    const ask = () => setState({ status: "loading" });
    if (!deviceOffline()) {
      // the connection came back between the failure and this effect: no event is coming
      ask();
      return;
    }
    window.addEventListener("online", ask);
    return () => window.removeEventListener("online", ask);
  }, [again]);
  return { retry, state };
}

/** The texts of the box that holds the place of the calendar (DESIGN.md, "Datas"). */
const LOADING_TEXT = "Abrindo o calendário…";
const FAILED_TEXT = "O calendário não abriu.";
const OFFLINE_TEXT = "Sem internet. O calendário abre quando a conexão voltar.";

export function OnDemandCalendar(props: CalendarProps) {
  const { retry, state } = useCalendarModule();
  if (state.status === "ready") {
    return <state.module.Calendar {...props} />;
  }
  // the size of the month (six weeks, the caption and the weekdays: 7 cells and 51 px), so the popover does not grow
  // when it arrives
  return (
    <div
      className="grid h-[calc(var(--cell-size)*7+3.1875rem)] w-[calc(var(--cell-size)*7)] place-items-center content-center justify-items-center gap-3 p-2 text-center text-muted-foreground text-support [--cell-size:2.25rem] touch:[--cell-size:min(2.75rem,calc((100vw_-_3rem)/7))]"
      data-calendar-loading={state.status === "loading" ? "" : undefined}
      role={state.status === "loading" ? "status" : "alert"}
    >
      {state.status === "loading" ? (
        <span className="sr-only">{LOADING_TEXT}</span>
      ) : (
        <>
          <p>{state.offline ? OFFLINE_TEXT : FAILED_TEXT}</p>
          {state.offline && state.inPlace ? null : (
            <Button onClick={retry} size="sm" variant="outline">
              Tentar novamente
            </Button>
          )}
        </>
      )}
    </div>
  );
}
