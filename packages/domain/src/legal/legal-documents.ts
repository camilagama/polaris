/**
 * The published legal documents (Terms of Use and Privacy Policy): the single place that says which
 * version is in force, since when, and which text it is. The legal pages show it and the
 * acceptance records it (ADR 0100), so the two can never disagree.
 *
 * The text of each version lives in `apps/web/src/legal/content/<slug>/v<N>.md` and never changes
 * after it is published: a changed text is a new version. `sha256` is the SHA-256 of the bytes of
 * that file (UTF-8, LF); a test and the production build fail when the file and this constant differ.
 */
export const LEGAL_DOCUMENT_IDS = Object.freeze(["terms", "privacy"] as const);

export type LegalDocumentId = (typeof LEGAL_DOCUMENT_IDS)[number];

export interface LegalDocumentVersion {
  /**
   * What changed from the previous version, in two or three lines for the acceptance screen;
   * `null` only for the first version, which has nothing to compare with.
   */
  changes: string | null;
  /**
   * The day (YYYY-MM-DD, Brasília) the version came into force; `null` while it is only a draft
   * and the day is still to be filled in at publication.
   */
  effectiveFrom: string | null;
  /** The oldest version that still counts as accepted: a lower one asks for a new acceptance. */
  minAcceptedVersion: number;
  /** SHA-256 (lowercase hex) of the bytes of `content/<slug>/v<version>.md`. */
  sha256: string;
  version: number;
}

export const LEGAL_DOCUMENTS: Readonly<
  Record<LegalDocumentId, LegalDocumentVersion>
> = Object.freeze({
  privacy: Object.freeze({
    changes: null,
    effectiveFrom: null,
    minAcceptedVersion: 1,
    sha256: "966a0f8962c7818267e6298a6700d14bb681414c4dc64f1afb3fee3fdc6e9c65",
    version: 1,
  }),
  terms: Object.freeze({
    changes: null,
    effectiveFrom: null,
    minAcceptedVersion: 1,
    sha256: "718c0edfc8774270b985d2935f22be7f95fad8a27035e4a8d20890d543aee43c",
    version: 1,
  }),
});

/** The notice shown on a legal page while no lawyer has reviewed the text. A production build refuses it. */
export const LEGAL_DRAFT_NOTICE: string | null =
  "Rascunho escrito pelos bots; recomendável revisão de advogado antes do go-live.";

/** The text of a marker that waits for someone to fill it in at publication. */
export const LEGAL_PENDING_EFFECTIVE_FROM = "[preencher na publicação]";

/** The pages of each document. */
export const LEGAL_PATHS: Readonly<Record<LegalDocumentId, string>> =
  Object.freeze({ privacy: "/privacidade", terms: "/termos" });

/** The directory of each document under `content/`. */
export const LEGAL_CONTENT_SLUGS: Readonly<Record<LegalDocumentId, string>> =
  Object.freeze({ privacy: "privacidade", terms: "termos" });

/**
 * The markers that mean "not final": any `[preencher…` or `[confirmar…` (AC-9), closed or not, in
 * any case. They may show in staging, never in a production build.
 */
const PENDING_MARKER = /\[\s*(?:preencher|confirmar)[^\]\n]*\]?/giu;

/** The pending markers found in a text, in order. */
export function findPendingMarkers(text: string): string[] {
  return text.match(PENDING_MARKER) ?? [];
}

/** dd/mm/aaaa for a day written as YYYY-MM-DD, with no time zone involved. */
export function formatEffectiveFrom(effectiveFrom: string): string {
  const [year, month, day] = effectiveFrom.split("-");
  return `${day}/${month}/${year}`;
}

/** "Versão 1. Em vigor desde: 19/10/2026." (or the marker, while it is a draft). */
export function legalVersionLine(
  document: LegalDocumentId,
  documents: Readonly<
    Record<LegalDocumentId, LegalDocumentVersion>
  > = LEGAL_DOCUMENTS
): string {
  const { effectiveFrom, version } = documents[document];
  return `Versão ${version}. Em vigor desde: ${
    effectiveFrom === null
      ? LEGAL_PENDING_EFFECTIVE_FROM
      : formatEffectiveFrom(effectiveFrom)
  }.`;
}

/** The highest version of each document a user accepted; a document never accepted is absent. */
export type AcceptedLegalVersions = Readonly<
  Partial<Record<LegalDocumentId, number>>
>;

/**
 * The documents a user still has to accept before using the app (ADR 0100): those whose highest
 * accepted version is below `minAcceptedVersion`. Raising only the version in force asks nobody
 * again; raising the floor does. In the order of `LEGAL_DOCUMENT_IDS`.
 */
export function pendingLegalDocuments(
  accepted: AcceptedLegalVersions,
  documents: Readonly<
    Record<LegalDocumentId, LegalDocumentVersion>
  > = LEGAL_DOCUMENTS
): LegalDocumentId[] {
  return LEGAL_DOCUMENT_IDS.filter(
    (document) =>
      (accepted[document] ?? 0) < documents[document].minAcceptedVersion
  );
}

/** Whether a value names one of the legal documents. */
export function isLegalDocumentId(value: unknown): value is LegalDocumentId {
  return (
    typeof value === "string" &&
    (LEGAL_DOCUMENT_IDS as readonly string[]).includes(value)
  );
}
