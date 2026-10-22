import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import BarChart3Icon from "lucide-react/dist/esm/icons/chart-column";
import ClockIcon from "lucide-react/dist/esm/icons/clock";
import CreditCardIcon from "lucide-react/dist/esm/icons/credit-card";
import EllipsisIcon from "lucide-react/dist/esm/icons/ellipsis";
import GlobeIcon from "lucide-react/dist/esm/icons/globe";
import LayoutGridIcon from "lucide-react/dist/esm/icons/layout-grid";
import PackageIcon from "lucide-react/dist/esm/icons/package";
import ReceiptTextIcon from "lucide-react/dist/esm/icons/receipt-text";
import ShoppingBagIcon from "lucide-react/dist/esm/icons/shopping-bag";
import SmartphoneIcon from "lucide-react/dist/esm/icons/smartphone";
import TagIcon from "lucide-react/dist/esm/icons/tag";
import UsersIcon from "lucide-react/dist/esm/icons/users";
import {
  type ChangeEvent,
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
} from "react";
import { Logo } from "@/ui/logo";
import {
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
} from "@/ui/sidebar";
import { ThemeSegmented } from "@/ui/theme-segmented";
import { ACCEPTANCE_OPENING_SCREEN } from "../legal/acceptance/acceptance-texts";
import {
  type CurrentOrganization,
  useOrganizationLoad,
} from "../lib/current-organization";
import {
  legalAcceptancePath,
  useLegalAcceptanceRequired,
} from "../lib/legal-acceptance";
import { currentReturnPath } from "../lib/sign-in-path";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { LogoutControl } from "../offline/runtime/logout-control";
import {
  OfflineAccessGate,
  useOfflineAccessExpired,
} from "../offline/runtime/offline-access-expired";
import {
  useOfflineRuntime,
  useRuntimeSnapshot,
} from "../offline/runtime/runtime-context";
import { useSessionOver } from "../offline/runtime/session-ended";
import { leaveSessionOver } from "../offline/runtime/session-over";
import { SyncStatus, SyncStatusMenuLine } from "../offline/runtime/sync-status";
import { OrganizationSetup } from "../organization/organization-setup";
import "./app-shell.css";
import { LegalAcceptanceNotice } from "./legal-acceptance-notice";
import {
  BOTTOM_BAR_IDS,
  inBottomBar,
  NAV_ITEMS,
  type NavId,
  navGroups,
  OFFLINE_NAV_ITEMS,
} from "./navigation-model";
import { SessionEndedNotice } from "./session-ended-notice";
import { useSignedInEmail } from "./signed-in-email";

/** The icon of each destination (lucide, one module each). */
const NAV_ICONS: Record<NavId, ComponentType<{ "aria-hidden"?: boolean }>> = {
  categories: LayoutGridIcon,
  customers: UsersIcon,
  dashboard: BarChart3Icon,
  devices: SmartphoneIcon,
  expenses: ReceiptTextIcon,
  history: ClockIcon,
  inventory: PackageIcon,
  "payment-profiles": CreditCardIcon,
  products: TagIcon,
  "public-catalog": GlobeIcon,
  sale: ShoppingBagIcon,
};

const menuItems = () => [
  ...NAV_ITEMS,
  ...(OFFLINE_RUNTIME_ENABLED ? OFFLINE_NAV_ITEMS : []),
];

/** One organization is shown as context; more than one can be switched. */
function OrganizationSwitcher({ current }: { current: CurrentOrganization }) {
  const { organization, organizations, select } = current;
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => select(event.target.value),
    [select]
  );

  if (organizations.length < 2) {
    return (
      <p className="m-0 truncate font-medium text-sm">
        <span className="sr-only">Organização: </span>
        <span>{organization.name}</span>
      </p>
    );
  }
  return (
    <div className="grid gap-1.5">
      <label className="text-xs" htmlFor="app-organization">
        Organização
      </label>
      <select
        className="focus-ring h-ctl-md w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm"
        id="app-organization"
        onChange={handleChange}
        value={organization.id}
      >
        {organizations.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </div>
  );
}

