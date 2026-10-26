import EllipsisIcon from "lucide-react/dist/esm/icons/ellipsis";
import LogOutIcon from "lucide-react/dist/esm/icons/log-out";
import { useCallback, useEffect, useRef } from "react";
import { parseTheme, THEMES, type Theme } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import type { CurrentOrganization } from "../lib/current-organization";
import { type Logout, LogoutNotices } from "../offline/runtime/logout-control";
import { useOfflineRuntime } from "../offline/runtime/runtime-context";
import { storeInitials } from "./store-initials";

const THEME_LABEL: Record<Theme, string> = {
  claro: "Claro",
  escuro: "Escuro",
  sistema: "Automático",
};

/** The name of the button of the card's menu (v7 § 3 item 12): what the menu holds ("Sair" only with the runtime). */
const STORE_MENU_LABEL = "Loja, tema e Sair";
const STORE_MENU_LABEL_NO_LOGOUT = "Loja e tema";

/**
 * The card of the store at the foot of the desktop's sidebar (v7 § 3 item 12): the store and the e-mail, and the
 * button "⋯" ("Loja, tema e Sair") that opens the appearance, the other stores and, last and apart, "Sair". It shows with
 * the e-mail alone too (no store, or the read of the stores failed), so "Sair" is there in every state it was before.
 *
 * The protected logout (`useLogout`) lives in the sidebar, which outlives the card when the width crosses 760 px,
 * and its notices here, in the card, which is always on screen, and not in the menu, which closes on the click: the item only calls `start`, and the dialog of the pending queue or the
 * message of a failed sign-out appears under the card after the menu has closed (Rodrigo, 25/10, vale corrigir 1).
 * When the flow fails, or the dialog is dismissed, the focus goes back to the button of the menu.
 */
export function StoreCard({
  email,
  logout,
  organization,
}: {
  email: string | null;
  /** The protected logout of the sidebar, which keeps its state when the width crosses 760 px. */
  logout: Logout;
  organization: CurrentOrganization | null;
}) {
  const runtime = useOfflineRuntime();
  const [theme, choose] = useTheme();
  const trigger = useRef<HTMLButtonElement>(null);
  const { blocked, message } = logout;

  // a failure says itself (`role="alert"`) and the focus waits on the button that opened the menu; the dialog takes the
  // focus itself, and gives it back to the button when it goes away without leaving
  const hadDialog = useRef<boolean>(false);
  useEffect(() => {
    if (message !== null) {
      trigger.current?.focus();
    }
  }, [message]);
  useEffect(() => {
    if (blocked) {
      hadDialog.current = true;
    } else if (hadDialog.current) {
      hadDialog.current = false;
      trigger.current?.focus();
    }
  }, [blocked]);

  const chooseTheme = useCallback(
    (value: unknown) => choose(parseTheme(String(value))),
    [choose]
  );
  const select = organization?.select;
  const chooseStore = useCallback(
    (value: unknown) => {
      if (typeof value === "string") {
        select?.(value);
      }
    },
    [select]
  );

  const name = organization?.organization.name ?? email ?? "Sua conta";
  const stores = organization?.organizations ?? [];
  return (
    <div className="grid min-w-0 gap-2">
      <div
        className="flex min-w-0 items-center gap-2.5 rounded-xl bg-card p-2 ring-1 ring-foreground/[0.07]"
        data-store-card=""
      >
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground font-semibold text-background text-xs"
        >
          {storeInitials(name)}
        </span>
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate font-medium text-sm">
            {organization ? <span className="sr-only">Loja: </span> : null}
            {name}
          </span>
          {organization && email ? (
            <span className="truncate text-muted-foreground text-xs">
              {email}
            </span>
          ) : null}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            ref={trigger}
            render={
              <Button
                aria-busy={logout.busy || undefined}
                aria-label={
                  runtime ? STORE_MENU_LABEL : STORE_MENU_LABEL_NO_LOGOUT
                }
                className="shrink-0"
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <EllipsisIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56" side="top">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Aparência</DropdownMenuLabel>
              <DropdownMenuRadioGroup onValueChange={chooseTheme} value={theme}>
                {THEMES.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option}>
                    {THEME_LABEL[option]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            {organization && stores.length > 1 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Trocar de loja</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    onValueChange={chooseStore}
                    value={organization.organizationId}
                  >
                    {stores.map((store) => (
                      <DropdownMenuRadioItem key={store.id} value={store.id}>
                        <span className="min-w-0 break-words">
                          {store.name}
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </>
            ) : null}
            {runtime ? (
              <>
                {/* last and apart from the rest, so it is not chosen by mistake (Rodrigo, 25/10, menor 3) */}
                <DropdownMenuSeparator className="my-1.5" />
                <DropdownMenuItem disabled={logout.busy} onClick={logout.start}>
                  <LogOutIcon aria-hidden="true" />
                  Sair
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {runtime ? <LogoutNotices logout={logout} /> : null}
    </div>
  );
}
