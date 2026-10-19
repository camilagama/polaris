import type { LegalDocumentId } from "@polaris/domain/legal/legal-documents";
import { Component, lazy, type ReactNode, Suspense, useEffect } from "react";
import { documentTitle } from "../app-shell/navigation-model";
import { LegalLoadFailure, LegalLoading } from "./legal-frame";
import { LEGAL_PAGE_TITLES } from "./legal-routes";

/** The text and the renderer are their own chunk, kept by the service worker, so the page opens offline. */
const LegalPage = lazy(() =>
  import("./legal-page").then((module) => ({ default: module.LegalPage }))
);

/**
 * A page that cannot load says so and offers a retry. The retry reloads the page: a chunk that
 * failed to load stays failed for `lazy`, so only a new load gives it another chance.
 */
class LegalLoadBoundary extends Component<
  { children: ReactNode; document: LegalDocumentId },
  { failed: boolean }
> {
  override state: { failed: boolean } = { failed: false };

  readonly handleRetry = () => window.location.reload();

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <LegalLoadFailure
        document={this.props.document}
        offline={!navigator.onLine}
        onRetry={this.handleRetry}
      />
    );
  }
}

/**
 * A legal page, outside the shell of the store: no menu, no organization, no session, and no request
 * of its own. It sets nothing on the device either.
 */
export function LegalApp({ document }: { document: LegalDocumentId }) {
  const title = LEGAL_PAGE_TITLES[document];
  useEffect(() => {
    window.document.title = documentTitle(title);
  }, [title]);
  return (
    <LegalLoadBoundary document={document}>
      <Suspense fallback={<LegalLoading document={document} />}>
        <LegalPage document={document} />
      </Suspense>
    </LegalLoadBoundary>
  );
}
