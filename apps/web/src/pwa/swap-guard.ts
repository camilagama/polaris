import { keptCount, subscribeKept } from "../lib/kept-for-return";
import { hasUnsentWork, subscribeUnsentWork } from "../lib/unsent-work";
import { subscribeWrites, writesInFlight } from "../lib/writes-in-flight";
import { openDialogCount, subscribeOpenDialogs } from "../ui/dialog-history";
import type { PendingWork } from "./update-model";

/**
 * When the page may swap to a new build by itself (ADR 0041, emenda de 28/10/2026). A swap reloads the page, and
 * what lives only in its memory goes with it, so ANY of these holds it:
 *
 * - a dialog open, of form or not (the dialog root registers itself; the "Mais" sheet is a native `<dialog open>`);
 * - a screen that edits and was changed (`useHoldSwap`: the sale with an item, an inline form, the import with a file
 *   chosen, read, running or paused);
 * - a draft kept for the way back (`kept-for-return`), not taken back yet;
 * - a write to the server on its way (`writes-in-flight`; a read never holds);
 * - the sync queue with work: pending, sending or refused (a refusal waits for Pendências);
 * - a field outside a dialog with text typed in it, as a net for a screen that forgot to declare: the search
 *   (`data-swap-ignore`) does not count, and neither does a field never typed in (a value filled by the screen).
 */
export interface SwapState {
  keptDrafts: number;
  openDialogs: number;
  /** Screens holding work typed or picked and not sent (`useHoldSwap`). */
  screensHolding: number;
  typedFields: number;
  work: PendingWork;
  writesInFlight: number;
}

export type SwapHold =
  | "dialog"
  | "kept_draft"
  | "queue"
  | "refused"
  | "screen"
  | "typed_field"
  | "write";

/** What holds the swap now, in a fixed order; empty when the page may swap. */
export function swapHolds(state: SwapState): SwapHold[] {
  const holds: SwapHold[] = [];
  if (state.openDialogs > 0) {
    holds.push("dialog");
  }
  if (state.screensHolding > 0) {
    holds.push("screen");
  }
  if (state.keptDrafts > 0) {
    holds.push("kept_draft");
  }
  if (state.writesInFlight > 0) {
    holds.push("write");
  }
  if (state.work.rejected > 0) {
    holds.push("refused");
  }
  if (state.work.pending + state.work.sending > 0) {
    holds.push("queue");
  }
  if (state.typedFields > 0) {
    holds.push("typed_field");
  }
  return holds;
}

export function swapIsSafe(state: SwapState): boolean {
  return swapHolds(state).length === 0;
}

// ------------------------------------------------------------------ fields typed in
/** The search and other fields whose text is cheap to type again (it is in the address or not worth keeping). */
const SWAP_IGNORE_ATTRIBUTE = "data-swap-ignore";
const NOT_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);
const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"]';
const IGNORE_SELECTOR = `[${SWAP_IGNORE_ATTRIBUTE}]`;

/** What the count reads of a field: the DOM element, or a fake in the tests (no DOM there). */
export interface FieldLike {
  closest: (selector: string) => unknown;
  isConnected: boolean;
  isContentEditable?: boolean;
  tagName: string;
  textContent: string | null;
  type?: string;
  value?: unknown;
}

function isTextField(target: unknown): target is FieldLike {
  if (typeof target !== "object" || target === null || !("tagName" in target)) {
    return false;
  }
  const field = target as FieldLike;
  if (field.tagName === "TEXTAREA") {
    return true;
  }
  if (field.tagName === "INPUT") {
    return !NOT_TEXT_INPUTS.has(String(field.type ?? "text").toLowerCase());
  }
  return field.isContentEditable === true;
}

function textOf(field: FieldLike): string {
  return typeof field.value === "string"
    ? field.value
    : (field.textContent ?? "");
}

/** A field that counts: in the page, outside a dialog (the dialog holds by itself), not marked, with text. */
function holdsText(field: FieldLike): boolean {
  return (
    field.isConnected &&
    field.closest(DIALOG_SELECTOR) === null &&
    field.closest(IGNORE_SELECTOR) === null &&
    textOf(field).trim() !== ""
  );
}

/**
 * Remembers the fields the person typed in (an `input` event: a value the screen filled is not typing) and counts
 * the ones that still hold text. Memory only.
 */
export function createTypedFields() {
  const typed = new Set<FieldLike>();
  const listeners = new Set<() => void>();
  return {
    count(): number {
      let count = 0;
      for (const element of typed) {
        if (!element.isConnected) {
          typed.delete(element);
        } else if (holdsText(element)) {
          count += 1;
        }
      }
      return count;
    },
    /** The `input` listener of the document (capture: a screen that stops the event still counts). */
    onInput(event: { target: unknown }): void {
      const { target } = event;
      if (isTextField(target)) {
        typed.add(target);
        for (const listener of listeners) {
          listener();
        }
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ------------------------------------------------------------------ the page
let pageFields: ReturnType<typeof createTypedFields> | null = null;

function typedFields() {
  if (!pageFields) {
    const fields = createTypedFields();
    pageFields = fields;
    document.addEventListener("input", (event) => fields.onInput(event), true);
  }
  return pageFields;
}

/** Starts listening for typing as the app loads, so a field typed in before the first check counts. */
export function watchTypedFields(): void {
  typedFields();
}

/** The state of this page, but the sync queue (read apart: it is asynchronous). */
export function readPageSwapState(work: PendingWork): SwapState {
  return {
    keptDrafts: keptCount(),
    openDialogs:
      openDialogCount() + document.querySelectorAll("dialog[open]").length,
    screensHolding: hasUnsentWork() ? 1 : 0,
    typedFields: typedFields().count(),
    work,
    writesInFlight: writesInFlight(),
  };
}

/** Calls `listener` whenever something the guard reads may have changed (a dialog closed, a write answered...). */
export function subscribePageSwapState(listener: () => void): () => void {
  const stops = [
    subscribeKept(listener),
    subscribeOpenDialogs(listener),
    subscribeUnsentWork(listener),
    subscribeWrites(listener),
    typedFields().subscribe(listener),
  ];
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}
