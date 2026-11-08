import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
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
import { TabPanelScope } from "./screen-title";

/** The links into a tab: the goals of the Início, a new product or one of them, the return of a checkout, the part of Despesas. */
const TAB_LINK_PARAMETERS = ["meta", "novo", "produto", "retorno", "ver"];

/**
 * The tab on screen and the way to change it. The address names it (`?aba=`); a tab this person does not have (Aparelhos
 * without the offline runtime, Assinatura without `billing:manage`...) or a value that is no tab (`?aba=xyz`) opens the
 * first one, and the address says so (`replaceAddress`: no step in the history).
 * Changing tabs rewrites the address in place (no step in the history: "voltar" leaves the screen) and drops the links
 * that opened something inside the tab that was open (`?novo=1`, `?retorno=`...), so coming back does not open it again.
 */
export function useScreenTab(
  screen: TabScreenId,
  available: readonly string[]
): [string, (value: unknown) => void] {
  const { search } = useAddress();
  const { rewrite, value } = openedTab(screen, search, available);
  useEffect(() => {
    if (rewrite) {
      replaceAddress(addressWithTab(window.location.href, screen, value));
    }
  }, [rewrite, screen, value]);
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
  /** What shows while the screen's chunk loads, with the screen's own shape; `PageLoading` without it. */
  fallback?: ReactNode;
  Screen: LazyScreen;
  value: string;
}

/** A named set of tabs drawn as its own row: "Da loja" and "Da conta" in Configurações. */
export interface TabGroup {
  label: string;
  values: readonly string[];
}

/** What the edges of the list hide: tabs to the left (already passed) and to the right (not reached yet). */
interface HiddenEdges {
  end: boolean;
  start: boolean;
}

/** The room kept between the open tab and the edge of the list, so it is not under the fade that warns of more tabs. */
const EDGE_ROOM = 32;
const EDGE_FADE =
  "pointer-events-none absolute inset-y-1.5 z-10 w-6 from-background to-transparent";

/**
 * The list of tabs of a screen, on one line: on a narrow phone it scrolls sideways (Configurações has six), with room
 * above and below for the 44 px touch area of each tab; `grouped` draws it in named rows instead. The tab that opened
 * is brought into view, again when the set of tabs or the way they are drawn changes (`signature`), and a fade at the
 * edge that hides tabs says there are more to reach.
 */
