import { Suspense, useEffect } from "react";
import type { LegalDocumentId } from "@polaris/domain/legal/legal-documents";
import { resolveLegalRoute } from "../legal/legal-routes";
import { OrganizationProvider } from "../lib/current-organization";
import { isLegalAcceptancePath } from "../lib/legal-acceptance";
import { OfflineRuntimeProvider } from "../offline/runtime/runtime-provider";
import { getUpdateStore } from "../pwa/runtime";
import { UpdateBanner } from "../pwa/update-banner";
import { AppShell } from "./app-shell";
import { ErrorBoundary } from "./error-boundary";
import { type LazyScreen, lazyScreen } from "./lazy-screen";
import {
  documentTitle,
  type EntryPageId,
  entryPageFor,
  type ResolvedRoute,
  type RouteId,
  resolveRoute,
} from "./navigation-model";
import { NotFoundPage } from "./not-found-page";
import { PageLoading } from "./page-loading";

type Page = LazyScreen;

const TRAILING_SLASHES = /\/+$/;

/** Each area is its own chunk; a screen only loads when it is opened. */
const pages: Readonly<Record<RouteId, Page>> = {
  "account-security": lazyScreen(() =>
    import("../sign-in/change-password-page").then((module) => ({
      default: module.ChangePasswordPage,
    }))
  ),
  attention: lazyScreen(() =>
    import("../offline/runtime/attention-page").then((module) => ({
      default: module.AttentionPage,
    }))
  ),
  categories: lazyScreen(() =>
    import("../catalog/categories-page").then((module) => ({
      default: module.CategoriesPage,
    }))
  ),
  customers: lazyScreen(() =>
    import("../customers/customers-page").then((module) => ({
      default: module.CustomersPage,
    }))
  ),
  dashboard: lazyScreen(() =>
    import("../dashboard/dashboard-page").then((module) => ({
      default: module.DashboardPage,
    }))
  ),
  devices: lazyScreen(() =>
    import("../offline/runtime/devices-page").then((module) => ({
      default: module.DevicesPage,
    }))
  ),
  expenses: lazyScreen(() =>
    import("../expenses/expenses-page").then((module) => ({
      default: module.ExpensesPage,
    }))
  ),
  home: lazyScreen(() =>
    import("../home/home-page").then((module) => ({
      default: module.HomePage,
    }))
  ),
  inventory: lazyScreen(() =>
    import("../inventory/inventory-page").then((module) => ({
      default: module.InventoryPage,
    }))
  ),
  "payment-profiles": lazyScreen(() =>
    import("../payment-profiles/payment-profiles-page").then((module) => ({
      default: module.PaymentProfilesPage,
    }))
  ),
  products: lazyScreen(() =>
    import("../catalog/products-page").then((module) => ({
      default: module.ProductsPage,
    }))
  ),
  "public-catalog": lazyScreen(() =>
    import("../catalog/public-catalog-page").then((module) => ({
      default: module.PublicCatalogPage,
    }))
  ),
  sale: lazyScreen(() =>
    import("../sales/sale-page").then((module) => ({
      default: module.SalePage,
    }))
  ),
  "sale-customer": lazyScreen(() =>
    import("../sales/sale-customer-page").then((module) => ({
      default: module.SaleCustomerPage,
    }))
  ),
  "sale-detail": lazyScreen(() =>
    import("../sales/sale-detail-page").then((module) => ({
      default: module.SaleDetailPage,
    }))
  ),
  "sale-history": lazyScreen(() =>
    import("../sales/sale-history-page").then((module) => ({
      default: module.SaleHistoryPage,
    }))
  ),
};

/** A legal text is its own chunk, kept by the service worker: the shell and the entry pages do not carry it. */
const LegalApp = lazyScreen<{ document: LegalDocumentId }>(() =>
  import("../legal/legal-app").then((module) => ({ default: module.LegalApp }))
);

const AcceptancePage: Page = lazyScreen(() =>
  import("../legal/acceptance/acceptance-page").then((module) => ({
    default: module.AcceptancePage,
  }))
);

/** The sign-in group: each page its own chunk, all outside the shell (ADR 0100). */
const entryPages: Record<EntryPageId, Page> = {
  "confirm-email": lazyScreen(() =>
    import("../sign-in/confirm-email-page").then((module) => ({
      default: module.ConfirmEmailPage,
    }))
  ),
  "forgot-password": lazyScreen(() =>
    import("../sign-in/forgot-password-page").then((module) => ({
      default: module.ForgotPasswordPage,
    }))
  ),
  "reset-password": lazyScreen(() =>
    import("../sign-in/reset-password-page").then((module) => ({
      default: module.ResetPasswordPage,
    }))
  ),
  "sign-in": lazyScreen(() =>
    import("../sign-in/sign-in-page").then((module) => ({
      default: module.SignInPage,
    }))
  ),
  "sign-up": lazyScreen(() =>
    import("../sign-in/sign-up-page").then((module) => ({
      default: module.SignUpPage,
    }))
  ),
  unlock: lazyScreen(() =>
    import("../sign-in/unlock-page").then((module) => ({
      default: module.UnlockPage,
    }))
  ),
};

