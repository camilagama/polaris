import {
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  Suspense,
  useEffect,
} from "react";
import { OrganizationProvider } from "../lib/current-organization";
import { OfflineRuntimeProvider } from "../offline/runtime/runtime-provider";
import { getUpdateStore } from "../pwa/runtime";
import { UpdateBanner } from "../pwa/update-banner";
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
  attention: lazy(() =>
    import("../offline/runtime/attention-page").then((module) => ({
      default: module.AttentionPage,
    }))
  ),
  categories: lazy(() =>
    import("../catalog/categories-page").then((module) => ({
      default: module.CategoriesPage,
    }))
  ),
  devices: lazy(() =>
    import("../offline/runtime/devices-page").then((module) => ({
      default: module.DevicesPage,
    }))
  ),
  customers: lazy(() =>
    import("../customers/customers-page").then((module) => ({
      default: module.CustomersPage,
    }))
  ),
  expenses: lazy(() =>
    import("../expenses/expenses-page").then((module) => ({
      default: module.ExpensesPage,
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

/** The new-version notice, where there is a service worker to update. */
function UpdateSlot() {
  const store = getUpdateStore();
  return store ? <UpdateBanner store={store} /> : null;
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
        <OfflineRuntimeProvider>
          <UpdateSlot />
          <RouteContent route={route} />
        </OfflineRuntimeProvider>
      </OrganizationProvider>
    </ErrorBoundary>
  );
}
