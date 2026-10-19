import type { LegalDocumentId } from "@polaris/domain/legal/legal-documents";
import { Component, lazy, type ReactNode, Suspense, useEffect } from "react";
import { documentTitle } from "../app-shell/navigation-model";
import { LEGAL_PAGE_TITLES } from "./legal-routes";

/** The text and the renderer are their own chunk, kept by the service worker, so the page opens offline. */
const LegalPage = lazy(() =>
  import("./legal-page").then((module) => ({ default: module.LegalPage }))
);

function failureMessage(): string {
  return navigator.onLine
    ? "Não foi possível abrir esta página. Tente de novo."
    : "Sem conexão. Abra de novo quando a internet voltar.";
}

/**
 * A page that cannot load says so and offers a retry. The retry reloads the page: a chunk that
 * failed to load stays failed for `lazy`, so only a new load gives it another chance.
 */
class LegalLoadBoundary extends Component<
  { children: ReactNode },
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
      <div className="ui-root">
        <main className="categories-content" id="conteudo">
          <p role="alert">{failureMessage()}</p>
          <button
            className="primary-button"
            onClick={this.handleRetry}
            type="button"
          >
            Tentar novamente
          </button>
        </main>
      </div>
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
    <LegalLoadBoundary>
      <Suspense
        fallback={
          <p className="app-status" role="status">
            Carregando…
          </p>
        }
      >
        <LegalPage document={document} />
      </Suspense>
    </LegalLoadBoundary>
  );
}
