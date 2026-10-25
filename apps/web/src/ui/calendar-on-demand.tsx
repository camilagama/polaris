import { useEffect, useState } from "react";
import type { CalendarProps } from "./calendar";

/**
 * How the pickers (and the gallery) draw the calendar: its chunk (react-day-picker, date-fns and `calendar.tsx`) is
 * downloaded when the first calendar is asked for, never with the shell's first script, the same way as the charts
 * (`charts/on-demand.tsx`). The service worker precaches the chunk, so it opens offline too once the app is
 * installed. Until it arrives a box of the size of a month holds the place; if the download fails the box says so,
 * and the next calendar that opens tries again.
 *
 * The only module of the calendar that the rest of the app imports: it imports `calendar.tsx` as a type only, and a
 * guard of the budget plugin fails the build when a module of the calendar is in another chunk.
 */
export type { CalendarProps } from "./calendar";

type CalendarModule = typeof import("./calendar");

let loading: Promise<CalendarModule> | null = null;
let loaded: CalendarModule | null = null;

/** Starts the download, once; a failed one is tried again by the next call. */
function preloadCalendar(): Promise<CalendarModule> {
  if (!loading) {
    loading = import("./calendar").then(
      (module) => {
        loaded = module;
        return module;
      },
      (error: unknown) => {
        // a failed download is tried again by the next calendar that asks, which may find the connection back
        loading = null;
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
  | { status: "failed" | "loading" };

function useCalendarModule(): State {
  // a chunk already downloaded draws on the first render: no box in its place, no jump
  const [state, setState] = useState<State>(
    loaded ? { module: loaded, status: "ready" } : { status: "loading" }
  );
  useEffect(() => {
    if (state.status === "ready") {
      return;
    }
    let current = true;
    preloadCalendar().then(
      (module) => current && setState({ module, status: "ready" }),
      () => current && setState({ status: "failed" })
    );
    return () => {
      current = false;
    };
  }, []);
  return state;
}

export function OnDemandCalendar(props: CalendarProps) {
  const state = useCalendarModule();
  if (state.status === "ready") {
    return <state.module.Calendar {...props} />;
  }
  // the size of the month (six weeks, the caption and the weekdays: 7 cells and 51 px), so the popover does not grow
  // when it arrives
  return (
    <div
      className="grid h-[calc(var(--cell-size)*7+3.1875rem)] w-[calc(var(--cell-size)*7)] place-items-center p-2 text-center text-muted-foreground text-support [--cell-size:2.25rem] touch:[--cell-size:min(2.75rem,calc((100vw_-_3rem)/7))]"
      data-calendar-loading={state.status === "loading" ? "" : undefined}
      role={state.status === "failed" ? "alert" : undefined}
    >
      {state.status === "failed"
        ? "O calendário não abriu. Confira a conexão e abra de novo."
        : null}
    </div>
  );
}
