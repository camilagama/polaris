import {
  LEGAL_CONTENT_SLUGS,
  LEGAL_DOCUMENTS,
  type LegalDocumentId,
} from "@polaris/domain/legal/legal-documents";

/** Every archived text, by path; the build reads them as plain strings. */
const texts = import.meta.glob<string>("./content/*/v*.md", {
  eager: true,
  import: "default",
  query: "?raw",
});

/** The text of the version in force of a document. */
export function currentLegalText(document: LegalDocumentId): string {
  const { version } = LEGAL_DOCUMENTS[document];
  const text =
    texts[`./content/${LEGAL_CONTENT_SLUGS[document]}/v${version}.md`];
  if (text === undefined) {
    throw new Error(`Falta o texto da versão ${version} de ${document}.`);
  }
  return text;
}
