import { type RefObject, useEffect, useRef } from "react";
import { HideValuesButton } from "@/ui/hidden-values";
import { Logo } from "@/ui/logo";
import type { CurrentOrganization } from "../lib/current-organization";
import { type Logout, LogoutNotices } from "../offline/runtime/logout-control";
import { useOfflineRuntime } from "../offline/runtime/runtime-context";
import { SyncStatus } from "../offline/runtime/sync-status";
import { StoreMenu } from "./store-card";

/**
 * The header of every screen of the shell: 48 px on the phone and 56 px from 760 px (`--app-header`, the one source of
 * its height), opaque in the color of the sidebar, so the two read as one frame. It carries what belongs to the
 * session and nothing that changes its height: the state chip (it shrinks to an ellipsis, the whole sentence in its
 * accessible name), "Esconder valores" (the choice is of the device and holds on every screen, so its button is
 * here, as an icon at every width) and the menu of the store and of the account (Ajuda e contato is in the sidebar). The title of the
 * screen stays the `h1` of the page, and the notices stay at the top of `main`.
 */
export function ShellHeader({
  email,
  logout,
  onlineOnly,
  organization,
  trigger,
}: {
  email: string | null;
  logout: Logout;
  onlineOnly: boolean;
  organization: CurrentOrganization | null;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header
      className="@container/header sticky top-0 z-20 h-(--app-header) shrink-0 bg-sidebar text-sidebar-foreground"
      data-app-header=""
    >
      {/* the header measures its own width: beside the open sidebar with a large text it is narrow, and then it keeps
          only the initials of the store and tighter room, so nothing passes its edge */}
      <div className="flex h-full items-center gap-2 pr-2 pl-(--gutter) md:@max-[30rem]/header:px-2 md:pr-4 md:pl-6">
        {/* from 760 px the brand is at the top of the sidebar, the corner of the frame */}
        <a
          className="touch-hit focus-ring flex shrink-0 items-center gap-2 rounded-sm font-semibold text-foreground tracking-tight md:hidden"
          href="/"
        >
          <Logo className="size-5" />
          {/* with a very large text the row has no room for the word beside the eye, the chip and the account: the
              mark stays and the name is still the link's, for the screen reader */}
          <span className="@max-[13rem]/header:sr-only">Polaris</span>
        </a>
        <div className="ml-auto flex min-w-0 items-center gap-2 md:@max-[30rem]/header:gap-1 md:gap-3">
          <SyncStatus onlineOnly={onlineOnly} />
          <HideValuesButton iconOnly />
          <StoreMenu
            email={email}
            logout={logout}
            organization={organization}
            trigger={trigger}
          />
        </div>
      </div>
    </header>
  );
}

/**
 * What "Sair" answers (the dialog of the work this device would lose, a failure, "Saindo…"), drawn under the header
 * over the page, never pushing it: the menu that holds "Sair" closes on the click. A failure is said (`role="alert"`)
 * and the focus waits on the button of the menu; the dialog takes the focus itself and gives it back to the button when
 * it goes away without leaving. Its effects run after the ones of the notices (it is their parent), so they win.
 */
export function ShellLogoutNotices({
  logout,
  trigger,
}: {
  logout: Logout;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const runtime = useOfflineRuntime();
  const { blocked, busy, message } = logout;
  useEffect(() => {
    if (message !== null) {
      trigger.current?.focus();
    }
  }, [message, trigger]);
  const hadDialog = useRef<boolean>(false);
  useEffect(() => {
    if (blocked) {
      hadDialog.current = true;
    } else if (hadDialog.current) {
      hadDialog.current = false;
      trigger.current?.focus();
    }
  }, [blocked, trigger]);
  if (!runtime) {
    return null;
  }
  const shown = busy || message !== null || blocked !== null;
  return (
    <div
      className={
        shown
          ? "fixed top-[calc(var(--app-header)+0.5rem)] right-2 left-2 z-30 grid max-h-[calc(100dvh-var(--app-header)-var(--app-bottom-bar,0rem)-1rem)] gap-2 overflow-y-auto p-1 md:left-auto md:w-[min(26rem,100%-2rem)] [&>p]:rounded-lg [&>p]:bg-popover [&>p]:p-3 [&>p]:shadow-md [&>p]:ring-1 [&>p]:ring-foreground/[0.06] [&_[data-slot=card]]:shadow-lg"
          : "contents"
      }
      data-logout-notices=""
    >
      <LogoutNotices logout={logout} />
    </div>
  );
}
