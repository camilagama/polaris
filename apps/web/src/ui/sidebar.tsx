"use client";

import XIcon from "lucide-react/dist/esm/icons/x";
import {
  type AnimationEvent,
  type ComponentProps,
  type CSSProperties,
  createContext,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useIsMobile } from "@/lib/use-mobile";

/* Polaris v5.1: the shadcn Sidebar, cut to the parts the shell uses and with no primitive of Base UI (the frame of
   every screen is in the entry chunk, where a primitive would pull its shared code out of the screens' chunks). From 760 px it is the fixed column
   of 16 rem; below, the same content opens in a modal panel (the "Mais" of the bottom bar). No collapsing, no rail, no
   keyboard shortcut, no cookie: the shell never folds the column. Focus is the 3 px outline (`focus-ring`); items
   are 32 px with a mouse and 48 px with touch; the group label has no transparency. */
const SIDEBAR_WIDTH = "16rem";

/* The classes of a part and the ones its caller adds. No tailwind-merge here (it would come to the entry chunk with
   the shell): a caller never repeats a property the part already sets. */
const cx = (base: string, extra?: string) =>
  extra ? `${base} ${extra}` : base;
const SIDEBAR_WIDTH_MOBILE = "18rem";

interface SidebarContextProps {
  isMobile: boolean;
  /** The control that opens the panel below 760 px (the "Mais" of the shell): the focus goes back to it. */
  mobileTrigger: RefObject<HTMLButtonElement | null>;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }
  return context;
}

function SidebarProvider({
  className,
  style,
  children,
  ...props
}: ComponentProps<"div">) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = useState(false);
  // the panel exists only below 760 px: crossing the line closes it, so it never comes back open by itself
  useEffect(() => {
    if (!isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile]);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const contextValue = useMemo<SidebarContextProps>(
    () => ({ isMobile, mobileTrigger, openMobile, setOpenMobile }),
    [isMobile, openMobile]
  );
  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        className={cx("group/sidebar-wrapper flex min-h-svh w-full", className)}
        data-slot="sidebar-wrapper"
        style={{ "--sidebar-width": SIDEBAR_WIDTH, ...style } as CSSProperties}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

/* The entrance and the exit of the panel are the `Sheet` of the registry: 200 ms, `ease-in-out`, fade and a slide of
   2.5 rem to the side. The exit has a class set of its own (swapped in while it runs) so the two `animation`s never
   compete, and the veil (`::backdrop`) fades with the panel. */
const SHEET_ENTER =
  "open:fade-in-0 data-[side=left]:open:slide-in-from-left-10 data-[side=right]:open:slide-in-from-right-10 open:animate-in open:duration-200 open:ease-in-out";
const SHEET_EXIT =
  "animate-out fade-out-0 fill-mode-forwards data-[side=left]:slide-out-to-left-10 data-[side=right]:slide-out-to-right-10 duration-200 ease-in-out backdrop:animate-out backdrop:fade-out-0 backdrop:fill-mode-forwards backdrop:duration-200 backdrop:ease-in-out";
/** The time to wait for `animationend` before closing anyway (the exit takes 200 ms). */
const EXIT_GUARD_MS = 300;

/**
 * Below 760 px the sidebar is a modal panel on the native `<dialog>` (the shadcn Sidebar opens a Sheet there; the
 * native element gives the same: the page behind is inert, Escape closes, the focus stays inside, and it costs no
 * script of a primitive). Every way out (Escape, the veil, "Fechar", the state going to closed) asks for the close
 * through one path: the exit animation runs (`data-closing`) and the dialog closes at `animationend`, or after a guard
 * if the event never comes, or at once with `prefers-reduced-motion: reduce`. Closing hands the focus back to what
 * opened it.
 */
function MobileSheet({
  children,
  onOpenChange,
  open,
  side,
  title,
}: {
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  side: "left" | "right";
  title: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const guard = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [closing, setClosing] = useState(false);
  const { mobileTrigger } = useSidebar();
  const clearClosing = useCallback(() => {
    clearTimeout(guard.current);
    ref.current?.removeAttribute("data-closing");
    setClosing(false);
  }, []);
  const finishClose = useCallback(() => {
    const dialog = ref.current;
    if (dialog?.open) {
      dialog.close();
    } else {
      // already closed: no `close` event will come to undo the closing state
      clearClosing();
    }
  }, [clearClosing]);
  const requestClose = useCallback(() => {
    const dialog = ref.current;
    if (!dialog?.open || dialog.hasAttribute("data-closing")) {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finishClose();
      return;
    }
    // set on the node at once: a second request in the same frame (before the render) is ignored
    dialog.setAttribute("data-closing", "");
    setClosing(true);
    guard.current = setTimeout(finishClose, EXIT_GUARD_MS);
    // the state says closed while the exit runs, so that opening it again (the "Sair" warning) is a real change
    onOpenChange(false);
  }, [finishClose, onOpenChange]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (open && dialog.hasAttribute("data-closing")) {
      // asked to open again while it was leaving: stay
      clearClosing();
    } else if (!open) {
      requestClose();
    }
  }, [clearClosing, open, requestClose]);
  useEffect(() => () => clearTimeout(guard.current), []);
  const handleClose = useCallback(() => {
    clearClosing();
    onOpenChange(false);
    // the trigger, not the element focused before: Safari does not focus a button on a click
    mobileTrigger.current?.focus();
  }, [clearClosing, mobileTrigger, onOpenChange]);
  // Escape cancels the native close: the exit animation runs first
  const handleCancel = useCallback(
    (event: SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      requestClose();
    },
    [requestClose]
  );
  // a click on the veil (the dialog box itself, outside the panel) closes it
  const handleClick = useCallback(
    (event: MouseEvent<HTMLDialogElement>) => {
      if (event.target === event.currentTarget) {
        requestClose();
      }
    },
    [requestClose]
  );
  // the panel and the veil animate together: the first end of the closing animation closes
  const handleAnimationEnd = useCallback(
    (event: AnimationEvent<HTMLDialogElement>) => {
      if (
        event.target === event.currentTarget &&
        event.animationName === "exit" &&
        event.currentTarget.hasAttribute("data-closing")
      ) {
        finishClose();
      }
    },
    [finishClose]
  );
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard closes it with Escape, which the native dialog handles
    <dialog
      aria-label={title}
      className={`${closing ? SHEET_EXIT : SHEET_ENTER} fixed inset-y-0 m-0 h-dvh max-h-none w-(--sidebar-width) max-w-[85vw] border-0 bg-sidebar p-0 text-sidebar-foreground text-sm shadow-lg ring-1 ring-foreground/[0.06] backdrop:bg-overlay open:flex open:flex-col data-[side=right]:right-0 data-[side=left]:left-0 data-[side=right]:left-auto`}
      data-mobile="true"
      data-side={side}
      data-sidebar="sidebar"
      data-slot="sidebar"
      onAnimationEnd={handleAnimationEnd}
      onCancel={handleCancel}
      onClick={handleClick}
      onClose={handleClose}
      ref={ref}
      style={{ "--sidebar-width": SIDEBAR_WIDTH_MOBILE } as CSSProperties}
    >
      {/* first in the order: the focus lands on it when the panel opens */}
      <button
        className="touch-hit focus-ring absolute top-2 right-2 z-10 inline-flex size-ctl-sm items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent [&_svg]:size-3.5"
        onClick={requestClose}
        type="button"
      >
        <XIcon aria-hidden="true" />
        <span className="sr-only">Fechar</span>
      </button>
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">
        {children}
      </div>
    </dialog>
  );
}

