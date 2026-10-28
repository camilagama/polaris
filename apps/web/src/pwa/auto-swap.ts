import {
  IDLE_MS,
  RETURN_AFTER_MS,
  RETURN_WINDOW_MS,
  type SwapMoment,
} from "./update-model";
import type { UpdateSnapshot } from "./update-store";

/**
 * Turns what the page sees (the tab hidden or back, the person touching or not) into the moments of a swap
 * (`update-model.ts`), and asks the store to swap at each one. The store decides whether the build waited long
 * enough and whether the page holds anything; this only says when to ask, and asks again while the moment lasts and
 * something that held the swap goes away (a dialog closed with the tab hidden).
 */
export interface AutoSwapStore {
  getSnapshot: () => UpdateSnapshot;
  subscribe: (listener: () => void) => () => void;
  trySwap: (moment: SwapMoment, lasts?: () => boolean) => Promise<boolean>;
}

type Listen = (
  type: string,
  listener: () => void,
  options?: AddEventListenerOptions
) => void;

export interface AutoSwapPage {
  addDocumentListener: Listen;
  addWindowListener: Listen;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Calls the listener when what holds a swap may have changed (`subscribePageSwapState`). */
  subscribeGuard: (listener: () => void) => () => void;
  visibility: () => DocumentVisibilityState;
}

/** A touch, a key, the wheel or a scroll: the person is there. */
const ACTIVITY_EVENTS = [
  "keydown",
  "pointerdown",
  "scroll",
  "touchstart",
  "wheel",
] as const;

export function startAutoSwap(store: AutoSwapStore, page: AutoSwapPage) {
  let hiddenAt: number | null =
    page.visibility() === "hidden" ? page.now() : null;
  let lastActivity = page.now();
  /** When the tab came back after a while away, while nothing was touched since; null otherwise. */
  let returnedAt: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let asking = false;
  let askAgain = false;

  const returning = () =>
    returnedAt !== null && page.now() - returnedAt <= RETURN_WINDOW_MS;
  /** Whether the moment still holds: asked again right before the reload of the swap. */
  const lasts = (moment: SwapMoment) => () => {
    if (moment === "hidden") {
      return page.visibility() === "hidden";
    }
    if (page.visibility() !== "visible") {
      return false;
    }
    return moment === "return"
      ? returning()
      : page.now() - lastActivity >= IDLE_MS;
  };
  const momentNow = (): SwapMoment | null => {
    if (page.visibility() === "hidden") {
      return "hidden";
    }
    return returning() ? "return" : null;
  };
  /** Asks the store at the moment there is now; one question at a time, the last change asked again after. */
  const ask = (moment: SwapMoment | null = momentNow()) => {
    if (moment === null || !store.getSnapshot().pending) {
      return;
    }
    if (asking) {
      askAgain = true;
      return;
    }
    asking = true;
    store
      .trySwap(moment, lasts(moment))
      .catch(() => false)
      .finally(() => {
        asking = false;
        if (askAgain) {
          askAgain = false;
          ask();
        }
      });
  };

  const armIdle = (delay: number) => {
    if (idleTimer !== null) {
      page.clearTimeout(idleTimer);
    }
    idleTimer = page.setTimeout(() => {
      idleTimer = null;
      const idleFor = page.now() - lastActivity;
      if (page.visibility() === "hidden") {
        // still hidden: a build that finished settling meanwhile goes in now, not only at the return
        ask("hidden");
        armIdle(IDLE_MS);
      } else if (idleFor >= IDLE_MS) {
        ask("idle");
        // still idle and the build not old enough yet: look again after another while
        armIdle(IDLE_MS);
      } else {
        armIdle(IDLE_MS - idleFor);
      }
    }, delay);
  };

  page.addDocumentListener("visibilitychange", () => {
    if (page.visibility() === "hidden") {
      hiddenAt = page.now();
      returnedAt = null;
      ask("hidden");
      return;
    }
    const away = hiddenAt === null ? 0 : page.now() - hiddenAt;
    hiddenAt = null;
    lastActivity = page.now();
    returnedAt = away >= RETURN_AFTER_MS ? page.now() : null;
    ask();
  });
  for (const type of ACTIVITY_EVENTS) {
    page.addWindowListener(
      type,
      () => {
        returnedAt = null;
        lastActivity = page.now();
      },
      { capture: true, passive: true }
    );
  }
  let { pending: seen } = store.getSnapshot();
  store.subscribe(() => {
    const { pending } = store.getSnapshot();
    if (pending !== seen) {
      seen = pending;
      ask();
    }
  });
  page.subscribeGuard(() => ask());
  armIdle(IDLE_MS);
}

// ------------------------------------------------------------------ the screen as it was (the idle swap)
const SCROLL_KEY = "polarisSwapScroll";
/** How long the page tries to bring the scroll back while the screen loads its content. */
const RESTORE_FOR_MS = 5000;

interface ScrollPosition {
  x: number;
  y: number;
}

function stateObject(): Record<string, unknown> {
  const { state } = window.history;
  return typeof state === "object" && state !== null ? { ...state } : {};
}

/**
 * Before the reload of an idle swap: the scroll goes in the entry of the history (the address and the tab are in the
 * address already), so the page loads where it was. Not in the browser's storage: the entry is this tab's own.
 */
export function keepScrollForReload(): void {
  const position: ScrollPosition = { x: window.scrollX, y: window.scrollY };
  window.history.replaceState({ ...stateObject(), [SCROLL_KEY]: position }, "");
}

function keptScroll(state: Record<string, unknown>): ScrollPosition | null {
  const value = state[SCROLL_KEY] as Partial<ScrollPosition> | undefined;
  return typeof value?.x === "number" && typeof value.y === "number"
    ? { x: value.x, y: value.y }
    : null;
}

/**
 * After the load: brings the scroll back and holds it there while the screen loads its content, for a few seconds,
 * and gives up at the first touch or key. The focus stays where a load leaves it.
 */
export function restoreScrollAfterSwap(): void {
  const state = stateObject();
  const position = keptScroll(state);
  if (!position) {
    return;
  }
  delete state[SCROLL_KEY];
  window.history.replaceState(Object.keys(state).length > 0 ? state : null, "");
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  for (const type of ["keydown", "pointerdown", "touchstart", "wheel"]) {
    window.addEventListener(type, stop, { capture: true, once: true });
  }
  // held for the whole window, not only until it is reached: what loads above it later (a list, a notice) would
  // move the screen again, through the scroll anchoring of the browser
  const until = Date.now() + RESTORE_FOR_MS;
  const step = () => {
    if (stopped) {
      return;
    }
    if (
      Math.abs(window.scrollY - position.y) >= 1 ||
      Math.abs(window.scrollX - position.x) >= 1
    ) {
      window.scrollTo(position.x, position.y);
    }
    if (Date.now() < until) {
      window.requestAnimationFrame(step);
    }
  };
  window.requestAnimationFrame(step);
}
