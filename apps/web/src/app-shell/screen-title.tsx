import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
} from "react";

/** Whether a screen is drawn inside a tab of another one (Configurações, Produtos, Resultado: map of navigation, § 1). */
const InTabContext = createContext(false);

/** Draws its screens as tabs: their titles are under the title of the screen that holds them. */
export function TabPanelScope({ children }: { children: ReactNode }) {
  return <InTabContext.Provider value={true}>{children}</InTabContext.Provider>;
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
  ...props
}: Omit<ComponentProps<"h1">, "className"> & { className?: string }) {
  const inTab = useContext(InTabContext);
  const base = inTab ? "text-section" : "text-title";
  const merged = className ? `${base} ${className}` : base;
  return inTab ? (
    <h2 className={merged} {...props} />
  ) : (
    <h1 className={merged} {...props} />
  );
}
