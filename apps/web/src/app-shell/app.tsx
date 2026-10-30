import { Suspense, useEffect } from "react";
import type { LegalDocumentId } from "@polaris/domain/legal/legal-documents";
import { resolveLegalRoute } from "../legal/legal-routes";
import { isClosedStorePath } from "../lib/closed-store-path";
import { OrganizationProvider } from "../lib/current-organization";
import { isLegalAcceptancePath } from "../lib/legal-acceptance";
import { OfflineRuntimeProvider } from "../offline/runtime/runtime-provider";
import { legacyCheckoutReturnPath } from "../subscription/plan-notice";
import { useAddress } from "./address";
import { AppShell } from "./app-shell";
import { ErrorBoundary } from "./error-boundary";
import { type LazyScreen, lazyScreen } from "./lazy-screen";
import {
  documentTitle,
  type EntryPageId,
  entryPageFor,
  legacyAddress,
  type ResolvedRoute,
  resolveRoute,
  type ScreenId,
} from "./navigation-model";
import { NotFoundPage } from "./not-found-page";
import { PageLoading } from "./page-loading";

type Page = LazyScreen;

const TRAILING_SLASHES = /\/+$/;

/** Each area is its own chunk; a screen only loads when it is opened (and each tab of a screen, when it opens). */
const pages: Readonly<Record<ScreenId, Page>> = {
  attention: lazyScreen(() =>
    import("../offline/runtime/attention-page").then((module) => ({
      default: module.AttentionPage,
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
  products: lazyScreen(() =>
    import("../catalog/catalog-products-screen").then((module) => ({
      default: module.CatalogProductsScreen,
    }))
  ),
  sale: lazyScreen(() =>
    import("../sales/sale-page").then((module) => ({
      default: module.SalePage,
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
  settings: lazyScreen(() =>
    import("../settings/settings-screen").then((module) => ({
      default: module.SettingsScreen,
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

const ClosedStorePage: Page = lazyScreen(() =>
  import("../organization/closed-store-page").then((module) => ({
    default: module.ClosedStorePage,
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
      <AppShell navId={null} requiresOrganization={false}>
        <NotFoundPage pathname={window.location.pathname} />
      </AppShell>
    );
  }
  const Page = pages[route.screen];
  return (
    <AppShell
      connectionForm={route.connectionForm}
      navId={route.navId}
      onlineOnly={route.onlineOnly}
      routeId={route.id}
    >
      <ErrorBoundary onRetry={Page.reset}>
        <Suspense fallback={<PageLoading />}>
          <Page />
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}

/**
 * The sign-in screen has no organization, no menu and no offline runtime: nobody is signed in yet, so
 * there is nothing to register or read. It only needs the error boundary.
 */
function SignInApp({ page }: { page: EntryPageId }) {
  const EntryPage = entryPages[page];
  return (
    <ErrorBoundary
      fullPage
      message="O Polaris não conseguiu abrir. Recarregue a página para tentar de novo."
      onRetry={EntryPage.reset}
    >
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
      <Suspense fallback={<PageLoading fullPage />}>
        <AcceptancePage />
      </Suspense>
    </ErrorBoundary>
  );
}

/** The panel of a closed store stands apart too (ADR 0081): the store no longer opens as a tenant. */
function ClosedStoreApp() {
  return (
    <ErrorBoundary
      fullPage
      message="O Polaris não conseguiu abrir. Recarregue a página para tentar de novo."
      onRetry={ClosedStorePage.reset}
    >
      <Suspense fallback={<PageLoading fullPage />}>
        <ClosedStorePage />
      </Suspense>
    </ErrorBoundary>
  );
}

function StoreApp() {
  // the tab is in the address: a change of tab is a change of route for the shell (the chip, the connection notice)
  const { pathname, search } = useAddress();
  const route = resolveRoute(pathname, search);
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
  if (isClosedStorePath(window.location.pathname)) {
    return <ClosedStoreApp />;
  }
  // a card checkout opened before the return moved to the Assinatura comes back to the root: the same return there
  const checkoutReturn = legacyCheckoutReturnPath(
    window.location.pathname,
    window.location.search
  );
  if (checkoutReturn) {
    window.location.replace(checkoutReturn);
    return null;
  }
  // a screen that became a tab keeps its address (map of navigation, § 6): in place, with no load, so it opens offline
  // from the copy of the shell as well
  const tabAddress = legacyAddress(
    window.location.pathname,
    window.location.search,
    window.location.hash
  );
  if (tabAddress) {
    window.history.replaceState(window.history.state, "", tabAddress);
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
