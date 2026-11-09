import { saoPauloDateOf } from "@polaris/domain/billing/provider-period";
import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import BarChart3Icon from "lucide-react/dist/esm/icons/chart-column";
import WalletIcon from "lucide-react/dist/esm/icons/wallet";
import CircleHelpIcon from "lucide-react/dist/esm/icons/circle-help";
import ClockIcon from "lucide-react/dist/esm/icons/clock";
import EllipsisIcon from "lucide-react/dist/esm/icons/ellipsis";
import HouseIcon from "lucide-react/dist/esm/icons/house";
import PackageIcon from "lucide-react/dist/esm/icons/package";
import SettingsIcon from "lucide-react/dist/esm/icons/settings";
import ShoppingBagIcon from "lucide-react/dist/esm/icons/shopping-bag";
import TagIcon from "lucide-react/dist/esm/icons/tag";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import UsersIcon from "lucide-react/dist/esm/icons/users";
import {
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { Button } from "@/ui/button";
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
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/ui/sidebar";
import { MediaThumbnailScope } from "../catalog/media-thumbnail-scope";
import { ACCEPTANCE_OPENING_SCREEN } from "../legal/acceptance/acceptance-texts";
import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import { canManageBilling } from "../lib/billing-access";
import { useConnectionOnline } from "../lib/browser-connection";
import {
  type CurrentOrganization,
  useOrganizationLoad,
} from "../lib/current-organization";
import type { OrganizationLoad } from "../lib/current-organization-model";
import {
  legalAcceptancePath,
  useLegalAcceptanceRequired,
} from "../lib/legal-acceptance";
import { currentReturnPath } from "../lib/sign-in-path";
import { useNow } from "../lib/use-now";
import { useLogout } from "../offline/runtime/logout-control";
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
import { SyncStatusMenuLine } from "../offline/runtime/sync-status";
import { ClosedStoreNotice, useClosedStoreHere } from "./closed-store-notice";
import { ConnectionRequiredSlot } from "./connection-required-notice";
import { FirstAccess } from "./first-access";
import { trialChargeDay } from "../subscription/plan-notice";
import { GraceNoticeSlot, usePlanNoticeFacts } from "./grace-notice";
import { LegalAcceptanceNotice } from "./legal-acceptance-notice";
import { MenuProgress, useFirstSteps } from "./menu-progress";
import {
  BOTTOM_BAR_IDS,
  bottomBarMark,
  HELP_HREF,
  HELP_LABEL,
  inBottomBar,
  menuItemsOf,
  NAV_ITEMS,
  type NavId,
  type NavItem,
  navGroups,
  type RouteId,
} from "./navigation-model";
import { PageLoading } from "./page-loading";
import { SessionEndedNotice } from "./session-ended-notice";
import { ShellHeader, ShellLogoutNotices } from "./shell-header";
import { useSignedInEmail } from "./signed-in-email";
import { StatePanel } from "./state-panel";

/** The first access is its own chunk, kept by the service worker: only a person with no organization opens it. */
const OrganizationSetup = lazy(() =>
  import("../organization/organization-setup").then((module) => ({
    default: module.OrganizationSetup,
  }))
);

/** The icon of each destination (lucide, one module each). */
const NAV_ICONS: Record<NavId, ComponentType<{ "aria-hidden"?: boolean }>> = {
  attention: TriangleAlertIcon,
  customers: UsersIcon,
  dashboard: BarChart3Icon,
  expenses: WalletIcon,
  history: ClockIcon,
  help: CircleHelpIcon,
  home: HouseIcon,
  inventory: PackageIcon,
  products: TagIcon,
  sale: ShoppingBagIcon,
  settings: SettingsIcon,
};

/** The count of Pendências, drawn: 99 at most. */
function countText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** How a screen reader hears the count beside "Pendências" (the badge is only drawn). */
function attentionCountText(count: number): string {
  return count === 1 ? "1 registro recusado" : `${count} registros recusados`;
}

/** "Ajuda e contato" in "Mais", after the destinations: on the desktop it is the "?" of the header. */
const HELP_ITEM: NavItem = {
  group: null,
  href: HELP_HREF,
  id: "help",
  label: HELP_LABEL,
};

/** A destination of the menu: the current one has `aria-current="page"` and the emerald dot, Pendências its count. */
function NavLink({
  count,
  current,
  item,
}: {
  count: number;
  current: boolean;
  item: NavItem;
}) {
  const Icon = NAV_ICONS[item.id];
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-current={current ? "page" : undefined}
        // the count is only drawn: its name says it in words, after the visible name
        aria-label={
          count > 0 ? `${item.label}, ${attentionCountText(count)}` : undefined
        }
        href={item.href}
        isActive={current}
        tooltip={item.label}
      >
        <Icon aria-hidden />
        {/* folded, the name is still the name of the link: hidden only to the eye */}
        <span className="group-data-[collapsible=icon]:sr-only">
          {item.label}
        </span>
        {count > 0 ? (
          <span
            aria-hidden="true"
            className="ml-auto min-w-5 shrink-0 rounded-full bg-warning px-1.5 text-center font-semibold text-warning-foreground text-xs tabular-nums leading-5 group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:top-0.5 group-data-[collapsible=icon]:right-0.5 group-data-[collapsible=icon]:size-2 group-data-[collapsible=icon]:min-w-0 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:text-[0px]"
            data-attention-count=""
          >
            {countText(count)}
          </span>
        ) : null}
        {current && count === 0 ? (
          <span
            aria-hidden="true"
            className="ml-auto size-1.5 shrink-0 rounded-full bg-mark group-data-[collapsible=icon]:hidden"
          />
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** The two legal pages at the foot of "Mais", small: they open in another tab, so nothing open in the app is lost. */
function SheetLegalLinks() {
  const link =
    "touch-hit focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";
  return (
    <ul
      className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 px-2 py-1 text-muted-foreground text-xs"
      data-sheet-legal=""
    >
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

interface AppSidebarProps {
  /** Despesas is offered to who can register an expense (`expense:create`); while the store is not known it stays, so the list does not move. */
  expenses: boolean;
  /** "dd/mm" of the first charge of the trial, for the foot of the menu. */
  chargeDay: string | null;
  /** The first steps done, for the foot of the menu; null once the store sold or while not known. */
  firstSteps: number | null;
  navId: NavId | null;
  /** The screen works only with a connection: the state says so while offline (U-54). */
  onlineOnly: boolean;
}

/**
 * The sidebar of the desktop (the shadcn Sidebar) and, below 760 px, the same content in the "Mais" sheet without
 * the four destinations of the bottom bar: only navigation, and at its foot the first steps and the trial. The store,
 * the theme and "Sair" are in the menu of the header; the sheet adds "Ajuda e contato" and the two legal pages, which
 * the desktop has in the header. Pendências is there only while this device has a refused record, with the count
 * (map of navigation, § 1).
 */
function AppSidebar({
  chargeDay,
  expenses,
  firstSteps,
  navId,
  onlineOnly,
}: AppSidebarProps) {
  const { isMobile } = useSidebar();
  const rejected = useRuntimeSnapshot()?.counts.rejected ?? 0;
  // on the phone "Ajuda e contato" closes the list, in the group of Configurações
  const items = [
    ...menuItemsOf({ attention: rejected > 0, expenses }).filter(
      (item) => !(isMobile && inBottomBar(item.id))
    ),
    ...(isMobile ? [HELP_ITEM] : []),
  ];
  return (
    <Sidebar mobileTitle="Mais" side={isMobile ? "right" : "left"}>
      <SidebarHeader className="px-4 pt-2 pb-2 group-data-[collapsible=icon]:px-2">
        <div className="flex min-h-10 items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center">
          <a
            className="touch-hit focus-ring flex w-fit items-center gap-2.5 rounded-sm font-semibold tracking-tight"
            href="/"
          >
            <Logo />
            <span className="group-data-[collapsible=icon]:sr-only">
              Polaris
            </span>
          </a>
          {/* the column folds only from 1024 px: below, the button is not there */}
          <SidebarTrigger />
        </div>
        {isMobile ? <SyncStatusMenuLine onlineOnly={onlineOnly} /> : null}
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Principal">
          {navGroups(items).map((group) => (
            <SidebarGroup key={group.label ?? group.items[0]?.id}>
              {group.label ? (
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              ) : null}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <NavLink
                      count={item.id === "attention" ? rejected : 0}
                      current={item.id === navId}
                      item={item}
                      key={item.id}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        {/* 12 px around and between, as in the design: the footer itself has 8 */}
        <div className="grid gap-3 p-1 group-data-[collapsible=icon]:p-0">
          <MenuProgress chargeDay={chargeDay} firstSteps={firstSteps} />
          {isMobile ? <SheetLegalLinks /> : null}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/* 4.4 em is the width of "Histórico", 0.25 rem of slack. Below the 0.6875 rem floor the label breaks in two
   lines (`--app-bottom-bar` grows) instead of being cut. `overflow-wrap: anywhere` alone breaks it where the letters
   run out ("Históric" and "o", "Estoqu" and "e"), so the label offers its own syllable break (`<wbr>`, which adds
   nothing to the text). Chromium's accessibility tree still reads the two halves as two words ("Histó rico"), so each
   link carries the whole word in `aria-label` and the split text is hidden from the tree. */
const BOTTOM_BAR_LABEL =
  "max-w-full text-center [font-size:clamp(0.6875rem,calc((100cqw-0.25rem)/4.4),0.75rem)] [overflow-wrap:anywhere] @max-[3.275rem]/tab:tracking-[-0.01em]";

const SYLLABLE_BREAKS: Readonly<Record<string, readonly [string, string]>> = {
  Estoque: ["Esto", "que"],
  Histórico: ["Histó", "rico"],
};

function BottomBarLabel({ text }: { text: string }) {
  const parts = SYLLABLE_BREAKS[text];
  return parts ? (
    <>
      {parts[0]}
      <wbr />
      {parts[1]}
    </>
  ) : (
    text
  );
}

/**
 * The bar of destinations of the phone: Início, Histórico, Vender (a pill of ink, in the middle), Estoque and "Mais",
 * which opens the rest (the sidebar in a sheet). A destination carries the mark on its own screen (`aria-current="page"`) and on the
 * screens of its area (`aria-current="true"`): Estoque on Produtos and Clientes. "Mais" carries it on the screens of
 * no destination of the bar (Pendências, Resultado, Despesas, Configurações with their tabs, and Ajuda e contato), and the number of operations of
 * this device that need attention on its icon (the chip says the same in words, so the number is only drawn).
 */
function BottomBar({ navId }: { navId: NavId | null }) {
  const { mobileTrigger, openMobile, setOpenMobile } = useSidebar();
  const rejected = useRuntimeSnapshot()?.counts.rejected ?? 0;
  const openMore = useCallback(() => setOpenMobile(true), [setOpenMobile]);
  const marked = navId === null ? null : bottomBarMark(navId);
  const moreCurrent = marked === "more";
  const tab =
    "@container/tab focus-ring relative grid min-h-13 min-w-0 content-center justify-items-center gap-0.5 px-0.5 pt-1 font-medium text-xs [&_svg]:size-[18px]";
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
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden"
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
              aria-label={item.label}
              className={`${tab} text-foreground`}
              data-bottom-sell=""
              href={item.href}
              key={id}
            >
              {current ? mark : null}
              <span className="grid h-8 w-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-xs">
                <Icon aria-hidden />
              </span>
              <span
                aria-hidden="true"
                className={`${BOTTOM_BAR_LABEL} font-semibold`}
              >
                <BottomBarLabel text={item.label} />
              </span>
            </a>
          );
        }
        return (
          <a
            aria-current={ariaCurrent}
            aria-label={item.label}
            className={`${tab} ${current ? "text-foreground" : "text-muted-foreground"}`}
            href={item.href}
            key={id}
          >
            {current ? mark : null}
            <Icon aria-hidden />
            <span aria-hidden="true" className={BOTTOM_BAR_LABEL}>
              <BottomBarLabel text={item.label} />
            </span>
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
              className="absolute -top-1.5 left-3 min-w-4 rounded-full bg-warning px-1 text-center font-semibold text-[0.625rem] text-warning-foreground tabular-nums leading-4"
              data-attention-count=""
            >
              {countText(rejected)}
            </span>
          ) : null}
        </span>
        <span className={BOTTOM_BAR_LABEL}>Mais</span>
      </button>
    </nav>
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
            className="size-4 shrink-0 text-destructive"
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
  return (
    <div key={load.current.id}>
      <MediaThumbnailScope organizationId={load.current.id}>
        {children}
      </MediaThumbnailScope>
    </div>
  );
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

/**
 * What the shell shows of the plan and of the first steps. The plan is read once for the notice of grace and the trial
 * at the foot of the menu, only for whom manages the billing; nothing of either once the session is over.
 */
function useShellProgress(
  current: CurrentOrganization | null,
  sessionOver: boolean,
  routeId: RouteId | undefined
) {
  const organization = sessionOver ? null : current;
  const online = useConnectionOnline();
  const now = useNow(60_000);
  const planFacts = usePlanNoticeFacts(
    organization?.organizationId ?? "",
    organization !== null &&
      canManageBilling(
        organization.billingSelfService,
        organization.organization.role
      ),
    routeId !== "subscription"
  );
  return {
    // the Assinatura shows nothing of the plan offline (AS-8): the foot of its menu neither
    chargeDay:
      planFacts === null || (routeId === "subscription" && !online)
        ? null
        : trialChargeDay(planFacts, saoPauloDateOf(now)),
    firstSteps: useFirstSteps(organization?.organizationId ?? null),
    planFacts,
  };
}

/**
 * The store this page worked in was closed: its notice takes the place of the page (and of the first access, once the
 * organizations are read again without it), so nothing sends the person to the sign-in screen or round again.
 */
function useClosedNotice(load: OrganizationLoad): ReactNode {
  const currentId = load.status === "ready" ? load.current.id : null;
  const closedHere = useClosedStoreHere(currentId);
  if (closedHere === null) {
    return null;
  }
  return <ClosedStoreNotice key={closedHere} organizationId={closedHere} />;
}

function FirstAccessPage({
  acceptanceNotice,
  closedNotice,
  onOpened,
  sessionNotice,
}: {
  acceptanceNotice: boolean;
  closedNotice: ReactNode;
  onOpened: () => void;
  sessionNotice: boolean;
}) {
  if (closedNotice) {
    return (
      <div className="flow-root min-h-dvh bg-background px-(--gutter) pt-4">
        <main className="mx-auto max-w-[26.25rem]" id="conteudo">
          {closedNotice}
        </main>
      </div>
    );
  }
  return (
    <>
      {sessionNotice || acceptanceNotice ? (
        <div className="flow-root bg-background px-(--gutter) pt-4">
          <div className="mx-auto max-w-[26.25rem]">
            {sessionNotice ? <SessionEndedNotice alone /> : null}
            {acceptanceNotice ? <LegalAcceptanceNotice /> : null}
          </div>
        </div>
      ) : null}
      <FirstAccess>
        <Suspense fallback={<PageLoading fullPage />}>
          <OrganizationSetup onOpened={onOpened} />
        </Suspense>
      </FirstAccess>
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
  /** The screen, or the tab of a screen, on screen; none on the 404. */
  routeId?: RouteId;
  /** Pages that need data of an organization wait for it to be resolved. */
  requiresOrganization?: boolean;
}

/**
 * The single frame of every screen: the sidebar from 760 px (the bottom bar and "Mais" below it), the header with the
 * state chip and the menu of the store and of the account, and the panel of the content with the main landmark.
 */
export function AppShell({
  children,
  connectionForm = true,
  navId,
  onlineOnly = false,
  requiresOrganization = true,
  routeId,
}: AppShellProps) {
  const { billingSelfService, load, reload, select } = useOrganizationLoad();
  const sessionOver = useSessionOver();
  // the remembered organizations only draw the screen: with the offline access expired they are hidden, not deleted
  const accessExpired = useOfflineAccessExpired();
  const snapshot = useRuntimeSnapshot();
  const acceptanceMissing =
    useLegalAcceptanceRequired() ||
    (snapshot?.legalAcceptanceRequired ?? false);
  // the session notice comes first (there is nothing to accept without a session); the gate says it itself, and a page
  // with no gate (Ajuda, the 404) needs the notice
  const showAcceptanceNotice =
    acceptanceMissing &&
    !sessionOver &&
    (!requiresOrganization || load.status !== "legal_acceptance_required");
  // the devices screen has its own panels for this (with the same button); the gate says it itself
  const showNotice =
    sessionOver &&
    routeId !== "devices" &&
    (!requiresOrganization || load.status !== "session_ended");
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
  const { chargeDay, firstSteps, planFacts } = useShellProgress(
    organization,
    sessionOver,
    routeId
  );
  const closedNotice = useClosedNotice(load);
  // "Sair" lives in the header for every width: its state is here, above the header and the notices it draws
  const logout = useLogout("/");
  const email = useSignedInEmail();
  const storeMenu = useRef<HTMLButtonElement>(null);
  // the first access (no organization yet) has no menu, no bar and no chip: nothing to go to, so a page of its own
  if (requiresOrganization && load.status === "empty" && !accessExpired) {
    return (
      <FirstAccessPage
        acceptanceNotice={showAcceptanceNotice}
        closedNotice={closedNotice}
        onOpened={reload}
        sessionNotice={showNotice}
      />
    );
  }
  return (
    <SidebarProvider className="app-shell-root bg-sidebar">
      <a
        className="focus-ring not-focus:sr-only fixed top-2 left-2 z-50 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm no-underline"
        href="#conteudo"
      >
        Ir para o conteúdo
      </a>
      <AppSidebar
        chargeDay={chargeDay}
        expenses={
          organization === null ||
          hasCapabilityForRole(organization.organization.role, "expense:create")
        }
        firstSteps={firstSteps}
        navId={navId}
        onlineOnly={onlineOnly}
      />
      <SidebarInset className="pb-(--app-bottom-bar) md:pb-0">
        <ShellHeader
          email={email}
          helpCurrent={navId === "help"}
          logout={logout}
          onlineOnly={onlineOnly}
          organization={organization}
          trigger={storeMenu}
        />
        {/* the panel of the content, in the frame of the sidebar and the header: from 760 px its top left corner is
            rounded, with the 1 px ring of a card on the two edges it shares with the frame */}
        <div
          className="flex flex-1 flex-col bg-background md:rounded-tl-xl md:border-(--card-ring) md:border-t md:border-l"
          data-app-panel=""
        >
          {/* on the phone the content fills the window between the header and the bottom bar, so a short page does
              not scroll */}
          <main
            className="mx-auto w-[min(100%_-_2rem,76rem)] pt-[clamp(2rem,5vw,4.25rem)] pb-14 max-md:min-h-[var(--shell-main-min,calc(100dvh_-_var(--app-header)_-_var(--app-bottom-bar,0rem)))]"
            id="conteudo"
            // the target of "Ir para o conteúdo" and of a screen opened with no load ("Conhecer o Pro"): focusable by script
            tabIndex={-1}
          >
            <ShellLogoutNotices logout={logout} trigger={storeMenu} />
            <ShellNotices
              acceptance={showAcceptanceNotice}
              connection={
                onlineOnly && !sessionOver ? { form: connectionForm } : null
              }
              session={showNotice}
            />
            <GraceNoticeSlot
              facts={planFacts}
              onSubscription={routeId === "subscription"}
            />
            {closedNotice && requiresOrganization ? (
              closedNotice
            ) : (
              <OfflineAccessGate>
                {requiresOrganization ? (
                  <OrganizationGate>{children}</OrganizationGate>
                ) : (
                  children
                )}
              </OfflineAccessGate>
            )}
          </main>
        </div>
        <BottomBar navId={navId} />
      </SidebarInset>
    </SidebarProvider>
  );
}
