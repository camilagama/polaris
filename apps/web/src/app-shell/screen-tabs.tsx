import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { replaceAddress, useAddress } from "./address";
import { ErrorBoundary } from "./error-boundary";
import type { LazyScreen } from "./lazy-screen";
import {
  addressWithTab,
  requestedTab,
  SCREEN_TABS,
  type TabScreenId,
} from "./navigation-model";
import { PageLoading } from "./page-loading";
import { TabPanelScope } from "./screen-title";

/** The links into a tab: the goals of the Início, a new product or one of them, the return of a checkout. */
const TAB_LINK_PARAMETERS = ["meta", "novo", "produto", "retorno"];

/**
 * The tab on screen and the way to change it. The address names it (`?aba=`); a tab this person does not have (Aparelhos
 * without the offline runtime, Assinatura without `billing:manage`...) opens the first one, and the address says so.
 * Changing tabs rewrites the address in place (no step in the history: "voltar" leaves the screen) and drops the links
 * that opened something inside the tab that was open (`?novo=1`, `?retorno=`...), so coming back does not open it again.
 */
export function useScreenTab(
  screen: TabScreenId,
  available: readonly string[]
): [string, (value: unknown) => void] {
  const { search } = useAddress();
  const asked = requestedTab(screen, search).value;
  // the first tab of the screen that this person has, in the order of the screen
  const first = SCREEN_TABS[screen].find((tab) =>
    available.includes(tab.value)
  )?.value;
  const value = available.includes(asked) ? asked : (first ?? asked);
  useEffect(() => {
    if (value !== asked) {
      replaceAddress(addressWithTab(window.location.href, screen, value));
    }
  }, [asked, screen, value]);
  const select = useCallback(
    (next: unknown) => {
      const url = new URL(window.location.href);
      for (const name of TAB_LINK_PARAMETERS) {
        url.searchParams.delete(name);
      }
      replaceAddress(
        addressWithTab(`${url.pathname}${url.search}`, screen, String(next))
      );
    },
    [screen]
  );
  return [value, select];
}

export interface TabPanel {
  Screen: LazyScreen;
  value: string;
}

/**
 * The list of tabs of a screen, on one line: on a narrow phone it scrolls sideways (Configurações has five), with room
 * above and below for the 48 px touch area of each tab, and the tab that opened is brought into view.
 */
export function ScreenTabList({
  children,
  label,
  value,
}: {
  children: ReactNode;
  label: string;
  value: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = scroller.current?.querySelector<HTMLElement>(
      `[data-value="${CSS.escape(value)}"]`
    );
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [value]);
  return (
    <div
      className="-my-1.5 max-w-full overflow-x-auto py-1.5 [scrollbar-width:none]"
      ref={scroller}
    >
      <TabsList aria-label={label} className="justify-start">
        {children}
      </TabsList>
    </div>
  );
}

/** A tab of the list, with its name in the address. */
export function ScreenTabTrigger({
  children,
  value,
}: {
  children: ReactNode;
  value: string;
}) {
  return (
    <TabsTrigger className="flex-none" data-value={value} value={value}>
      {children}
    </TabsTrigger>
  );
}

/** The screen of a tab: its own chunk, loaded when the tab opens, and its failure kept to the tab. */
export function ScreenTabPanel({
  className,
  panel,
}: {
  className?: string;
  panel: TabPanel;
}) {
  const { Screen } = panel;
  return (
    <TabsContent className={className} value={panel.value}>
      <TabPanelScope>
        <ErrorBoundary onRetry={Screen.reset}>
          <Suspense fallback={<PageLoading />}>
            <Screen />
          </Suspense>
        </ErrorBoundary>
      </TabPanelScope>
    </TabsContent>
  );
}

/**
 * A destination whose screens became tabs (map of navigation, § 1): its title, the tabs this person has, and the
 * screen of the open one. Only the open tab is drawn.
 */
export function ScreenTabs({
  label,
  panels,
  screen,
  title,
}: {
  /** The name of the list of tabs, for a screen reader. */
  label: string;
  panels: readonly TabPanel[];
  screen: TabScreenId;
  title: string;
}) {
  const available = panels.map((panel) => panel.value);
  const [value, select] = useScreenTab(screen, available);
  const tabs = SCREEN_TABS[screen].filter((tab) =>
    available.includes(tab.value)
  );
  return (
    <div className="grid gap-5 font-sans text-foreground text-sm antialiased">
      <h1 className="text-title">{title}</h1>
      <Tabs className="min-w-0 gap-5" onValueChange={select} value={value}>
        <ScreenTabList label={label} value={value}>
          {tabs.map((tab) => (
            <ScreenTabTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </ScreenTabTrigger>
          ))}
        </ScreenTabList>
        {panels.map((panel) => (
          <ScreenTabPanel key={panel.value} panel={panel} />
        ))}
      </Tabs>
    </div>
  );
}
