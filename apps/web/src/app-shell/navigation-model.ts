/** The destinations of the menu (the navigation map, § 1): eight, and Pendências while it has something. */
export type NavId =
  | "attention"
  | "customers"
  | "dashboard"
  | "history"
  | "home"
  | "inventory"
  | "products"
  | "sale"
  | "settings";

/** A screen of the shell: the one component a path opens; a screen with tabs holds several routes. */
export type ScreenId =
  | "attention"
  | "customers"
  | "dashboard"
  | "home"
  | "inventory"
  | "products"
  | "sale"
  | "sale-detail"
  | "sale-history"
  | "settings";

/** What is on screen: a screen, or the tab of one (each with its own behavior offline). */
export type RouteId =
  | "account-security"
  | "attention"
  | "categories"
  | "customers"
  | "dashboard"
  | "data-export"
  | "devices"
  | "expenses"
  | "home"
  | "inventory"
  | "payment-profiles"
  | "products"
  | "public-catalog"
  | "sale"
  | "sale-detail"
  | "sale-history"
  | "subscription";

/** The group of the sidebar an item is in: Início and Configurações stand alone, with no label. */
export type NavGroup = "Gestão" | "Vendas" | null;

export interface NavItem {
  group: NavGroup;
  href: string;
  id: NavId;
  label: string;
}

/**
 * The eight destinations, in the order of the daily workflow, by group of the sidebar (map of navigation, § 1): Vendas
 * for what is sold, Gestão for what the store has and earns. Clientes is a register, like Produtos, as the bottom bar
 * of the phone already treats it (`BOTTOM_BAR_AREA`).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { group: null, href: "/", id: "home", label: "Início" },
  { group: "Vendas", href: "/sales", id: "sale", label: "Vender" },
  {
    group: "Vendas",
    href: "/sales/history",
    id: "history",
    label: "Histórico",
  },
  { group: "Gestão", href: "/inventory", id: "inventory", label: "Estoque" },
  { group: "Gestão", href: "/products", id: "products", label: "Produtos" },
  { group: "Gestão", href: "/customers", id: "customers", label: "Clientes" },
  { group: "Gestão", href: "/dashboard", id: "dashboard", label: "Resultado" },
  {
    group: null,
    href: "/configuracoes",
    id: "settings",
    label: "Configurações",
  },
];

/** The ninth destination, only while this device has a refused record: after Histórico, in Vendas, with the count. */
export const ATTENTION_NAV_ITEM: NavItem = {
  group: "Vendas",
  href: "/attention",
  id: "attention",
  label: "Pendências",
};

/** The menu in its order: Pendências only while there is a refused record, and gone when it is back to zero. */
export function menuItemsOf(options: { attention: boolean }): NavItem[] {
  if (!options.attention) {
    return [...NAV_ITEMS];
  }
  const items = [...NAV_ITEMS];
  items.splice(
    items.findIndex((item) => item.id === "history") + 1,
    0,
    ATTENTION_NAV_ITEM
  );
  return items;
}

/**
 * The destinations of the bottom bar of the phone, in order, before "Mais": Vender in the middle of the five (v7 § 3
 * item 12); every other item is under "Mais".
 */
export type BottomBarId = "history" | "home" | "inventory" | "sale";
export const BOTTOM_BAR_IDS: readonly BottomBarId[] = [
  "home",
  "history",
  "sale",
  "inventory",
];

export function inBottomBar(id: NavId): id is BottomBarId {
  return (BOTTOM_BAR_IDS as readonly NavId[]).includes(id);
}

/**
 * The destination of the bottom bar that carries the mark for a menu item: the item itself, or the one whose area it
 * is in (Estoque for Produtos and Clientes, map § 2). "more" for the items of no destination of the bar, which "Mais"
 * marks: Pendências, Resultado and Configurações.
 */
const BOTTOM_BAR_AREA: Readonly<Partial<Record<NavId, BottomBarId>>> = {
  customers: "inventory",
  products: "inventory",
};

