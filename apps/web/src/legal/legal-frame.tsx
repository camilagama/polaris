import type { LegalDocumentId } from "@polaris/domain/legal/legal-documents";
import type { ReactNode } from "react";
import { LEGAL_PAGE_TITLES } from "./legal-routes";
import "./legal.css";

/** The brand bar of every legal page, also when the text is not there yet or failed to load. */
function LegalTopbar() {
  return (
    <header className="legal-topbar">
      <a aria-label="Polaris, início" className="app-brand" href="/">
        <span aria-hidden="true" className="app-brand-mark">
          P
        </span>
        <span>Polaris</span>
      </a>
    </header>
  );
}

/** A page of a legal document: brand, title and, inside, the text or the message of a state. */
export function LegalFrame({
  children,
  document,
}: {
  children: ReactNode;
  document: LegalDocumentId;
}) {
  return (
    <div className="ui-root legal-root">
      <LegalTopbar />
      <main className="legal-main" id="conteudo">
        <article aria-labelledby="legal-title">
          <h1 id="legal-title">{LEGAL_PAGE_TITLES[document]}</h1>
          {children}
        </article>
      </main>
    </div>
  );
}

/** The wait for the text: the brand and the title are already there. */
export function LegalLoading({ document }: { document: LegalDocumentId }) {
  return (
    <LegalFrame document={document}>
      <p className="legal-state" role="status">
        Carregando…
      </p>
    </LegalFrame>
  );
}

/** The text could not be opened: says why and offers a new try. */
export function LegalLoadFailure({
  document,
  offline,
  onRetry,
}: {
  document: LegalDocumentId;
  offline: boolean;
  onRetry: () => void;
}) {
  return (
    <LegalFrame document={document}>
      <p className="legal-state" role="alert">
        {offline
          ? "Sem conexão. Abra de novo quando a internet voltar."
          : "Não foi possível abrir esta página. Tente de novo."}
      </p>
      <button className="primary-button" onClick={onRetry} type="button">
        Tentar novamente
      </button>
    </LegalFrame>
  );
}
