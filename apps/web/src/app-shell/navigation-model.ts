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

export type ResolvedRoute =
  | { kind: "not-found"; title: string }
  | { id: RouteId; kind: "page"; navId: NavId | null; title: string };

const trailingSlashes = /\/+$/;

/** Maps a location pathname to a page, or to the not-found page. */
export function resolveRoute(pathname: string): ResolvedRoute {
  const normalized = pathname.replace(trailingSlashes, "") || "/";
  const route = Object.hasOwn(ROUTES, normalized)
    ? ROUTES[normalized]
    : undefined;
  return route
    ? { id: route.id, kind: "page", navId: route.navId, title: route.title }
    : { kind: "not-found", title: "Página não encontrada" };
}

/** `/entrar` is the sign-in screen: it lives outside the shell, so it is not one of the routes above. */
export function isSignInPath(pathname: string): boolean {
  return (pathname.replace(trailingSlashes, "") || "/") === "/entrar";
}

export function documentTitle(title: string): string {
  return `${title} · Polaris`;
}
