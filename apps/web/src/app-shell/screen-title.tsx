import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
} from "react";

/** Whether a screen is drawn inside a tab of another one (Configurações, Produtos, Resultado: map of navigation, § 1). */
const InTabContext = createContext(false);

/** Whether the tab this screen is drawn in is the open one: a tab kept drawn while hidden is not. */
const TabActiveContext = createContext(true);

/**
 * Draws its screens as tabs: their titles are under the title of the screen that holds them. `active` is false for a tab
 * kept drawn, hidden, while another one is open.
 */
export function TabPanelScope({
  active = true,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <InTabContext.Provider value={true}>
      <TabActiveContext.Provider value={active}>
        {children}
      </TabActiveContext.Provider>
    </InTabContext.Provider>
  );
}

/** Whether the screen is on the open tab (always true outside tabs): what is global to the page speaks for it only then. */
export function useTabActive(): boolean {
  return useContext(TabActiveContext);
}

/** Whether this screen is a tab of another one (it then leaves the focus on the tab when it opens). */
export function useInTab(): boolean {
  return useContext(InTabContext);
}

/**
 * The title of a screen: the `h1` of the page when it stands alone, and a section title under the screen's `h1` when it
 * is a tab, as the Metas of the Resultado (one `h1` a page).
 */
export function ScreenTitle({
  className,
  tabNamesIt = false,
  ...props
}: Omit<ComponentProps<"h1">, "className"> & {
  className?: string;
  /** The tab it is drawn in already carries this name: the heading stays for a screen reader and is not drawn twice. */
  tabNamesIt?: boolean;
}) {
  const inTab = useContext(InTabContext);
  let base = inTab ? "text-section" : "text-title";
  if (inTab && tabNamesIt) {
    base = `${base} sr-only`;
  }
  const merged = className ? `${base} ${className}` : base;
  return inTab ? (
    <h2 className={merged} {...props} />
  ) : (
    <h1 className={merged} {...props} />
  );
}

/** The width of the main action of a screen: the whole line under the title on a phone, its own size beside it from 760 px. */
export const TITLE_ACTION_CLASS = "w-full min-[47.5rem]:w-auto";

/**
 * The line of a screen's title with its main action: under the title, as wide as the screen, on a phone, and at the
 * right of the title from 760 px. The action is never inside a card and the first control after the title in the tab order.
 */
export function TitleLine({
  action,
  children,
}: {
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 min-[47.5rem]:flex min-[47.5rem]:items-center min-[47.5rem]:justify-between min-[47.5rem]:gap-x-3">
      {children}
      {action ? (
        <div className="grid gap-3 min-[47.5rem]:ml-auto min-[47.5rem]:flex min-[47.5rem]:items-start min-[47.5rem]:gap-2">
          {action}
        </div>
      ) : null}
    </div>
  );
}