export function ScreenTabList({
  children,
  grouped = false,
  label,
  signature = "",
  value,
}: {
  children: ReactNode;
  /** The tabs come in rows (`ScreenTabGroup`) instead of one segmented strip. */
  grouped?: boolean;
  label: string;
  /** Changes when the tabs of the list change (one more, one less): the open tab is placed again. */
  signature?: string;
  value: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<HiddenEdges>({
    end: false,
    start: false,
  });
  const measure = useCallback(() => {
    const list = scroller.current;
    if (!list) {
      return;
    }
    const start = list.scrollLeft > 1;
    const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
    setHidden((current) =>
      current.start === start && current.end === end ? current : { end, start }
    );
  }, []);
  // the scroll is the list's own: `scrollIntoView` would also move the page; no animation (movement is opacity only)
  useEffect(() => {
    const list = scroller.current;
    const active = list?.querySelector<HTMLElement>(
      `[data-value="${CSS.escape(value)}"]`
    );
    if (list && active) {
      const box = active.getBoundingClientRect();
      const area = list.getBoundingClientRect();
      if (box.left < area.left + EDGE_ROOM) {
        list.scrollLeft -= area.left + EDGE_ROOM - box.left;
      } else if (box.right > area.right - EDGE_ROOM) {
        list.scrollLeft += box.right - (area.right - EDGE_ROOM);
      }
    }
    measure();
  }, [measure, signature, value]);
  useEffect(() => {
    const list = scroller.current;
    if (!list || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure]);
  return (
    <div className="relative -my-1.5 max-w-full">
      <div
        className="overflow-x-auto py-1.5 [scrollbar-width:none]"
        onScroll={measure}
        ref={scroller}
      >
        <TabsList
          aria-label={label}
          className={
            grouped
              ? "h-auto w-full flex-col items-start gap-3 bg-transparent p-0"
              : "justify-start"
          }
        >
          {children}
        </TabsList>
      </div>
      {hidden.start ? (
        <span
          aria-hidden="true"
          className={`${EDGE_FADE} left-0 bg-linear-to-r`}
          data-tabs-edge="start"
        />
      ) : null}
      {hidden.end ? (
        <span
          aria-hidden="true"
          className={`${EDGE_FADE} right-0 bg-linear-to-l`}
          data-tabs-edge="end"
        />
      ) : null}
    </div>
  );
}

/**
 * One row of a grouped list: the name of the group, then its tabs on the muted strip. It owns no tab stop of its own
 * (`role="none"`): the arrows keep walking the whole list, as they do in the single strip, and the name of each tab is
 * the same.
 */
function ScreenTabGroup({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="flex max-w-full items-center gap-3" role="none">
      <span
        aria-hidden="true"
        className="min-w-16 shrink-0 text-muted-foreground text-xs"
        data-tabs-group={label}
      >
        {label}
      </span>
      <div
        className="inline-flex h-ctl-md items-center rounded-lg bg-muted p-0.75"
        role="none"
      >
        {children}
      </div>
    </div>
  );
}

/** The tabs of the list, row by row, the rows with no tab to show left out (not even their name). */
export function groupedTabsOf<Tab extends { value: string }>(
  tabs: readonly Tab[],
  groups: readonly TabGroup[]
): { label: string; tabs: Tab[] }[] {
  return groups
    .map((group) => ({
      label: group.label,
      tabs: tabs.filter((tab) => group.values.includes(tab.value)),
    }))
    .filter((group) => group.tabs.length > 0);
}

/**
 * A tab of the list, with its name in the address. `reserved` holds the place of a tab whose condition the server has
 * not answered yet (it is off and busy until then), so the tabs beside it do not move when the answer arrives.
 */
export function ScreenTabTrigger({
  children,
  reserved = false,
  value,
}: {
  children: ReactNode;
  reserved?: boolean;
  value: string;
}) {
  return (
    <TabsTrigger
      aria-busy={reserved || undefined}
      className="flex-none"
      data-value={value}
      disabled={reserved}
      value={value}
    >
      {children}
    </TabsTrigger>
  );
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
    <TabsContent
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
    </TabsContent>
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
  groups,
  label,
  panels,
  reserved = [],
  screen,
  title,
}: {
  /** Draws the tabs in named rows instead of one strip (Configurações, from 760 px). */
  groups?: readonly TabGroup[] | undefined;
  /** The name of the list of tabs, for a screen reader. */
  label: string;
  panels: readonly TabPanel[];
  reserved?: readonly string[];
  screen: TabScreenId;
  title: string;
}) {
  const available = panels.map((panel) => panel.value);
  const [value, select] = useScreenTab(screen, available);
  const [kept, hold] = useKeptPanels();
  const tabs = listedTabs(screen, available, reserved);
  const trigger = (tab: (typeof tabs)[number]) => (
    <ScreenTabTrigger key={tab.value} reserved={tab.reserved} value={tab.value}>
      {tab.label}
    </ScreenTabTrigger>
  );
  return (
    <div className="grid gap-5 font-sans text-foreground text-sm antialiased">
      <h1 className="text-title">{title}</h1>
      <Tabs className="min-w-0 gap-5" onValueChange={select} value={value}>
        <ScreenTabList
          grouped={groups !== undefined}
          label={label}
          signature={`${groups === undefined ? "strip" : "rows"}:${tabs.map((tab) => tab.value).join()}`}
          value={value}
        >
          {groups === undefined
            ? tabs.map(trigger)
            : groupedTabsOf(tabs, groups).map((group) => (
                <ScreenTabGroup key={group.label} label={group.label}>
                  {group.tabs.map(trigger)}
                </ScreenTabGroup>
              ))}
        </ScreenTabList>
        {panels.map((panel) => (
          <ScreenTabPanel
            active={panel.value === value}
            keepMounted={kept.has(panel.value)}
            key={panel.value}
            onHold={hold}
            panel={panel}
          />
        ))}
      </Tabs>
    </div>
  );
}
