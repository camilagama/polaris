import {
  LEGAL_DOCUMENT_IDS,
  LEGAL_PATHS,
  type LegalDocumentId,
} from "@polaris/domain/legal/legal-documents";

const trailingSlashes = /\/+$/;

export const LEGAL_PAGE_TITLES: Readonly<Record<LegalDocumentId, string>> =
  Object.freeze({
    privacy: "Política de Privacidade",
    terms: "Termos de Uso",
  });

/**
 * The legal document a pathname opens, or null for any other address. These pages are public:
 * they open without a session and without an organization, outside the shell of the store.
 */
export function resolveLegalRoute(pathname: string): LegalDocumentId | null {
  const normalized = pathname.replace(trailingSlashes, "") || "/";
  return (
    LEGAL_DOCUMENT_IDS.find(
      (document) => LEGAL_PATHS[document] === normalized
    ) ?? null
  );
}
