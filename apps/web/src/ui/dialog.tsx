"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import XIcon from "lucide-react/dist/esm/icons/x";
import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  dialogEntries,
  holdOpenDialog,
  PHONE_QUERY,
} from "@/ui/dialog-history";
import {
  FORM_BODY_CLASS,
  FORM_CLOSE_CLASS,
  FORM_ELEMENT_CLASS,
  FORM_FOOTER_CLASS,
  FORM_HEADER_CLASS,
  FORM_POPUP_CLASS,
} from "@/ui/dialog-layout";

/**
 * The two layouts of the content: the small centred dialog (a question, a confirmation) and the form, which is the
 * whole screen below 760 px and a wider centred dialog from there (DESIGN.md, "Diálogo de formulário").
 */
type DialogLayout = "dialog" | "form";
const DialogLayoutContext = createContext<DialogLayout>("dialog");

/**
 * Keeps the form dialog on the part of the screen the person can see. With the keyboard open the layout viewport
 * does not shrink (iOS, and Chrome for Android since 108), so a box sized by `dvh` would put its footer under the
 * keyboard; the box follows the visual viewport instead, through two custom properties (`dialog-layout.ts`).
 */
function followVisualViewport(
  popup: HTMLElement | null
): (() => void) | undefined {
  const viewport = window.visualViewport;
  if (!(popup && viewport)) {
    return;
  }
  const sync = () => {
    popup.style.setProperty("--dialog-height", `${viewport.height}px`);
    popup.style.setProperty("--dialog-top", `${viewport.offsetTop}px`);
  };
  sync();
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  return () => {
    viewport.removeEventListener("resize", sync);
    viewport.removeEventListener("scroll", sync);
  };
}

// an entry a reload left behind is stepped over as the screen loads, before any dialog opens or the screen is ready
if (typeof window !== "undefined") {
  dialogEntries();
}

/** What the content needs from its root to close itself on a step back: whether it is open, and the way to close it. */
interface DialogRootState {
  actionsRef: RefObject<DialogPrimitive.Root.Actions | null>;
  open: boolean;
}
const DialogRootStateContext = createContext<DialogRootState | null>(null);

/**
 * Below 760 px the form dialog has an entry of its own in the history (`dialog-history.ts`): the step back of the phone
 * closes it as Esc does, through the root (so a form that keeps its draft on Esc keeps it here too, and one busy saving
 * stays open and gets its entry back), and the focus goes back to what opened it. Closed by itself, it takes its entry
 * out. The small dialog (a question, a confirmation) and the desktop never touch the history.
 */
function useStepBackCloses(state: DialogRootState | null, enabled: boolean) {
  const open = enabled && state?.open === true;
  const actionsRef = state?.actionsRef;
  // a step back that the root did not follow (a save on its way): the entry goes back on top
  const [refused, setRefused] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a refused close (a new `refused`) pushes a new entry
  useEffect(() => {
    if (!(open && actionsRef && window.matchMedia(PHONE_QUERY).matches)) {
      return;
    }
    const entries = dialogEntries();
    const entry = entries.push();
    let taken = false;
    const handlePopState = () => {
      if (taken || !entries.taken(entry)) {
        return;
      }
      taken = true;
      entries.release(entry);
      setRefused((count) => count + 1);
      actionsRef.current?.close();
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (!taken) {
        entries.remove(entry);
      }
    };
  }, [actionsRef, open, refused]);
}

function Dialog({
  actionsRef,
  defaultOpen = false,
  onOpenChange,
  open,
  ...props
}: DialogPrimitive.Root.Props) {
  const ownActionsRef = useRef<DialogPrimitive.Root.Actions>(null);
  const actions = actionsRef ?? ownActionsRef;
  // the open state of a dialog that keeps its own (opened by a trigger), for the content to know when it closes
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const handleOpenChange = useCallback(
    (next: boolean, details: DialogPrimitive.Root.ChangeEventDetails): void => {
      onOpenChange?.(next, details);
      if (!details.isCanceled) {
        setOwnOpen(next);
      }
    },
    [onOpenChange]
  );
  const state = useMemo(
    () => ({ actionsRef: actions, open: open ?? ownOpen }),
    [actions, open, ownOpen]
  );
  // an open dialog holds the swap of the build (pwa/swap-guard.ts)
  useEffect(() => (state.open ? holdOpenDialog() : undefined), [state.open]);
  return (
    <DialogRootStateContext.Provider value={state}>
      <DialogPrimitive.Root
        actionsRef={actions}
        data-slot="dialog"
        defaultOpen={defaultOpen}
        onOpenChange={handleOpenChange}
        open={open}
        {...props}
      />
    </DialogRootStateContext.Provider>
  );
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        "data-open:fade-in-0 data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-overlay motion-full:duration-[220ms] motion-full:data-closed:animate-out motion-full:data-open:animate-in supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      data-slot="dialog-overlay"
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  layout = "dialog",
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  /** `"form"`: the whole screen below 760 px, header and footer fixed, only the body scrolling. */
  layout?: DialogLayout;
  showCloseButton?: boolean;
}) {
  const isForm = layout === "form";
  const rootState = useContext(DialogRootStateContext);
  useStepBackCloses(rootState, isForm);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        className={cn(
          "data-open:fade-in-0 data-closed:fade-out-0 motion-full:duration-[220ms] motion-full:data-closed:animate-out motion-full:data-open:animate-in",
          isForm
            ? FORM_POPUP_CLASS
            : "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-popover-foreground text-sm shadow-lg outline-none ring-1 ring-foreground/[0.06] sm:max-w-sm",
          className
        )}
        aria-modal="true"
        data-layout={layout}
        data-slot="dialog-content"
        ref={isForm ? followVisualViewport : undefined}
        {...props}
      >
        <DialogLayoutContext.Provider value={layout}>
          {children}
        </DialogLayoutContext.Provider>
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                className={cn(
                  "absolute top-2 right-2",
                  isForm && FORM_CLOSE_CLASS
                )}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Fechar</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  const isForm = useContext(DialogLayoutContext) === "form";
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        isForm && FORM_HEADER_CLASS,
        className
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

/** The `<form>` of a form dialog: the body that scrolls and the footer that stays, in one submit scope. */
function DialogForm({ className, ...props }: React.ComponentProps<"form">) {
  return (
    <form
      className={cn(FORM_ELEMENT_CLASS, className)}
      data-slot="dialog-form"
      noValidate
      {...props}
    />
  );
}

/** The middle of a form dialog: the only part that scrolls. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("grid content-start gap-4", FORM_BODY_CLASS, className)}
      data-slot="dialog-body"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  const isForm = useContext(DialogLayoutContext) === "form";
  return (
    <div
      className={cn(
        "flex",
        isForm
          ? FORM_FOOTER_CLASS
          : "-mx-4 -mb-4 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      data-slot="dialog-footer"
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Fechar
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("text-section", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn(
        "text-muted-foreground text-sm *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      data-slot="dialog-description"
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