interface AppSidebarProps {
  navId: NavId | null;
  /** The screen works only with a connection: the state says so while offline (U-54). */
  onlineOnly: boolean;
  organization: CurrentOrganization | null;
}

/**
 * The sidebar of the desktop (the shadcn Sidebar) and, below 760 px, the same content in the "Mais" sheet without
 * the four destinations of the bottom bar. The current item has `aria-current="page"` and the emerald dot.
 */
function AppSidebar({ navId, onlineOnly, organization }: AppSidebarProps) {
  const { isMobile } = useSidebar();
  const email = useSignedInEmail();
  const items = menuItems().filter(
    (item) => !(isMobile && inBottomBar(item.id))
  );
  return (
    <Sidebar mobileTitle="Mais" side={isMobile ? "right" : "left"}>
      <SidebarHeader className="px-4 pt-4 pb-2">
        <a
          className="focus-ring flex w-fit items-center gap-2.5 rounded-sm font-semibold tracking-tight"
          href="/"
        >
          <Logo />
          Polaris
        </a>
        {isMobile ? <SyncStatusMenuLine onlineOnly={onlineOnly} /> : null}
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Principal">
          {navGroups(items).map((group) => (
            <SidebarGroup key={group.label ?? "inicio"}>
              {group.label ? (
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              ) : null}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const current = item.id === navId;
                    const Icon = NAV_ICONS[item.id];
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          aria-current={current ? "page" : undefined}
                          href={item.href}
                          isActive={current}
                        >
                          <Icon aria-hidden />
                          <span>{item.label}</span>
                          {current ? (
                            <span
                              aria-hidden="true"
                              className="ml-auto size-1.5 shrink-0 rounded-full bg-mark"
                            />
                          ) : null}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        {/* 12 px around and between, as in the design: the footer itself has 8 */}
        <div className="grid gap-3 p-1">
          <ThemeSegmented />
          {organization || email ? (
            <div className="grid min-w-0 gap-0.5">
              {organization ? (
                <OrganizationSwitcher current={organization} />
              ) : null}
              {email ? (
                <span className="truncate text-muted-foreground text-xs">
                  {email}
                </span>
              ) : null}
            </div>
          ) : null}
          <LogoutControl shell />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * The bar of destinations of the phone: Vender, Histórico, Estoque, Resultado and "Mais", which opens the rest
 * (the sidebar in a sheet). "Mais" carries the mark when the current screen is one of the rest.
 */
function BottomBar({ navId }: { navId: NavId | null }) {
  const { openMobile, setOpenMobile } = useSidebar();
  const openMore = useCallback(() => setOpenMobile(true), [setOpenMobile]);
  const moreCurrent = navId !== null && !inBottomBar(navId);
  const tab =
    "focus-ring relative grid min-h-13 min-w-0 content-center justify-items-center gap-0.5 px-0.5 pt-1 font-medium text-xs [&_svg]:size-[18px]";
  const mark = (
    <span
      aria-hidden="true"
      className="absolute inset-x-4 top-0 h-0.5 rounded-b bg-mark"
    />
  );
  return (
    <nav
      aria-label="Destinos"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      data-bottom-bar=""
      data-ui=""
    >
      {BOTTOM_BAR_IDS.map((id) => {
        const item = NAV_ITEMS.find((candidate) => candidate.id === id);
        if (!item) {
          return null;
        }
        const current = id === navId;
        const Icon = NAV_ICONS[id];
        return (
          <a
            aria-current={current ? "page" : undefined}
            className={`${tab} ${current ? "text-foreground" : "text-muted-foreground"}`}
            href={item.href}
            key={id}
          >
            {current ? mark : null}
            <Icon aria-hidden />
            <span className="max-w-full truncate">{item.label}</span>
          </a>
        );
      })}
      <button
        aria-expanded={openMobile}
        aria-haspopup="dialog"
        className={`${tab} cursor-pointer border-0 bg-transparent ${moreCurrent ? "text-foreground" : "text-muted-foreground"}`}
        onClick={openMore}
        type="button"
      >
        {moreCurrent ? mark : null}
        <EllipsisIcon aria-hidden />
        Mais
      </button>
    </nav>
  );
}

/** The top of the phone: the brand and the state chip with its short text, on one line (U-07); the theme is in "Mais". */
function MobileHeader({ onlineOnly }: { onlineOnly: boolean }) {
  return (
    <header
      className="sticky top-0 z-20 flex h-12 items-center justify-between gap-2 border-b bg-background/90 pr-2 pl-(--gutter) text-foreground backdrop-blur md:hidden"
      data-ui=""
    >
      <a
        className="focus-ring flex shrink-0 items-center gap-2 rounded-sm font-semibold tracking-tight"
        href="/"
      >
        <Logo className="size-5" />
        Polaris
      </a>
      <SyncStatus onlineOnly={onlineOnly} />
    </header>
  );
}

/** The chip in the top right corner of the content, on the desktop; the phone has it in its header. */
function ShellChip({ onlineOnly }: { onlineOnly: boolean }) {
  const { isMobile } = useSidebar();
  return isMobile ? (
    <MobileHeader onlineOnly={onlineOnly} />
  ) : (
    <div
      className="relative mx-auto hidden w-[min(100%-2rem,76rem)] md:block"
      data-ui=""
    >
      <div className="absolute top-4 right-0 flex">
        <SyncStatus onlineOnly={onlineOnly} />
      </div>
    </div>
  );
}

const OPENING_SIGN_IN_TEXT = "Sua sessão acabou. Abrindo a tela de entrada…";

/**
 * The session was refused. When it is the read that opens the app, nothing is on screen to protect
 * and the app goes to `/entrar?motivo=sessao&voltar=<this page>` by itself (AC-16), without showing
 * the protected screen with an error. Later (a refusal found while a screen is in use) it only says so.
 */
function SessionEndedGate({ atOpen }: { atOpen: boolean }) {
  const runtime = useOfflineRuntime();
  useEffect(() => {
    if (atOpen) {
      leaveSessionOver(runtime, currentReturnPath(window.location), {
        atOpen: true,
      });
    }
  }, [atOpen, runtime]);
  return atOpen ? (
    <p className="app-status" role="status">
      {OPENING_SIGN_IN_TEXT}
    </p>
  ) : (
    <SessionEndedNotice alone />
  );
}

/**
 * The legal acceptance is missing (ADR 0100). When it is the read that opens the app, nothing is on screen
 * to protect and the app goes to `/aceite?voltar=<this page>` by itself; later it only shows the notice.
 * Nothing local is dropped either way.
 */
function LegalAcceptanceGate({ atOpen }: { atOpen: boolean }) {
  useEffect(() => {
    if (atOpen) {
      // a plain navigation, not `leaveTo`: the session and the copies of this device stay
      window.location.assign(
        legalAcceptancePath(currentReturnPath(window.location))
      );
    }
  }, [atOpen]);
  return atOpen ? (
    <p className="app-status" role="status">
      {ACCEPTANCE_OPENING_SCREEN}
    </p>
  ) : (
    <LegalAcceptanceNotice />
  );
}

/** The two legal pages are linked from every screen of the app (AC-70); they open in another tab. */
function AppFooter() {
  const link =
    "touch-hit focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";
  return (
    <footer
      className="mx-auto w-[min(100%-2rem,76rem)] pt-4 pb-6 text-muted-foreground text-sm"
      data-ui=""
    >
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0">
        <li>
          <a
            className={link}
            href={LEGAL_PATHS.terms}
            rel="noopener noreferrer"
            target="_blank"
          >
            Termos de Uso
          </a>
        </li>
        <li>
          <a
            className={link}
            href={LEGAL_PATHS.privacy}
            rel="noopener noreferrer"
            target="_blank"
          >
            Política de Privacidade
          </a>
        </li>
      </ul>
    </footer>
  );
}

function OrganizationGate({ children }: { children: ReactNode }) {
  const { load, reload } = useOrganizationLoad();

  if (load.status === "loading") {
    return (
      <p className="app-status" role="status">
        Carregando sua organização…
      </p>
    );
  }
  if (load.status === "session_ended") {
    return <SessionEndedGate atOpen={load.atOpen} />;
  }
  if (load.status === "legal_acceptance_required") {
    return <LegalAcceptanceGate atOpen={load.atOpen} />;
  }
  if (load.status === "error") {
    return (
      <section aria-labelledby="app-gate-error" className="app-gate">
        <h1 id="app-gate-error">Não foi possível abrir o Polaris</h1>
        <p className="categories-message is-error" role="alert">
          {load.message}
        </p>
        <button className="primary-button" onClick={reload} type="button">
          Tentar novamente
        </button>
      </section>
    );
  }
  if (load.status === "empty") {
    return <OrganizationSetup onOpened={reload} />;
  }
  // Remounts the page when another organization is chosen, so no screen keeps
  // data of the previous one.
  return <div key={load.current.id}>{children}</div>;
}

interface AppShellProps {
  children: ReactNode;
  navId: NavId | null;
  /** The screen works only online (no copy on the device): the state chip says so while offline. */
  onlineOnly?: boolean;
  /** Pages that need data of an organization wait for it to be resolved. */
  requiresOrganization?: boolean;
}

/**
 * The single frame of every screen (v5.1): the sidebar from 760 px, the header and the bottom bar below it, the
 * state chip, the organization and the main landmark. Old screens keep their own CSS inside `main`; only the
 * frame is on the new interface (`data-ui` on each of its parts, never on `main`).
 */
export function AppShell({
  children,
  navId,
  onlineOnly = false,
  requiresOrganization = true,
}: AppShellProps) {
  const { load, select } = useOrganizationLoad();
  const sessionOver = useSessionOver();
  // the remembered organizations only draw the screen: with the offline access expired they are hidden, not deleted
  const accessExpired = useOfflineAccessExpired();
  const snapshot = useRuntimeSnapshot();
  const acceptanceMissing =
    useLegalAcceptanceRequired() ||
    (snapshot?.legalAcceptanceRequired ?? false);
  // the session notice comes first (there is nothing to accept without a session); the gate says it itself
  const showAcceptanceNotice =
    acceptanceMissing &&
    !sessionOver &&
    load.status !== "legal_acceptance_required";
  // the devices screen has its own panels for this (with the same button); the gate says it itself
  const showNotice =
    sessionOver && navId !== "devices" && load.status !== "session_ended";
  const organization: CurrentOrganization | null =
    load.status === "ready" && !accessExpired
      ? {
          organization: load.current,
          organizationId: load.current.id,
          organizations: load.organizations,
          select,
        }
      : null;
  return (
    <SidebarProvider className="ui-root app-shell-root bg-background">
      <a
        className="focus-ring not-focus:sr-only fixed top-2 left-2 z-50 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm no-underline"
        data-ui=""
        href="#conteudo"
      >
        Ir para o conteúdo
      </a>
      <AppSidebar
        navId={navId}
        onlineOnly={onlineOnly}
        organization={organization}
      />
      <SidebarInset className="pb-(--app-bottom-bar) md:pb-0">
        <ShellChip onlineOnly={onlineOnly} />
        <main className="categories-content" id="conteudo">
          {showNotice ? <SessionEndedNotice /> : null}
          {showAcceptanceNotice ? <LegalAcceptanceNotice /> : null}
          <OfflineAccessGate>
            {requiresOrganization ? (
              <OrganizationGate>{children}</OrganizationGate>
            ) : (
              children
            )}
          </OfflineAccessGate>
        </main>
        <AppFooter />
        <BottomBar navId={navId} />
      </SidebarInset>
    </SidebarProvider>
  );
}
