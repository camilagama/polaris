/**
 * The step back of a phone closes the form dialog (DESIGN.md, "Diálogo de formulário"). Below 760 px the form dialog
 * looks like a screen, and "voltar" is how one leaves a screen: each open form dialog has an entry of its own in the
 * history, at the same address, and the step back takes the top one and closes its dialog, which keeps the draft as Esc
 * does. A dialog that closes by itself (Esc, ×, Cancelar, Salvar) takes its own entry out, so the next step back leaves
 * the screen as before: no step back that does nothing is left behind.
 *
 * The entries are a stack written in `history.state`: each one knows its depth (1 for the first dialog, 2 for one opened
 * over it) and an id. An entry with no open dialog behind it (left by a reload, or reached by a step forward) is stepped
 * over at once.
 */
const STATE_KEY = "polarisDialog";

/** Below `md` (760 px), where the form dialog is the whole screen: the exact complement of `md:`. */
export const PHONE_QUERY = "not all and (min-width: 47.5rem)";

/** The place of an open form dialog in the stack: its depth is known once its entry is in the history. */
export interface DialogEntry {
  depth: number | null;
  readonly id: string;
}

export type EntryHistory = Pick<History, "back" | "pushState" | "state">;

export function entryOf(state: unknown): DialogEntry | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const entry: unknown = (state as Record<string, unknown>)[STATE_KEY];
  if (
    typeof entry === "object" &&
    entry !== null &&
    "depth" in entry &&
    "id" in entry &&
    typeof entry.depth === "number" &&
    typeof entry.id === "string"
  ) {
    return { depth: entry.depth, id: entry.id };
  }
  return null;
}

/**
 * The stack of one page. `load` tells the ids of this page from those a reload left in the history, which belong to no
 * open dialog. A step back the stack asked for lands later (the browser queues it): a dialog that opens meanwhile writes
 * its entry only when the step has landed, or the step would take the new entry instead of the old one.
 */
export function createDialogEntries(history: EntryHistory, load: string) {
  const open = new Set<string>();
  const waiting: DialogEntry[] = [];
  let stepsOnTheWay = 0;
  let opened = 0;
  // what waits for the steps back of the stack to land (a navigation after a dialog closed)
  const afterLanding: Array<() => void> = [];
  const runAfterLanding = () => {
    for (const run of afterLanding.splice(0)) {
      run();
    }
  };

  const stepBack = () => {
    stepsOnTheWay += 1;
    history.back();
  };
  const write = (entry: DialogEntry) => {
    entry.depth = (entryOf(history.state)?.depth ?? 0) + 1;
    const base =
      typeof history.state === "object" && history.state !== null
        ? history.state
        : {};
    history.pushState(
      { ...base, [STATE_KEY]: { depth: entry.depth, id: entry.id } },
      ""
    );
  };
  /**
   * An entry with no open dialog is stepped over, so the step back that follows leaves the screen: one left by a
   * reload, reached by a step forward, or left by a dialog closed with the one under it (both at once).
   */
  const settle = () => {
    const current = entryOf(history.state);
    if (current && !open.has(current.id)) {
      stepBack();
    }
  };

  return {
    /** A form dialog opened: its entry goes on top, at the same address, keeping what the state had. */
    push(): DialogEntry {
      opened += 1;
      const entry: DialogEntry = { depth: null, id: `${load}-${opened}` };
      open.add(entry.id);
      if (stepsOnTheWay > 0) {
        waiting.push(entry);
      } else {
        write(entry);
      }
      return entry;
    },
    /** The step back took the entry and closes the dialog: nothing to take out. */
    release(entry: DialogEntry) {
      open.delete(entry.id);
    },
    /** The dialog closed by itself: its entry goes, if it is still the current one. */
    remove(entry: DialogEntry) {
      open.delete(entry.id);
      const queued = waiting.indexOf(entry);
      if (queued >= 0) {
        waiting.splice(queued, 1);
      } else if (entryOf(history.state)?.id === entry.id) {
        stepBack();
      }
    },
    settle,
    /** Every step that lands, before the dialogs hear of it: once the stack's own steps are done, it settles. */
    landed() {
      stepsOnTheWay = Math.max(0, stepsOnTheWay - 1);
      if (stepsOnTheWay > 0) {
        return;
      }
      settle();
      if (stepsOnTheWay === 0) {
        for (const entry of waiting.splice(0)) {
          write(entry);
        }
        runAfterLanding();
      }
    },
    /**
     * Runs once the steps back the stack asked for have landed: a new entry pushed before that would be the one the
     * step takes. With no step on the way, it runs now.
     */
    afterSteps(run: () => void) {
      afterLanding.push(run);
      if (stepsOnTheWay === 0) {
        runAfterLanding();
      }
    },
    /** After a step back: is the entry of this dialog gone? A dialog over it does not take it. */
    taken(entry: DialogEntry): boolean {
      if (entry.depth === null) {
        return false;
      }
      const current = entryOf(history.state);
      const depth = current?.depth ?? 0;
      return (
        depth < entry.depth ||
        (depth === entry.depth && current?.id !== entry.id)
      );
    },
  };
}

type DialogEntries = ReturnType<typeof createDialogEntries>;

let pageEntries: DialogEntries | null = null;

/**
 * The stack of this page, made as `dialog.tsx` loads: it steps over what a reload left, and hears every step before the
 * dialogs do (its listener is the first).
 */
export function dialogEntries(): DialogEntries {
  if (!pageEntries) {
    const entries = createDialogEntries(
      window.history,
      Math.random().toString(36).slice(2)
    );
    pageEntries = entries;
    window.addEventListener("popstate", () => entries.landed());
    entries.settle();
  }
  return pageEntries;
}
