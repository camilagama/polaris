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

export interface DialogEntry {
  readonly depth: number;
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
 * open dialog.
 */
export function createDialogEntries(history: EntryHistory, load: string) {
  const open = new Set<string>();
  let opened = 0;
  return {
    /** A form dialog opened: its entry goes on top, at the same address, keeping what the state had. */
    push(): DialogEntry {
      opened += 1;
      const entry = {
        depth: (entryOf(history.state)?.depth ?? 0) + 1,
        id: `${load}-${opened}`,
      };
      const base =
        typeof history.state === "object" && history.state !== null
          ? history.state
          : {};
      history.pushState({ ...base, [STATE_KEY]: entry }, "");
      open.add(entry.id);
      return entry;
    },
    /** The step back took the entry and closes the dialog: nothing to take out. */
    release(entry: DialogEntry) {
      open.delete(entry.id);
    },
    /** The dialog closed by itself: its entry goes, if it is still the current one. */
    remove(entry: DialogEntry) {
      open.delete(entry.id);
      if (entryOf(history.state)?.id === entry.id) {
        history.back();
      }
    },
    /**
     * On the load and after every step: an entry with no open dialog is stepped over, so the step back that follows
     * leaves the screen. A dialog closed with the one under it (both at once) leaves its entry for this to take.
     */
    settle() {
      const current = entryOf(history.state);
      if (current && !open.has(current.id)) {
        history.back();
      }
    },
    /** After a step back: is the entry of this dialog gone? A dialog over it does not take it. */
    taken(entry: DialogEntry): boolean {
      const current = entryOf(history.state);
      const depth = current?.depth ?? 0;
      return (
        depth < entry.depth ||
        (depth === entry.depth && current?.id !== entry.id)
      );
    },
  };
}

export type DialogEntries = ReturnType<typeof createDialogEntries>;

let pageEntries: DialogEntries | null = null;

/** The stack of this page, made the first time a dialog asks; it steps over what a reload left and keeps doing so. */
export function dialogEntries(): DialogEntries {
  if (!pageEntries) {
    const entries = createDialogEntries(
      window.history,
      Math.random().toString(36).slice(2)
    );
    pageEntries = entries;
    entries.settle();
    window.addEventListener("popstate", () => entries.settle());
  }
  return pageEntries;
}