function RouteContent({ route }: { route: ResolvedRoute }) {
  if (route.kind === "not-found") {
    return (
      <AppShell
        navId={null}
        requiresOrganization={false}
        updateNotice={<UpdateSlot />}
      >
        <NotFoundPage pathname={window.location.pathname} />
      </AppShell>
    );
  }
  const Page = pages[route.id];
  return (
    <AppShell
      connectionForm={route.connectionForm}
      navId={route.navId}
      onlineOnly={route.onlineOnly}
      updateNotice={<UpdateSlot />}
    >
      <ErrorBoundary onRetry={Page.reset}>
        <Suspense fallback={<PageLoading />}>
          <Page />
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}

/** The new-version notice, where there is a service worker to update. */
function UpdateSlot({ standalone = false }: { standalone?: boolean }) {
  const store = getUpdateStore();
  if (!store) {
    return null;
  }
  // outside the shell there is no content column to sit in: the notice makes its own, above the page
  return standalone ? (
    <div className="mx-auto w-[min(100%-2rem,28rem)] pt-4">
      <UpdateBanner store={store} />
    </div>
  ) : (
    <UpdateBanner store={store} />
  );
}

/**
 * The sign-in screen has no organization, no menu and no offline runtime: nobody is signed in yet, so
 * there is nothing to register or read. It only needs the error boundary and the update notice.
 */
function SignInApp({ page }: { page: EntryPageId }) {
  const EntryPage = entryPages[page];
  return (
    <ErrorBoundary
      fullPage
      message="O Polaris não conseguiu abrir. Recarregue a página para tentar de novo."
      onRetry={EntryPage.reset}
    >
      <UpdateSlot standalone />
      {/* `fullPage`: the color of the page while the chunk loads, so there is no white flash in the dark theme */}
      <Suspense fallback={<PageLoading fullPage />}>
        <EntryPage />
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * `/aceite` stands apart as well (ADR 0100): the server refuses the store until the acceptance, so there
 * is no organization to read. It keeps "Sair", with a runtime that never starts.
 */
function AcceptanceApp() {
  return (
    <ErrorBoundary
      fullPage
      message="O Polaris não conseguiu abrir. Recarregue a página para tentar de novo."
      onRetry={AcceptancePage.reset}
    >
      <UpdateSlot standalone />
      <Suspense fallback={<PageLoading fullPage />}>
        <AcceptancePage />
      </Suspense>
    </ErrorBoundary>
  );
}

function StoreApp() {
  const route = resolveRoute(window.location.pathname);
  const { title } = route;
  useEffect(() => {
    document.title = documentTitle(title);
  }, [title]);

  return (
    <ErrorBoundary
      fullPage
      message="O Polaris não conseguiu abrir. Recarregue a página para tentar de novo."
    >
      <OrganizationProvider>
        <OfflineRuntimeProvider>
          <RouteContent route={route} />
        </OfflineRuntimeProvider>
      </OrganizationProvider>
    </ErrorBoundary>
  );
}

/**
 * The legal pages and the sign-in screen are public and stand apart from the store: no organization,
 * no menu, no offline runtime. The acceptance screen too, though it needs a session.
 */
export function App() {
  const legalDocument = resolveLegalRoute(window.location.pathname);
  if (legalDocument) {
    return (
      <ErrorBoundary
        fullPage
        message="O Polaris não conseguiu abrir. Recarregue a página para tentar de novo."
        onRetry={LegalApp.reset}
      >
        <Suspense fallback={<PageLoading fullPage />}>
          <LegalApp document={legalDocument} />
        </Suspense>
      </ErrorBoundary>
    );
  }
  if (isLegalAcceptancePath(window.location.pathname)) {
    return <AcceptanceApp />;
  }
  const entryPage = entryPageFor(window.location.pathname);
  if (entryPage && TRAILING_SLASHES.test(window.location.pathname)) {
    // the CSP of `_headers` matches the exact path: `/entrar/` would get the shell's, without the challenge
    const { hash, pathname, search } = window.location;
    window.location.replace(
      `${pathname.replace(TRAILING_SLASHES, "")}${search}${hash}`
    );
    return null;
  }
  return entryPage ? <SignInApp page={entryPage} /> : <StoreApp />;
}
