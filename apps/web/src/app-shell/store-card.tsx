import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import ArrowUpRightIcon from "lucide-react/dist/esm/icons/arrow-up-right";
import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import CircleHelpIcon from "lucide-react/dist/esm/icons/circle-help";
import LogOutIcon from "lucide-react/dist/esm/icons/log-out";
import { type RefObject, useCallback, useId } from "react";
import { parseTheme, THEMES, type Theme } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import type { CurrentOrganization } from "../lib/current-organization";
import type { Logout } from "../offline/runtime/logout-control";
import { useOfflineRuntime } from "../offline/runtime/runtime-context";
import {
  NEW_TAB_HINT,
  PRIVACY_LINK,
  TERMS_LINK,
} from "../sign-in/sign-in-texts";
import { HELP_HREF, HELP_LABEL } from "./navigation-model";
import { storeInitials } from "./store-initials";

const THEME_LABEL: Record<Theme, string> = {
  claro: "Claro",
  escuro: "Escuro",
  sistema: "Automático",
};

/** The name of the button: what the menu holds, without "Sair", which is there only with the runtime. */
const STORE_MENU_LABEL = "Loja, conta e ajuda";

function LegalItem({ href, label }: { href: string; label: string }) {
  return (
    <DropdownMenuLinkItem
      closeOnClick
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
      <span className="sr-only"> ({NEW_TAB_HINT})</span>
      <ArrowUpRightIcon
        aria-hidden="true"
        className="ml-auto text-muted-foreground"
      />
    </DropdownMenuLinkItem>
  );
}

/**
 * The menu of the store and of the account, at the right of the header: the initials of the store (and its name, from
 * 760 px) open the store and the e-mail in full, the other stores, the appearance, Ajuda e contato, the two legal pages
 * and, last and apart, "Sair". It opens in a portal under the button, so it never pushes the page; the answer of "Sair"
 * (the queue, a failure) is drawn by the shell under the header, because this menu closes on the click.
 */
export function StoreMenu({
  email,
  logout,
  organization,
  trigger,
}: {
  email: string | null;
  logout: Logout;
  organization: CurrentOrganization | null;
  /** The button, so the shell gives the focus back to it when the answer of "Sair" goes away. */
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const runtime = useOfflineRuntime();
  const [theme, choose] = useTheme();
  const identityId = useId();
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
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-busy={logout.busy || undefined}
        aria-describedby={identityId}
        aria-label={STORE_MENU_LABEL}
        className="touch-hit focus-ring flex h-10 min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent p-1 text-sidebar-foreground motion-full:transition-colors hover:bg-sidebar-hover md:max-w-72 md:shrink md:@max-[30rem]/header:shrink-0 md:@max-[30rem]/header:p-0 md:pr-2"
        data-store-menu=""
        ref={trigger}
      >
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground font-semibold text-background text-xs"
        >
          {storeInitials(name)}
        </span>
        <span
          aria-hidden="true"
          className="hidden min-w-0 truncate font-medium text-sidebar-accent-foreground text-sm md:block md:@max-[30rem]/header:hidden"
        >
          {name}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className="hidden size-4 shrink-0 md:block md:@max-[30rem]/header:hidden"
        />
        <span className="sr-only" id={identityId}>
          {organization && email ? `${name} · ${email}` : name}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(18rem,calc(100vw-1rem))]"
        side="bottom"
      >
        <div className="grid gap-0.5 px-2 pt-1.5 pb-2" data-store-identity="">
          <p className="m-0 font-medium text-sm [overflow-wrap:anywhere]">
            {name}
          </p>
          {organization && email ? (
            <p className="m-0 text-muted-foreground text-xs [overflow-wrap:anywhere]">
              {email}
            </p>
          ) : null}
        </div>
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
                    <span className="min-w-0 break-words">{store.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
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
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem closeOnClick href={HELP_HREF}>
          <CircleHelpIcon aria-hidden="true" />
          {HELP_LABEL}
        </DropdownMenuLinkItem>
        <LegalItem href={LEGAL_PATHS.terms} label={TERMS_LINK} />
        <LegalItem href={LEGAL_PATHS.privacy} label={PRIVACY_LINK} />
        {runtime ? (
          <>
            {/* last and apart from the rest, so it is not chosen by mistake */}
            <DropdownMenuSeparator className="my-1.5" />
            <DropdownMenuItem disabled={logout.busy} onClick={logout.start}>
              <LogOutIcon aria-hidden="true" />
              Sair
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
