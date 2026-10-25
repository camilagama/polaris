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
  "m-0 shrink-0 flex-col-reverse gap-3 rounded-none border-t bg-popover pt-3 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] md:flex-row md:justify-end md:rounded-b-xl md:bg-muted/50 md:px-4 md:py-3";

export const FORM_CLOSE_CLASS =
  "top-[max(0.5rem,env(safe-area-inset-top))] right-[max(0.5rem,env(safe-area-inset-right))] md:top-2 md:right-2";

/** A message that stays above the footer, in view while the body scrolls (what keeps a button off, an error of the form). */
export const FORM_NOTICE_CLASS =
  "shrink-0 pb-3 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] md:px-4";

/** The `<form>` that holds the body and the footer, so Enter submits and the footer button is the submit button. */
export const FORM_ELEMENT_CLASS = "flex min-h-0 flex-1 flex-col";