export function bottomBarMark(id: NavId): BottomBarId | "more" {
  if (inBottomBar(id)) {
    return id;
  }
  return BOTTOM_BAR_AREA[id] ?? "more";
}

/** The items in their groups, in the order of the list; a group with no item is left out. */
export function navGroups(
  items: readonly NavItem[]
): { items: NavItem[]; label: NavGroup }[] {
  const groups: { items: NavItem[]; label: NavGroup }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.label === item.group) {
      last.items.push(item);
    } else {
      groups.push({ items: [item], label: item.group });
    }
  }
  return groups;
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                       */
/* -------------------------------------------------------------------------- */

/** The tab is in the address (`?aba=`): a reload, a saved link and the copy offline open the same tab. */
const TAB_PARAMETER = "aba";

export type TabScreenId = "dashboard" | "products" | "settings";

export interface ScreenTab {
  label: string;
  route: RouteId;
  /** The value of `aba`; the first tab of a screen is the address without it. */
  value: string;
}

/** The tabs of each screen that has them, in order (map § 1). */
export const SCREEN_TABS: Readonly<Record<TabScreenId, readonly ScreenTab[]>> =
  {
    dashboard: [
      { label: "Resultado", route: "dashboard", value: "resultado" },
      { label: "Metas", route: "dashboard", value: "metas" },
      { label: "Despesas", route: "expenses", value: "despesas" },
    ],
    products: [
      { label: "Produtos", route: "products", value: "produtos" },
      { label: "Categorias", route: "categories", value: "categorias" },
    ],
    settings: [
      {
        label: "Formas de receber",
        route: "payment-profiles",
        value: "formas-de-receber",
      },
      {
        label: "Catálogo público",
        route: "public-catalog",
        value: "catalogo-publico",
      },
      { label: "Aparelhos", route: "devices", value: "aparelhos" },
      { label: "Assinatura", route: "subscription", value: "assinatura" },
      { label: "Senha", route: "account-security", value: "senha" },
      { label: "Seus dados", route: "data-export", value: "seus-dados" },
    ],
  };

/**
 * The tab an address asks of a screen: its `aba` when it is one of the screen's tabs, else the first. On the
 * Resultado, the two links of the Início to the goals (`meta=nova`, `meta=lista`) ask for Metas and win over `aba`.
 */
export function requestedTab(screen: TabScreenId, search: string): ScreenTab {
  const tabs = SCREEN_TABS[screen];
  const params = new URLSearchParams(search);
  const meta = params.get("meta");
  const value =
    screen === "dashboard" && (meta === "nova" || meta === "lista")
      ? "metas"
      : params.get(TAB_PARAMETER);
  return tabs.find((tab) => tab.value === value) ?? (tabs[0] as ScreenTab);
}

/**
 * The tab to draw among the ones this person has (`available`), and whether the address must be rewritten to say it:
 * the address asks for one this person does not have (Aparelhos without the offline runtime...) or names no tab of
 * the screen at all (`?aba=xyz`).
 */
export function openedTab(
  screen: TabScreenId,
  search: string,
  available: readonly string[]
): { rewrite: boolean; value: string } {
  const asked = requestedTab(screen, search).value;
  const named = new URLSearchParams(search).get(TAB_PARAMETER);
  // the first tab of the screen that this person has, in the order of the screen
  const first = SCREEN_TABS[screen].find((tab) =>
    available.includes(tab.value)
  )?.value;
  const value = available.includes(asked) ? asked : (first ?? asked);
  const unknown =
    named !== null && !SCREEN_TABS[screen].some((tab) => tab.value === named);
  return { rewrite: value !== asked || unknown, value };
}

