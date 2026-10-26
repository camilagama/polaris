import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import BarChart3Icon from "lucide-react/dist/esm/icons/chart-column";
import BadgeCheckIcon from "lucide-react/dist/esm/icons/badge-check";
import ClockIcon from "lucide-react/dist/esm/icons/clock";
import CreditCardIcon from "lucide-react/dist/esm/icons/credit-card";
import EllipsisIcon from "lucide-react/dist/esm/icons/ellipsis";
import GlobeIcon from "lucide-react/dist/esm/icons/globe";
import HouseIcon from "lucide-react/dist/esm/icons/house";
import LayoutGridIcon from "lucide-react/dist/esm/icons/layout-grid";
import PackageIcon from "lucide-react/dist/esm/icons/package";
import ReceiptTextIcon from "lucide-react/dist/esm/icons/receipt-text";
import ShoppingBagIcon from "lucide-react/dist/esm/icons/shopping-bag";
import SmartphoneIcon from "lucide-react/dist/esm/icons/smartphone";
import TagIcon from "lucide-react/dist/esm/icons/tag";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import UsersIcon from "lucide-react/dist/esm/icons/users";
import {
  type ComponentType,
  lazy,
  type MouseEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Logo } from "@/ui/logo";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
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
import { ConnectionRequiredSlot } from "./connection-required-notice";
import { canManageBilling } from "../lib/billing-access";
import { GraceNoticeSlot } from "./grace-notice";
import { LegalAcceptanceNotice } from "./legal-acceptance-notice";
import {
  BOTTOM_BAR_IDS,
  bottomBarMark,
  inBottomBar,
  menuItemsOf,
  NAV_ITEMS,
  type NavId,
  navGroups,
} from "./navigation-model";
import { PageLoading } from "./page-loading";
import { SessionEndedNotice } from "./session-ended-notice";
import { useSignedInEmail } from "./signed-in-email";
import { StatePanel } from "./state-panel";
import { StoreCard } from "./store-card";

/** The first access is its own chunk, kept by the service worker: only a person with no organization opens it. */
const OrganizationSetup = lazy(() =>
  import("../organization/organization-setup").then((module) => ({
    default: module.OrganizationSetup,
  }))
);

/** The icon of each destination (lucide, one module each). */
const NAV_ICONS: Record<NavId, ComponentType<{ "aria-hidden"?: boolean }>> = {
  attention: TriangleAlertIcon,
  categories: LayoutGridIcon,
  customers: UsersIcon,
  dashboard: BarChart3Icon,
  devices: SmartphoneIcon,
  expenses: ReceiptTextIcon,
  history: ClockIcon,
  home: HouseIcon,
  inventory: PackageIcon,
  "payment-profiles": CreditCardIcon,
  products: TagIcon,
  "public-catalog": GlobeIcon,
  sale: ShoppingBagIcon,
  subscription: BadgeCheckIcon,
};