function Sidebar({
  className,
  children,
  mobileTitle,
  side = "left",
  ...props
}: ComponentProps<"div"> & {
  /** The name of the Sheet below 760 px (read by a screen reader). */
  mobileTitle: string;
  side?: "left" | "right";
}) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    return (
      <MobileSheet
        onOpenChange={setOpenMobile}
        open={openMobile}
        side={side}
        title={mobileTitle}
      >
        {children}
      </MobileSheet>
    );
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-side={side}
      data-slot="sidebar"
    >
      {/* the gap the fixed column leaves in the flow */}
      <div className="relative w-(--sidebar-width)" data-slot="sidebar-gap" />
      <div
        className={cx(
          "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) border-sidebar-border data-[side=right]:right-0 data-[side=left]:left-0 data-[side=left]:border-r data-[side=right]:border-l md:flex",
          className
        )}
        data-side={side}
        data-slot="sidebar-container"
        {...props}
      >
        <div
          className="flex size-full flex-col bg-sidebar"
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarInset({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cx(
        "relative flex w-full min-w-0 flex-1 flex-col bg-background",
        className
      )}
      data-slot="sidebar-inset"
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cx("flex flex-col gap-2 p-2", className)}
      data-sidebar="header"
      data-slot="sidebar-header"
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cx("flex flex-col gap-2 p-2", className)}
      data-sidebar="footer"
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cx(
        "flex min-h-0 flex-1 flex-col gap-0 overflow-auto",
        className
      )}
      data-sidebar="content"
      data-slot="sidebar-content"
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cx("relative flex w-full min-w-0 flex-col p-2", className)}
      data-sidebar="group"
      data-slot="sidebar-group"
      {...props}
    />
  );
}

function SidebarGroupLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cx(
        "flex h-8 shrink-0 items-center rounded-md px-2 font-medium text-sidebar-foreground text-xs",
        className
      )}
      data-sidebar="group-label"
      data-slot="sidebar-group-label"
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cx("w-full text-sm", className)}
      data-sidebar="group-content"
      data-slot="sidebar-group-content"
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      className={cx("flex w-full min-w-0 flex-col gap-0", className)}
      data-sidebar="menu"
      data-slot="sidebar-menu"
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      className={cx("group/menu-item relative", className)}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      {...props}
    />
  );
}

/** A destination of the menu: a link (the shell has no other kind of item), marked with `data-active`. */
function SidebarMenuButton({
  className,
  isActive = false,
  ...props
}: ComponentProps<"a"> & { isActive?: boolean }) {
  return (
    <a
      className={cx(
        "peer/menu-button focus-ring flex h-8 touch:h-12 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm no-underline transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground [&>span:first-of-type]:truncate [&_svg]:size-4 [&_svg]:shrink-0",
        className
      )}
      data-active={isActive ? "" : undefined}
      data-sidebar="menu-button"
      data-slot="sidebar-menu-button"
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
};
