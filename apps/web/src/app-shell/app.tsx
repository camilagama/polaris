import {
  type ComponentType,
  lazy,
  type LazyExoticComponent,
  Suspense,
  useEffect,
} from "react";
import { OrganizationProvider } from "../lib/current-organization";
import { AppShell } from "./app-shell";
import { ErrorBoundary } from "./error-boundary";
import {
  documentTitle,
  type ResolvedRoute,
  type RouteId,
  resolveRoute,
} from "./navigation-model";
import { NotFoundPage } from "./not-found-page";

type Page = LazyExoticComponent<ComponentType>;

/** Each area is its own chunk; a screen only loads when it is opened. */
const pages: Readonly<Record<RouteId, Page>> = {
  categories: lazy(() =>
    import("../catalog/categories-page").then((module) => ({
      default: module.CategoriesPage,
    }))
  ),
  customers: lazy(() =>
    import("../customers/customers-page").then((module) => ({
      default: module.CustomersPage,
    }))
  ),
  inventory: lazy(() =>
    import("../inventory/inventory-page").then((module) => ({
      default: module.InventoryPage,
    }))
  ),
  "payment-profiles": lazy(() =>
    import("../payment-profiles/payment-profiles-page").then((module) => ({
      default: module.PaymentProfilesPage,
    }))
  ),
  products: lazy(() =>
    import("../catalog/products-page").then((module) => ({
      default: module.ProductsPage,
    }))
  ),
  sale: lazy(() =>
    import("../sales/sale-page").then((module) => ({
      default: module.SalePage,
    }))
  ),
  "sale-customer": lazy(() =>
    import("../sales/sale-customer-page").then((module) => ({
      default: module.SaleCustomerPage,
    }))
  ),
  "sale-detail": lazy(() =>
    import("../sales/sale-detail-page").then((module) => ({
      default: module.SaleDetailPage,
    }))
  ),
  "sale-history": lazy(() =>
    import("../sales/sale-history-page").then((module) => ({
      default: module.SaleHistoryPage,
    }))
  ),
};

function RouteContent({ route }: { route: ResolvedRoute }) {
  if (route.kind === "not-found") {
    return (
      <AppShell navId={null} requiresOrganization={false}>
        <NotFoundPage pathname={window.location.pathname} />
      </AppShell>
    );
  }
  const Page = pages[route.id];
  return (
    <AppShell navId={route.navId}>
      <ErrorBoundary>
        <Suspense
          fallback={
            <p className="app-status" role="status">
              Carregando…
            </p>
          }
        >
          <Page />
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}

export function App() {
  const route = resolveRoute(window.location.pathname);
  const { title } = route;
  useEffect(() => {
    document.title = documentTitle(title);
  }, [title]);

  return (
    <ErrorBoundary message="O Polaris não conseguiu abrir. Recarregue a página para tentar de novo.">
      <OrganizationProvider>
        <RouteContent route={route} />
      </OrganizationProvider>
    </ErrorBoundary>
  );
}
