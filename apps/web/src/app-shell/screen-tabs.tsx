import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from "react";
import { SectionTabContent, SectionTabs } from "@/ui/section-tabs";
import { UnsentWorkScope, useUnsentWorkScope } from "../lib/unsent-work";
import { replaceAddress, useAddress } from "./address";
import { ErrorBoundary } from "./error-boundary";
import type { LazyScreen } from "./lazy-screen";
import {
  addressWithTab,
  listedTabs,
  openedTab,
  type TabScreenId,
} from "./navigation-model";
import { PageLoading } from "./page-loading";
import { TabPanelScope, type TitleBack, TitleLine } from "./screen-title";

/** The links into a tab: the goals of the Início, a new product or one of them, the return of a checkout, the part of Despesas. */
const TAB_LINK_PARAMETERS = ["meta", "novo", "produto", "retorno", "ver"];

/**
 * The tab on screen and the way to change it. The address names it (`?aba=`); a tab this person does not have (Aparelhos
 * without the offline runtime, Assinatura without `billing:manage`...) or a value that is no tab (`?aba=xyz`) opens the
 * first one, and the address says so (`replaceAddress`: no step in the history).
 * Changing tabs rewrites the address in place (no step in the history: "voltar" leaves the screen) and drops the links
 * that opened something inside the tab that was open (`?novo=1`, `?retorno=`...), so coming back does not open it again.
 * `explicit` writes the first tab as `?aba=` too (see `addressWithTab`); `idle` leaves the address alone (the list of
 * tabs of a phone is open, which names none).
 */
export function useScreenTab(
  screen: TabScreenId,
  available: readonly string[],
  { explicit = false, idle = false } = {}
): [string, (value: unknown) => void] {
  const { search } = useAddress();
  const { rewrite, value } = openedTab(screen, search, available);
  useEffect(() => {
    if (rewrite && !idle) {
      replaceAddress(
        addressWithTab(window.location.href, screen, value, explicit)
      );
    }
  }, [explicit, idle, rewrite, screen, value]);
  const select = useCallback(
    (next: unknown) => {
      const url = new URL(window.location.href);
      for (const name of TAB_LINK_PARAMETERS) {
        url.searchParams.delete(name);
      }
      replaceAddress(
        addressWithTab(
          `${url.pathname}${url.search}`,
          screen,
          String(next),
          explicit
        )
      );
    },
    [explicit, screen]
  );
  return [value, select];
}

export interface TabPanel {
  /** What shows while the screen's chunk loads, with the screen's own shape; `PageLoading` without it. */
  fallback?: ReactNode;
  Screen: LazyScreen;
  value: string;
}

/**
 * A phone's way into the tabs of a screen: no strip, but a `menu` of rows that opens each tab, and, with a tab open,
 * `back`, the arrow before the title, to return to the menu. `showMenu` says the menu is what is on screen; the screens kept for
 * work typed and not sent stay drawn, hidden, while it is.
 */
export interface TabPhone {
  back: TitleBack;
  menu: ReactNode;
  showMenu: boolean;
}

/**
 * Tells the tabs whether the screen inside this panel holds work typed and not sent (`useHoldSwap`), to keep the panel
 * drawn while another tab is open.
 */
function PanelUnsentWork({
  children,
  onHold,
  value,
}: {
  children: ReactNode;
  onHold?: ((value: string, held: boolean) => void) | undefined;
  value: string;
}) {
  const [report, held] = useUnsentWorkScope();
  useEffect(() => {
    onHold?.(value, held);
    return () => onHold?.(value, false);
  }, [held, onHold, value]);
  return <UnsentWorkScope value={report}>{children}</UnsentWorkScope>;
}

/**
 * The screen of a tab: its own chunk, loaded when the tab opens, and its failure kept to the tab. With `keepMounted` it
 * stays drawn, hidden, while another tab is open: what the person typed in it is state of the screen, and a screen
 * that is drawn again starts blank.
 */
export function ScreenTabPanel({
  active = true,
  className,
  keepMounted = false,
  onHold,
  panel,
}: {
  /** Whether this is the open tab; false while it is kept drawn, hidden. */
  active?: boolean;
  className?: string;
  keepMounted?: boolean;
  /** Called when the screen of the panel starts or stops holding unsent work. */
  onHold?: ((value: string, held: boolean) => void) | undefined;
  panel: TabPanel;
}) {
  const { Screen } = panel;
  return (
    <SectionTabContent
      className={className}
      keepMounted={keepMounted}
      value={panel.value}
    >
      <PanelUnsentWork onHold={onHold} value={panel.value}>
        <TabPanelScope active={active}>
          <ErrorBoundary onRetry={Screen.reset}>
            <Suspense fallback={panel.fallback ?? <PageLoading />}>
              <Screen />
            </Suspense>
          </ErrorBoundary>
        </TabPanelScope>
      </PanelUnsentWork>
    </SectionTabContent>
  );
}

/** The tabs whose screen holds unsent work: they stay drawn when another tab opens. */
function useKeptPanels(): [
  ReadonlySet<string>,
  (value: string, held: boolean) => void,
] {
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const hold = useCallback((value: string, held: boolean) => {
    setKept((current) => {
      if (current.has(value) === held) {
        return current;
      }
      const next = new Set(current);
      if (held) {
        next.add(value);
      } else {
        next.delete(value);
      }
      return next;
    });
  }, []);
  return [kept, hold];
}

/**
 * A destination whose screens became tabs (map of navigation, § 1): its title, the tabs this person has, and the
 * screen of the open one. Only the open tab is drawn, except one that holds work typed and not sent: it stays drawn,
 * hidden, until the work is sent or thrown away. `reserved` names tabs whose condition is not answered yet: they are
 * listed off, in their place, with no panel.
 */
export function ScreenTabs({
  label,
  panels,
  phone,
  reserved = [],
  screen,
  title,
}: {
  /** The name of the list of tabs, for a screen reader. */
  label: string;
  panels: readonly TabPanel[];
  /** Replaces the strip with a menu of rows and a way back (Configurações, below 760 px). */
  phone?: TabPhone | undefined;
  reserved?: readonly string[];
  screen: TabScreenId;
  title: string;
}) {
  const available = panels.map((panel) => panel.value);
  const [value, select] = useScreenTab(screen, available, {
    explicit: phone !== undefined,
    idle: phone?.showMenu === true,
  });
  const [kept, hold] = useKeptPanels();
  const tabs = listedTabs(screen, available, reserved);
  const phoneMenu = phone?.showMenu ? phone.menu : null;
  const phoneBack = phone && !phone.showMenu ? phone.back : undefined;
  // one tab alone has nothing to choose between: the screen shows its content under the title
  const showStrip = !phone && tabs.length > 1;
  return (
    <div className="grid gap-5 font-sans text-foreground text-sm antialiased">
      {phoneBack ? (
        <TitleLine back={phoneBack}>
          <h1 className="text-title">{title}</h1>
        </TitleLine>
      ) : (
        <h1 className="text-title">{title}</h1>
      )}
      <SectionTabs
        hideList={!showStrip}
        label={label}
        leading={phone ? phoneMenu : null}
        onValueChange={select}
        tabs={tabs}
        value={phone?.showMenu ? "" : value}
      >
        {panels.map((panel) => (
          <ScreenTabPanel
            active={!phone?.showMenu && panel.value === value}
            keepMounted={kept.has(panel.value)}
            key={panel.value}
            onHold={hold}
            panel={panel}
          />
        ))}
      </SectionTabs>
    </div>
  );
}
