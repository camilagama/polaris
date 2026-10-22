export type NavId =
  | "categories"
  | "customers"
  | "dashboard"
  | "devices"
  | "expenses"
  | "history"
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
  | "inventory"
  | "payment-profiles"
  | "products"
  | "public-catalog"
  | "sale"
  | "sale-customer"
  | "sale-detail"
  | "sale-history";

export interface NavItem {
  href: string;
  id: NavId;
  label: string;
}

/** The main menu, in the order of the daily workflow. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/sales", id: "sale", label: "Vender" },
  { href: "/sales/history", id: "history", label: "Histórico" },
  { href: "/inventory", id: "inventory", label: "Estoque" },
  { href: "/products", id: "products", label: "Produtos" },
  { href: "/categories", id: "categories", label: "Categorias" },
  { href: "/customers", id: "customers", label: "Clientes" },
  { href: "/expenses", id: "expenses", label: "Despesas" },
  { href: "/dashboard", id: "dashboard", label: "Resultado" },
  {
    href: "/payment-profiles",
    id: "payment-profiles",
    label: "Perfis de pagamento",
  },
  { href: "/public-catalog", id: "public-catalog", label: "Catálogo público" },
];

/**
 * Menu items that only exist while the offline runtime is on (a device is
 * registered only then), so they are not part of the main menu above.
 */
export const OFFLINE_NAV_ITEMS: readonly NavItem[] = [
  { href: "/devices", id: "devices", label: "Aparelhos" },
];

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
  "/": { id: "sale", navId: "sale", title: "Nova venda" },
  "/attention": {
    id: "attention",
    navId: null,
    title: "Operações que precisam de atenção",
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
 * (sale, history, stock, products, customers, result) are not here.
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

export type ResolvedRoute =
  | { kind: "not-found"; title: string }
  | {
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