/** The path, query and hash of `href` with the tab written in; the first tab of the screen is no `aba` at all. */
export function addressWithTab(
  href: string,
  screen: TabScreenId,
  value: string
): string {
  const url = new URL(href, "https://polaris.invalid");
  if (SCREEN_TABS[screen][0]?.value === value) {
    url.searchParams.delete(TAB_PARAMETER);
  } else {
    url.searchParams.set(TAB_PARAMETER, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

interface RouteDefinition {
  /** The menu item shown as current; null keeps the menu without one. */
  navId: NavId | null;
  screen: ScreenId;
  title: string;
}

/** The sale detail is reached from the history, not from the menu, so the history stays the current item there. */
const ROUTES: Readonly<Record<string, RouteDefinition>> = {
  "/": { navId: "home", screen: "home", title: "Início" },
  "/attention": {
    navId: "attention",
    screen: "attention",
    title: "Pendências",
  },
  "/configuracoes": {
    navId: "settings",
    screen: "settings",
    title: "Configurações",
  },
  "/customers": { navId: "customers", screen: "customers", title: "Clientes" },
  "/dashboard": { navId: "dashboard", screen: "dashboard", title: "Resultado" },
  "/inventory": { navId: "inventory", screen: "inventory", title: "Estoque" },
  "/products": { navId: "products", screen: "products", title: "Produtos" },
  "/sales": { navId: "sale", screen: "sale", title: "Nova venda" },
  "/sales/detail": {
    navId: "history",
    screen: "sale-detail",
    title: "Detalhe da venda",
  },
  "/sales/history": {
    navId: "history",
    screen: "sale-history",
    title: "Histórico de vendas",
  },
};

/**
 * The screens that became tabs (map § 6) keep their addresses for a saved link and for the copy on the device: each
 * opens its tab, with the rest of its query and its hash (the return of a checkout, `?retorno=`, goes on).
 */
const LEGACY_ADDRESSES: Readonly<
  Record<string, { path: string; screen: TabScreenId; tab: string }>
> = {
  "/categories": { path: "/products", screen: "products", tab: "categorias" },
  "/conta/seguranca": {
    path: "/configuracoes",
    screen: "settings",
    tab: "senha",
  },
  "/devices": { path: "/configuracoes", screen: "settings", tab: "aparelhos" },
  "/expenses": { path: "/dashboard", screen: "dashboard", tab: "despesas" },
  "/payment-profiles": {
    path: "/configuracoes",
    screen: "settings",
    tab: "formas-de-receber",
  },
  "/public-catalog": {
    path: "/configuracoes",
    screen: "settings",
    tab: "catalogo-publico",
  },
  "/subscription": {
    path: "/configuracoes",
    screen: "settings",
    tab: "assinatura",
  },
};

/** The address of the tab an old address opens (map § 6), or null for any other address. */
export function legacyAddress(
  pathname: string,
  search: string,
  hash: string
): string | null {
  const normalized = pathname.replace(trailingSlashes, "") || "/";
  const target = Object.hasOwn(LEGACY_ADDRESSES, normalized)
    ? LEGACY_ADDRESSES[normalized]
    : undefined;
  if (!target) {
    return null;
  }
  return addressWithTab(
    `${target.path}${search}${hash}`,
    target.screen,
    target.tab
  );
}

/** The address of a tab, for a link from another screen. */
export function tabHref(screen: TabScreenId, value: string): string {
  const path = Object.entries(ROUTES).find(
    ([, route]) => route.screen === screen
  )?.[0];
  return addressWithTab(path ?? "/", screen, value);
}

/**
 * Screens that read and save on the server and have no copy on the device: offline they cannot work, so the
 * state chip says that instead of "tudo guardado neste aparelho" (U-54). The ones that work from the device
 * (sale, history, stock, products, customers, result, and the Início, which shows the device's copy of its figures
 * or says per block what waits for the connection) are not here.
 */
const ONLINE_ONLY_ROUTES: readonly RouteId[] = [
  "account-security",
  "categories",
  "data-export",
  "expenses",
  "payment-profiles",
  "public-catalog",
  "sale-detail",
  "subscription",
];

/**
 * Online-only screens that show nothing to type until they load: offline, the connection notice says the
 * screen loads by itself instead of "o que você digitou fica aqui". The public catalog declares its form
 * once it loaded (`useConnectionNoticeForm`).
 */
const ONLINE_ONLY_WITHOUT_FORM: readonly RouteId[] = [
  "public-catalog",
  "sale-detail",
  // never a plan of before (AS-8): offline it shows nothing, and loads by itself on the return
  "subscription",
];

export type ResolvedRoute =
  | { kind: "not-found"; title: string }
  | {
      /** For the connection notice of an online-only screen: whether it holds a form to type in. */
      connectionForm: boolean;
      /** The screen, or the tab of the screen, on screen. */
      id: RouteId;
      kind: "page";
      navId: NavId | null;
      onlineOnly: boolean;
      screen: ScreenId;
      title: string;
    };

const trailingSlashes = /\/+$/;

function isTabScreen(screen: ScreenId): screen is TabScreenId {
  return Object.hasOwn(SCREEN_TABS, screen);
}

/** Maps a location (its pathname, and its query for the tab) to a page, or to the not-found page. */
export function resolveRoute(pathname: string, search = ""): ResolvedRoute {
  const normalized = pathname.replace(trailingSlashes, "") || "/";
  const route = Object.hasOwn(ROUTES, normalized)
    ? ROUTES[normalized]
    : undefined;
  if (!route) {
    return { kind: "not-found", title: "Página não encontrada" };
  }
  let id = route.screen as RouteId;
  let { title } = route;
  if (isTabScreen(route.screen)) {
    const tab = requestedTab(route.screen, search);
    id = tab.route;
    // the first tab is the screen itself; another one names the page by its own name
    if (tab !== SCREEN_TABS[route.screen][0]) {
      title = tab.label;
    }
  }
  return {
    connectionForm: !ONLINE_ONLY_WITHOUT_FORM.includes(id),
    id,
    kind: "page",
    navId: route.navId,
    onlineOnly: ONLINE_ONLY_ROUTES.includes(id),
    screen: route.screen,
    title,
  };
}

/**
 * The screen on display as the report of an error names it (`routeId` of `@polaris/contracts/client-error`): the
 * screen of `ROUTES`, and for a screen with tabs `screen:tab`, by the tab the address asks. Null outside the shell.
 */
export function screenKeyOf(pathname: string, search = ""): string | null {
  const normalized = pathname.replace(trailingSlashes, "") || "/";
  const route = Object.hasOwn(ROUTES, normalized)
    ? ROUTES[normalized]
    : undefined;
  if (!route) {
    return null;
  }
  return isTabScreen(route.screen)
    ? `${route.screen}:${requestedTab(route.screen, search).value}`
    : route.screen;
}

/** Every key `screenKeyOf` gives, sorted: each screen of `ROUTES`, and each tab of a screen with tabs. */
export function screenKeys(): string[] {
  return Object.values(ROUTES)
    .flatMap(({ screen }) =>
      isTabScreen(screen)
        ? SCREEN_TABS[screen].map((tab) => `${screen}:${tab.value}`)
        : [screen]
    )
    .sort();
}

/**
 * The pages of the sign-in group (ADR 0100): outside the shell, no menu, no organization, so they are
 * not among the routes above. All but `/desbloquear` show the challenge, under their own CSP.
 */
export type EntryPageId =
  | "confirm-email"
  | "forgot-password"
  | "reset-password"
  | "sign-in"
  | "sign-up"
  | "unlock";

const ENTRY_PAGES: Readonly<Record<string, EntryPageId>> = {
  "/confirmar-email": "confirm-email",
  "/criar-conta": "sign-up",
  "/desbloquear": "unlock",
  "/entrar": "sign-in",
  "/esqueci-a-senha": "forgot-password",
  "/redefinir-senha": "reset-password",
};

/** The sign-in page a pathname opens, or null. Exact paths only (a trailing slash is the same page). */
export function entryPageFor(pathname: string): EntryPageId | null {
  const normalized = pathname.replace(trailingSlashes, "") || "/";
  return Object.hasOwn(ENTRY_PAGES, normalized)
    ? (ENTRY_PAGES[normalized] ?? null)
    : null;
}

export function documentTitle(title: string): string {
  return `${title} · Polaris`;
}
