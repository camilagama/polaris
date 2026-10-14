export type NavId =
  | "categories"
  | "customers"
  | "devices"
  | "history"
  | "inventory"
  | "payment-profiles"
  | "products"
  | "sale";

export type RouteId =
  | "attention"
  | "categories"
  | "customers"
  | "devices"
  | "inventory"
  | "payment-profiles"
  | "products"
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
  {
    href: "/payment-profiles",
    id: "payment-profiles",
    label: "Perfis de pagamento",
  },
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
  "/devices": { id: "devices", navId: "devices", title: "Aparelhos" },
  "/inventory": { id: "inventory", navId: "inventory", title: "Estoque" },
  "/payment-profiles": {
    id: "payment-profiles",
    navId: "payment-profiles",
    title: "Perfis de pagamento",
  },
  "/products": { id: "products", navId: "products", title: "Produtos" },
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

export function documentTitle(title: string): string {
  return `${title} · Polaris`;
}
