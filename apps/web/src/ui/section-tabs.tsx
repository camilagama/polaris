import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

/** What the edges of the list hide: tabs to the left (already passed) and to the right (not reached yet). */
interface HiddenEdges {
  end: boolean;
  start: boolean;
}

/** The room kept between the open tab and the edge of the list, so it is not under the fade that warns of more tabs. */
const EDGE_ROOM = 32;
const EDGE_FADE =
  "pointer-events-none absolute inset-y-1.5 z-10 w-6 to-transparent";

/** The fade has to start in the color of what the list sits on, or it reads as a darker band at the edge. */
const EDGE_FADE_FROM = {
  page: "from-background",
  popover: "from-popover",
} as const;

/**
 * The list of tabs of a screen, on one line: on a narrow phone it scrolls sideways, with room
 * above and below for the 44 px touch area of each tab. The tab that opened
 * is brought into view, again when the set of tabs or the way they are drawn changes (`signature`), and a fade at the
 * edge that hides tabs says there are more to reach.
 */
export function ScreenTabList({
  children,
  label,
  signature = "",
  surface = "page",
  value,
}: {
  children: ReactNode;
  label: string;
  /** Changes when the tabs of the list change (one more, one less): the open tab is placed again. */
  signature?: string;
  /** What the list sits on: the page, or a dialog (`bg-popover`); the fade at the edges takes its color. */
  surface?: keyof typeof EDGE_FADE_FROM;
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
        <TabsList aria-label={label} className="justify-start">
          {children}
        </TabsList>
      </div>
      {hidden.start ? (
        <span
          aria-hidden="true"
          className={`${EDGE_FADE} ${EDGE_FADE_FROM[surface]} left-0 bg-linear-to-r`}
          data-tabs-edge="start"
        />
      ) : null}
      {hidden.end ? (
        <span
          aria-hidden="true"
          className={`${EDGE_FADE} ${EDGE_FADE_FROM[surface]} right-0 bg-linear-to-l`}
          data-tabs-edge="end"
        />
      ) : null}
    </div>
  );
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
      // below 360 px a narrower padding keeps three words of 20 px on the strip, so it does not widen the page
      aria-busy={reserved || undefined}
      className="flex-none max-[22.5rem]:px-1.5"
      data-value={value}
      disabled={reserved}
      value={value}
    >
      {children}
    </TabsTrigger>
  );
}

/** The panel of a tab, for what is drawn as children of `SectionTabs` (the screens of a routed list). */
export const SectionTabContent = TabsContent;

export interface SectionTab {
  /** What the tab shows when it opens; left out when the panels come as `children`. */
  content?: ReactNode;
  label: ReactNode;
  reserved?: boolean;
  value: string;
}

/**
 * The tabs of a screen, a dialog or a block, in one API. Without `value` the open tab is the component's own
 * (`defaultValue`, or the first) and each `content` is drawn when its tab opens. With `value` and `onValueChange` the
 * open tab belongs to the caller, which is how a tab goes into the address: the screens do that with `ScreenTabs`
 * (`app-shell/screen-tabs.tsx`) and draw their own panels as `children`. The list, the tab and the keyboard are the
 * same in both.
 */
export function SectionTabs({
  children,
  className,
  defaultValue,
  hideList = false,
  label,
  leading,
  onValueChange,
  surface = "page",
  tabs,
  value,
}: {
  children?: ReactNode;
  className?: string;
  defaultValue?: string;
  /** Draws no list: a screen with one tab alone has nothing to choose between. */
  hideList?: boolean;
  /** The name of the list of tabs, for a screen reader. */
  label: string;
  /** What comes before the list, inside the tabs (the menu of rows of a phone). */
  leading?: ReactNode;
  onValueChange?: (value: string) => void;
  /** What the list sits on: the page, or a dialog (`bg-popover`); the fade at the edges takes its color. */
  surface?: keyof typeof EDGE_FADE_FROM;
  tabs: readonly SectionTab[];
  value?: string;
}) {
  const [own, setOwn] = useState(defaultValue ?? tabs[0]?.value ?? "");
  const open = value ?? own;
  const change = useCallback(
    (next: unknown) => {
      setOwn(String(next));
      onValueChange?.(String(next));
    },
    [onValueChange]
  );
  return (
    <Tabs
      className={className ?? "min-w-0 gap-5"}
      onValueChange={change}
      value={open}
    >
      {leading}
      {hideList ? null : (
        <ScreenTabList
          label={label}
          signature={tabs.map((tab) => tab.value).join()}
          surface={surface}
          value={open}
        >
          {tabs.map((tab) => (
            <ScreenTabTrigger
              key={tab.value}
              reserved={tab.reserved ?? false}
              value={tab.value}
            >
              {tab.label}
            </ScreenTabTrigger>
          ))}
        </ScreenTabList>
      )}
      {tabs.map((tab) =>
        tab.content === undefined ? null : (
          <TabsContent key={tab.value} value={tab.value}>
            {tab.content}
          </TabsContent>
        )
      )}
      {children}
    </Tabs>
  );
}
