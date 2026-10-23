"use client";

import XIcon from "lucide-react/dist/esm/icons/x";
import {
  type ComponentProps,
  type CSSProperties,
  createContext,
  type MouseEvent,
  type ReactNode,
  type RefObject,
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

/**
 * Below 760 px the sidebar is a modal panel on the native `<dialog>` (the shadcn Sidebar opens a Sheet there; the
 * native element gives the same: the page behind is inert, Escape closes, the focus stays inside, and it costs no
 * script of a primitive). Closing hands the focus back to what opened it. Only opacity moves (DESIGN.md).
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
  const { mobileTrigger } = useSidebar();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);
  const handleClose = useCallback(() => {
    onOpenChange(false);
    // the trigger, not the element focused before: Safari does not focus a button on a click
    mobileTrigger.current?.focus();
  }, [mobileTrigger, onOpenChange]);
  // a click on the veil (the dialog box itself, outside the panel) closes it
  const handleClick = useCallback((event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) {
      event.currentTarget.close();
    }
  }, []);
  const close = useCallback(() => ref.current?.close(), []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard closes it with Escape, which the native dialog handles
    <dialog
      aria-label={title}
      className="motion-safe:open:fade-in-0 fixed inset-y-0 m-0 h-dvh max-h-none w-(--sidebar-width) max-w-[85vw] border-0 bg-sidebar p-0 text-sidebar-foreground text-sm shadow-lg ring-1 ring-foreground/[0.06] backdrop:bg-overlay open:flex open:flex-col data-[side=right]:right-0 data-[side=left]:left-0 data-[side=right]:left-auto motion-safe:open:animate-in motion-safe:open:duration-[220ms]"
      data-mobile="true"
      data-side={side}
      data-sidebar="sidebar"
      data-slot="sidebar"
      data-ui=""
      onClick={handleClick}
      onClose={handleClose}
      ref={ref}
      style={{ "--sidebar-width": SIDEBAR_WIDTH_MOBILE } as CSSProperties}
    >
      {/* first in the order: the focus lands on it when the panel opens */}
      <button
        className="touch-hit focus-ring absolute top-2 right-2 z-10 inline-flex size-ctl-sm items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent [&_svg]:size-3.5"
        onClick={close}
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
      data-ui=""
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