/** One organization is shown as context; more than one can be switched. */
function OrganizationSwitcher({ current }: { current: CurrentOrganization }) {
  const { organization, organizations, select } = current;
  const handleChange = useCallback(
    (id: string | null) => {
      if (id !== null) {
        select(id);
      }
    },
    [select]
  );
  const items = organizations.map((item) => ({
    label: item.name,
    value: item.id,
  }));
  // The "Mais" sheet of the phone is a modal <dialog> (top layer): a menu portaled to <body> would open behind it,
  // so the menu goes inside that dialog. On the desktop there is none and the menu goes to <body>.
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const findDialog = useCallback((node: HTMLElement | null) => {
    setDialog(node?.closest("dialog") ?? null);
  }, []);

  // A native label would press the trigger and open the menu; "Loja" only takes the focus there, like the label of a field.
  const trigger = useRef<HTMLButtonElement>(null);
  const focusTrigger = useCallback((event: MouseEvent<HTMLLabelElement>) => {
    event.preventDefault();
    trigger.current?.focus();
  }, []);

  if (organizations.length < 2) {
    return (
      <p className="m-0 truncate font-medium text-sm">
        <span className="sr-only">Loja: </span>
        <span>{organization.name}</span>
      </p>
    );
  }
  return (
    <div className="grid gap-1.5" ref={findDialog}>
      <Label
        className="font-normal text-xs"
        htmlFor="app-organization"
        id="app-organization-label"
        onClick={focusTrigger}
      >
        Loja
      </Label>
      <Select
        items={items}
        onValueChange={handleChange}
        value={organization.id}
      >
        <SelectTrigger
          aria-labelledby="app-organization-label"
          className="w-full min-w-0 data-[size=default]:touch:h-12"
          id="app-organization"
          ref={trigger}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent {...(dialog ? { container: dialog } : {})}>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} wrap>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  const { isMobile, setOpenMobile } = useSidebar();
  // the answer of "Sair" may come after "Mais" was closed: open it again to show the warning
  const showLogoutAttention = useCallback(() => {
    if (isMobile) {
      setOpenMobile(true);
    }
  }, [isMobile, setOpenMobile]);
  const email = useSignedInEmail();
  const items = menuItemsOf({
    offline: OFFLINE_RUNTIME_ENABLED,
    // the plan only for whom may manage it (ADR 0104): the server refuses the others anyway
    subscription:
      organization !== null &&
      canManageBilling(
        organization.billingSelfService,
        organization.organization.role
      ),
  }).filter((item) => !(isMobile && inBottomBar(item.id)));
  return (
    <Sidebar mobileTitle="Mais" side={isMobile ? "right" : "left"}>
      <SidebarHeader className="px-4 pt-4 pb-2">
        <a
          className="touch-hit focus-ring flex w-fit items-center gap-2.5 rounded-sm font-semibold tracking-tight"
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
        {isMobile ? (
          // the phone keeps "Sair" straight in "Mais", with the theme (Rodrigo, 25/10, vale corrigir 2)
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
            <LogoutControl onAttention={showLogoutAttention} />
          </div>
        ) : (
          // the desktop: the card of the store, with the theme, the other stores and "Sair" in its menu (v7 § 3 item 12)
          <div className="grid gap-3 p-1">
            <StoreCard email={email} organization={organization} />
            {/* with touch, the 48 px areas of the menu button and of the links would meet: 12 px more between them */}
            <LegalLinks className="touch:mt-3 gap-x-4 gap-y-1 text-muted-foreground text-xs" />
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * The bar of destinations of the phone: Início, Histórico, Vender (a pill of ink, in the middle), Estoque and "Mais",
 * which opens the rest (the sidebar in a sheet). A destination carries the mark on its own screen (`aria-current="page"`) and on the
 * screens of its area (`aria-current="true"`): Estoque on Produtos, Categorias and Clientes. "Mais" carries it on
 * the screens of no destination of the bar (Resultado, Despesas, Pendências...), and the number of operations of
 * this device that need attention on its icon (the chip says the same in words, so the number is only drawn).
 */
function BottomBar({ navId }: { navId: NavId | null }) {
  const { mobileTrigger, openMobile, setOpenMobile } = useSidebar();
  const rejected = useRuntimeSnapshot()?.counts.rejected ?? 0;
  const openMore = useCallback(() => setOpenMobile(true), [setOpenMobile]);
  const marked = navId === null ? null : bottomBarMark(navId);
  const moreCurrent = marked === "more";
  const tab =
    "focus-ring relative grid min-h-13 min-w-0 content-center justify-items-center gap-0.5 px-0.5 pt-1 font-medium text-xs [&_svg]:size-[18px]";
  const mark = (
    <span
      aria-hidden="true"
      className="absolute inset-x-4 top-0 h-0.5 rounded-b bg-mark"
      data-bottom-mark=""
    />
  );
  return (
    <nav
      aria-label="Destinos"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      data-bottom-bar=""
    >
      {BOTTOM_BAR_IDS.map((id) => {
        const item = NAV_ITEMS.find((candidate) => candidate.id === id);
        if (!item) {
          return null;
        }
        const current = id === marked;
        const Icon = NAV_ICONS[id];
        let ariaCurrent: "page" | "true" | undefined;
        if (current) {
          ariaCurrent = id === navId ? "page" : "true";
        }
        if (id === "sale") {
          // Vender, in the middle: a pill of ink around its icon, the one action of the bar (v7 § 3 item 12)
          return (
            <a
              aria-current={ariaCurrent}
              className={`${tab} text-foreground`}
              data-bottom-sell=""
              href={item.href}
              key={id}
            >
              {current ? mark : null}
              <span className="grid h-8 w-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-xs">
                <Icon aria-hidden />
              </span>
              <span className="max-w-full truncate font-semibold">
                {item.label}
              </span>
            </a>
          );
        }
        return (
          <a
            aria-current={ariaCurrent}
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
        ref={mobileTrigger}
        type="button"
      >
        {moreCurrent ? mark : null}
        <span className="relative">
          <EllipsisIcon aria-hidden />
          {rejected > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -top-1.5 left-3 min-w-4 rounded-full bg-warning px-1 text-center font-semibold text-[10px] text-warning-foreground tabular-nums leading-4"
              data-attention-count=""
            >
              {rejected > 99 ? "99+" : rejected}
            </span>
          ) : null}
        </span>
        Mais
      </button>
    </nav>
  );
}

/** The top of the phone: the brand and the state chip with its short text, on one line (U-07); the theme is in "Mais". */
function MobileHeader({ onlineOnly }: { onlineOnly: boolean }) {
  return (
    <header className="sticky top-0 z-20 flex h-12 items-center justify-between gap-2 border-b bg-background/90 pr-2 pl-(--gutter) text-foreground backdrop-blur md:hidden">
      <a
        className="touch-hit focus-ring flex shrink-0 items-center gap-2 rounded-sm font-semibold tracking-tight"
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
    <div className="relative mx-auto hidden w-[min(100%-2rem,76rem)] md:block">
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
    <PageLoading label={OPENING_SIGN_IN_TEXT} />
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
    <PageLoading label={ACCEPTANCE_OPENING_SCREEN} />
  ) : (
    <LegalAcceptanceNotice />
  );
}

/** The two legal pages, linked from every screen of the app (AC-70); they open in another tab. */
function LegalLinks({ className }: { className: string }) {
  const link =
    "touch-hit focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";
  return (
    <ul className={`m-0 flex list-none flex-wrap p-0 ${className}`}>
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
  );
}

/**
 * The legal links under the content, on the phone only: from 760 px they are at the foot of the sidebar
 * (`AppSidebar`), once.
 */
function AppFooter() {
  return (
    <footer className="mx-auto w-[min(100%-2rem,76rem)] pt-4 pb-6 text-muted-foreground text-sm md:hidden">
      <LegalLinks className="gap-x-5 gap-y-2" />
    </footer>
  );
}

function OrganizationGate({ children }: { children: ReactNode }) {
  const { load, reload } = useOrganizationLoad();

  if (load.status === "loading") {
    return <PageLoading label="Carregando sua loja…" />;
  }
  if (load.status === "session_ended") {
    return <SessionEndedGate atOpen={load.atOpen} />;
  }
  if (load.status === "legal_acceptance_required") {
    return <LegalAcceptanceGate atOpen={load.atOpen} />;
  }
  if (load.status === "error") {
    return (
      <StatePanel
        actions={
          <Button onClick={reload} type="button">
            Tentar novamente
          </Button>
        }
        icon={
          <TriangleAlertIcon
            aria-hidden="true"
            className="size-5 shrink-0 text-destructive"
          />
        }
        title="Não foi possível abrir o Polaris"
        titleId="app-gate-error"
      >
        <p className="text-muted-foreground" role="alert">
          {load.message}
        </p>
      </StatePanel>
    );
  }
  if (load.status === "empty") {
    // `AppShell` shows the first access on a page of its own, with no menu: this is only for the types
    return null;
  }
  // Remounts the page when another organization is chosen, so no screen keeps
  // data of the previous one.
  return <div key={load.current.id}>{children}</div>;
}

/** The notices at the top of `main`: the session that ended, the acceptance that is missing, the connection. */
function ShellNotices({
  acceptance,
  connection,
  session,
}: {
  acceptance: boolean;
  /** An online-only screen: the notice shows by itself while the tab does not reach the Worker. */
  connection: { form: boolean } | null;
  session: boolean;
}) {
  return (
    <>
      {session ? <SessionEndedNotice /> : null}
      {acceptance ? <LegalAcceptanceNotice /> : null}
      {connection ? <ConnectionRequiredSlot form={connection.form} /> : null}
    </>
  );
}

interface AppShellProps {
  children: ReactNode;
  /** An online-only screen with a form: offline, the notice says the typed text stays. */
  connectionForm?: boolean;
  navId: NavId | null;
  /** The screen works only online (no copy on the device): the state chip says so while offline. */
  onlineOnly?: boolean;
  /** Pages that need data of an organization wait for it to be resolved. */
  requiresOrganization?: boolean;
  /** The new-version notice (ADR 0041), at the top of the content, beside the sidebar and never under it. */
  updateNotice?: ReactNode;
}

/**
 * The single frame of every screen (v5.1): the sidebar from 760 px, the header and the bottom bar below it, the
 * state chip, the organization and the main landmark.
 */
export function AppShell({
  children,
  connectionForm = true,
  navId,
  onlineOnly = false,
  requiresOrganization = true,
  updateNotice,
}: AppShellProps) {
  const { billingSelfService, load, reload, select } = useOrganizationLoad();
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
          billingSelfService,
          organization: load.current,
          organizationId: load.current.id,
          organizations: load.organizations,
          select,
        }
      : null;
  // the first access (no organization yet) has no menu, no bar and no chip: nothing to go to, so a page of its own
  if (requiresOrganization && load.status === "empty" && !accessExpired) {
    return (
      <>
        {updateNotice}
        {showNotice || showAcceptanceNotice ? (
          // the notices of the shell stay above the card: the session that ended and the acceptance that is missing
          <div className="flow-root bg-background px-(--gutter) pt-4">
            <div className="mx-auto max-w-[420px]">
              {showNotice ? <SessionEndedNotice alone /> : null}
              {showAcceptanceNotice ? <LegalAcceptanceNotice /> : null}
            </div>
          </div>
        ) : null}
        <Suspense fallback={<PageLoading fullPage />}>
          <OrganizationSetup onOpened={reload} />
        </Suspense>
      </>
    );
  }
  return (
    <SidebarProvider className="app-shell-root bg-background">
      <a
        className="focus-ring not-focus:sr-only fixed top-2 left-2 z-50 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm no-underline"
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
        <main
          className="mx-auto w-[min(100%_-_2rem,76rem)] pt-[clamp(2rem,5vw,4.25rem)] pb-14"
          id="conteudo"
        >
          {updateNotice}
          <ShellNotices
            acceptance={showAcceptanceNotice}
            connection={
              onlineOnly && !sessionOver ? { form: connectionForm } : null
            }
            session={showNotice}
          />
          <GraceNoticeSlot
            hidden={sessionOver}
            onSubscription={navId === "subscription"}
            organization={organization}
          />
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
