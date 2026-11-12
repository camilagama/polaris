/*
 * The classes of the form layout of the Dialog (DESIGN.md, "Diálogo de formulário"), kept out of `dialog.tsx` so a
 * test can read the contract without rendering a portal: below 760 px (`md`) the dialog is the whole screen, with
 * the header and the footer fixed and only the body scrolling; from 760 px it is the centred dialog of every other
 * Dialog, only wider. The strings are written whole, never built, because Tailwind reads the source as text.
 *
 * `--dialog-height` and `--dialog-top` are set from the visual viewport while the dialog is open (`dialog.tsx`):
 * with the keyboard up, the layout viewport (and `dvh`) of iOS and of Chrome for Android does not shrink, and a footer
 * placed by it would sit under the keyboard. Without them the box is `100dvh` and starts at the top.
 */

export const FORM_POPUP_CLASS =
  "fixed z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground text-sm outline-none max-md:inset-x-0 max-md:top-[var(--dialog-top,0px)] max-md:h-[var(--dialog-height,100dvh)] md:top-1/2 md:left-1/2 md:max-h-[calc(100dvh-4rem)] md:w-full md:max-w-[44rem] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:shadow-lg md:ring-1 md:ring-foreground/[0.06]";

export const FORM_HEADER_CLASS =
  "min-h-14 shrink-0 justify-center gap-1 border-b pt-[max(0.75rem,env(safe-area-inset-top))] pr-[max(3.5rem,env(safe-area-inset-right))] pb-3 pl-[max(1rem,env(safe-area-inset-left))] md:px-4 md:pt-4 md:pr-14";

export const FORM_BODY_CLASS =
  "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain py-4 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] md:px-4";

export const FORM_FOOTER_CLASS =
  "m-0 shrink-0 flex-col-reverse gap-3 rounded-none border-t bg-popover pt-2 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] md:flex-row md:justify-end md:rounded-b-xl md:bg-muted/50 md:px-4 md:py-3";

export const FORM_CLOSE_CLASS =
  "top-[max(0.5rem,env(safe-area-inset-top))] right-[max(0.5rem,env(safe-area-inset-right))] md:top-2 md:right-2";

/** A message that stays above the footer, in view while the body scrolls (what keeps a button off, an error of the form). */
export const FORM_NOTICE_CLASS =
  "shrink-0 pb-3 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] md:px-4";

/** The `<form>` that holds the body and the footer, so Enter submits and the footer button is the submit button. */
export const FORM_ELEMENT_CLASS = "flex min-h-0 flex-1 flex-col";

/**
 * The small dialog (a question, a confirmation): centred, and as tall as the part of the window the person can see
 * minus 2 rem (1 rem of margin on each side), scrolling as a whole (text and buttons together, no fixed footer) when it does not fit: with a
 * large font the buttons grow with the text and a fixed footer would take the window. `--dialog-height` and
 * `--dialog-center` are the ones `dialog.tsx` sets from the visual viewport; without them the box is centred in the
 * window and as tall as `100dvh`, so a dialog that fits is placed as it always was.
 */
export const SMALL_POPUP_CLASS =
  "fixed top-[var(--dialog-center,50%)] left-1/2 z-50 grid max-h-[calc(var(--dialog-height,100dvh)-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl bg-popover p-4 text-popover-foreground text-sm shadow-lg outline-none ring-1 ring-foreground/[0.06] sm:max-w-sm";

export const SMALL_FOOTER_CLASS =
  "-mx-4 -mb-4 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end";

/**
 * Keeps a dialog on the part of the screen the person can see. With the keyboard open the layout viewport does not
 * shrink (iOS, and Chrome for Android since 108), so a box sized by `dvh` would put its footer, or the button that
 * ends a small dialog, under the keyboard; the box follows the visual viewport instead, through the custom properties
 * above. Returns the cleanup of the listeners.
 */
export function followVisualViewport(
  popup: HTMLElement | null
): (() => void) | undefined {
  if (!popup) {
    return;
  }
  const stopTopHold = openAtTop(popup);
  const viewport = window.visualViewport;
  if (!viewport) {
    return stopTopHold;
  }
  const sync = () => {
    popup.style.setProperty("--dialog-height", `${viewport.height}px`);
    popup.style.setProperty("--dialog-top", `${viewport.offsetTop}px`);
    popup.style.setProperty(
      "--dialog-center",
      `${viewport.offsetTop + viewport.height / 2}px`
    );
  };
  sync();
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  return () => {
    stopTopHold();
    viewport.removeEventListener("resize", sync);
    viewport.removeEventListener("scroll", sync);
  };
}

const TOUCHED_EVENTS = ["keydown", "pointerdown", "touchstart", "wheel"];

const TEXT_CONTROL = "input, textarea, select, [contenteditable]";

/**
 * A dialog that scrolls as a whole must open showing its first line: the initial focus goes to the first control, and
 * when that control is a footer button below the fold the browser scrolls it into view, so the question would open
 * out of sight (the focus inside a field near the top does not do that). Until the person touches the dialog (key,
 * pointer, touch or wheel) any scroll is put back at the top in the same frame, before it is painted, unless the focus
 * is in a field (it has to be in view, the keyboard of a phone opens on it); after that the focus may scroll to the
 * control as usual, so Tab still reveals what it reaches.
 */
function openAtTop(popup: HTMLElement): () => void {
  let touched = false;
  const markTouched = () => {
    touched = true;
  };
  const putBack = () => {
    if (touched || popup.scrollTop === 0) {
      return;
    }
    if (popup.ownerDocument.activeElement?.matches(TEXT_CONTROL)) {
      return;
    }
    popup.scrollTop = 0;
  };
  for (const name of TOUCHED_EVENTS) {
    popup.addEventListener(name, markTouched, { capture: true, passive: true });
  }
  popup.addEventListener("scroll", putBack, { passive: true });
  return () => {
    for (const name of TOUCHED_EVENTS) {
      popup.removeEventListener(name, markTouched, { capture: true });
    }
    popup.removeEventListener("scroll", putBack);
  };
}
