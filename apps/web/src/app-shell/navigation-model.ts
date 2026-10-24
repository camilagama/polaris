export type NavId =
  | "attention"
  | "categories"
  | "customers"
  | "dashboard"
  | "devices"
  | "expenses"
  | "history"
  | "home"
  | "inventory"
  | "payment-profiles"
  | "products"
  | "public-catalog"
  | "sale";

export type RouteId =
  | "account-security"
  | "attention"
  | "categories"
  | "customers"
  | "dashboard"
  | "devices"
  | "expenses"
  | "home"
  | "inventory"
  | "payment-profiles"
  | "products"
  | "public-catalog"
  | "sale"
  | "sale-customer"
  | "sale-detail"
  | "sale-history";

/** The group of the sidebar an item is in; the first one has no label. */
export type NavGroup = "Catálogo" | "Configurações" | "Resultado" | null;

export interface NavItem {
  group: NavGroup;
  href: string;
  id: NavId;
  label: string;
}

/** The main menu, in the order of the daily workflow, by group of the sidebar (DESIGN.md, shell v5.1). */
export const NAV_ITEMS: readonly NavItem[] = [
  { group: null, href: "/", id: "home", label: "Início" },
  { group: null, href: "/sales", id: "sale", label: "Vender" },
  { group: null, href: "/sales/history", id: "history", label: "Histórico" },
  { group: "Catálogo", href: "/inventory", id: "inventory", label: "Estoque" },
  { group: "Catálogo", href: "/products", id: "products", label: "Produtos" },
  {
    group: "Catálogo",
    href: "/categories",
    id: "categories",
    label: "Categorias",
  },
  { group: "Catálogo", href: "/customers", id: "customers", label: "Clientes" },
  { group: "Resultado", href: "/expenses", id: "expenses", label: "Despesas" },
  {
    group: "Resultado",
    href: "/dashboard",
    id: "dashboard",
    label: "Resultado",
  },
  {
    group: "Configurações",
    href: "/payment-profiles",
    id: "payment-profiles",
    label: "Perfis de pagamento",
  },
  {
    group: "Configurações",
    href: "/public-catalog",
    id: "public-catalog",
    label: "Catálogo público",
  },
];

/**
 * Menu items that only exist while the offline runtime is on (a device is
 * registered only then), so they are not part of the main menu above.
 */
export const OFFLINE_NAV_ITEMS: readonly NavItem[] = [
  {
    group: "Configurações",
    href: "/devices",
    id: "devices",
    label: "Aparelhos",
  },
];

/** The destinations of the bottom bar of the phone, in order; every other item is under "Mais". */
export type BottomBarId = "history" | "home" | "inventory" | "sale";
export const BOTTOM_BAR_IDS: readonly BottomBarId[] = [
  "home",
  "sale",
  "history",
  "inventory",
];

export function inBottomBar(id: NavId): id is BottomBarId {
  return (BOTTOM_BAR_IDS as readonly NavId[]).includes(id);
}

/**
 * The destination of the bottom bar that carries the mark for a menu item: the item itself, or the one whose
 * area it is in (Estoque for Produtos, Categorias and Clientes), as in the reference of the shell v5.1. "more"
 * for the items of no destination of the bar, which "Mais" marks: Resultado and Despesas since the Início took
 * their place on the bar (desenho t269 v2, § 4), and Pendências, whose count "Mais" carries.
 */
const BOTTOM_BAR_AREA: Readonly<Partial<Record<NavId, BottomBarId>>> = {
  categories: "inventory",
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

interface RouteDefinition {
  id: RouteId;
  /** The menu item shown as current; null keeps the menu without one. */
  navId: NavId | null;
  title: string;
}

/**
 * Sale detail and the customer link of a sale are reached from the history,
 * not from the menu, so the history stays the current item there.
 */
const ROUTES: Readonly<Record<string, RouteDefinition>> = {
  "/": { id: "home", navId: "home", title: "Início" },
  // no item of the menu: the sidebar shows none as current, and the bottom bar marks "Mais"
  "/attention": {
    id: "attention",
    navId: "attention",
    title: "Pendências",
  },
  "/categories": { id: "categories", navId: "categories", title: "Categorias" },
  // reached from Aparelhos, only with the password on (ADR 0100)
  "/conta/seguranca": {
    id: "account-security",
    navId: "devices",
    title: "Trocar senha",
  },
  "/customers": { id: "customers", navId: "customers", title: "Clientes" },
  "/dashboard": { id: "dashboard", navId: "dashboard", title: "Resultado" },
  "/devices": { id: "devices", navId: "devices", title: "Aparelhos" },
  "/expenses": { id: "expenses", navId: "expenses", title: "Despesas" },
  "/inventory": { id: "inventory", navId: "inventory", title: "Estoque" },
  "/payment-profiles": {
    id: "payment-profiles",
    navId: "payment-profiles",
    title: "Perfis de pagamento",
  },
  "/products": { id: "products", navId: "products", title: "Produtos" },
  "/public-catalog": {
    id: "public-catalog",
    navId: "public-catalog",
    title: "Catálogo público",
  },
  "/sales": { id: "sale", navId: "sale", title: "Nova venda" },
  "/sales/customer": {
    id: "sale-customer",
    navId: "history",
    title: "Cliente da venda",
  },
  "/sales/detail": {
    id: "sale-detail",
    navId: "history",
    title: "Detalhe da venda",
  },
  "/sales/history": {
    id: "sale-history",
    navId: "history",
    title: "Histórico de vendas",
  },
};

/**
 * Screens that read and save on the server and have no copy on the device: offline they cannot work, so the
 * state chip says that instead of "tudo guardado neste aparelho" (U-54). The ones that work from the device
 * (sale, history, stock, products, customers, result, and the Início, which shows the device's copy of its figures
 * or says per block what waits for the connection) are not here.
 */
const ONLINE_ONLY_ROUTES: readonly RouteId[] = [
  "account-security",
  "categories",
  "expenses",
  "payment-profiles",
  "public-catalog",
  "sale-customer",
  "sale-detail",
];

/**
 * Online-only screens that show nothing to type until they load: offline, the connection notice says the
 * screen loads by itself instead of "o que você digitou fica aqui". The public catalog declares its form
 * once it loaded (`useConnectionNoticeForm`).
 */
const ONLINE_ONLY_WITHOUT_FORM: readonly RouteId[] = [
  "public-catalog",
  "sale-detail",
];

export type ResolvedRoute =
  | { kind: "not-found"; title: string }
  | {
      /** For the connection notice of an online-only screen: whether it holds a form to type in. */
      connectionForm: boolean;
      id: RouteId;
      kind: "page";
      navId: NavId | null;
      onlineOnly: boolean;
      title: string;
    };

const trailingSlashes = /\/+$/;

/** Maps a location pathname to a page, or to the not-found page. */
export function resolveRoute(pathname: string): ResolvedRoute {
  const normalized = pathname.replace(trailingSlashes, "") || "/";
  const route = Object.hasOwn(ROUTES, normalized)
    ? ROUTES[normalized]
    : undefined;
  return route
    ? {
        connectionForm: !ONLINE_ONLY_WITHOUT_FORM.includes(route.id),
        id: route.id,
        kind: "page",
        navId: route.navId,
        onlineOnly: ONLINE_ONLY_ROUTES.includes(route.id),
        title: route.title,
      }
    : { kind: "not-found", title: "Página não encontrada" };
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
