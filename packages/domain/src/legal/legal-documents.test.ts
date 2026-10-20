import { describe, expect, it } from "vitest";
import {
  findPendingMarkers,
  formatEffectiveFrom,
  isLegalDocumentId,
  LEGAL_DOCUMENT_IDS,
  LEGAL_DOCUMENTS,
  LEGAL_PATHS,
  legalVersionLine,
  pendingLegalDocuments,
} from "./legal-documents";

const sha256Pattern = /^[0-9a-f]{64}$/;
const pathPattern = /^\/[a-z]+$/;

describe("the legal documents constant", () => {
  it.each(LEGAL_DOCUMENT_IDS)(
    "%s has a version, a hash and a public page",
    (document) => {
      const { minAcceptedVersion, sha256, version } = LEGAL_DOCUMENTS[document];
      expect(Number.isInteger(version) && version > 0).toBe(true);
      expect(minAcceptedVersion).toBeGreaterThan(0);
      expect(minAcceptedVersion).toBeLessThanOrEqual(version);
      expect(sha256).toMatch(sha256Pattern);
      expect(LEGAL_PATHS[document]).toMatch(pathPattern);
    }
  );

  it("is immutable, so no code can change what the acceptance records", () => {
    expect(Object.isFrozen(LEGAL_DOCUMENTS)).toBe(true);
    for (const document of LEGAL_DOCUMENT_IDS) {
      expect(Object.isFrozen(LEGAL_DOCUMENTS[document])).toBe(true);
    }
  });
});

describe("the version line", () => {
  it("writes the day as dd/mm/aaaa, with no time zone shifting it", () => {
    expect(formatEffectiveFrom("2026-10-19")).toBe("19/10/2026");
    expect(formatEffectiveFrom("2027-01-01")).toBe("01/01/2027");
  });

  it("carries the marker while the day is still to be filled in", () => {
    expect(legalVersionLine("terms")).toBe(
      "Versão 1. Em vigor desde: [preencher na publicação]."
    );
    expect(findPendingMarkers(legalVersionLine("privacy"))).toEqual([
      "[preencher na publicação]",
    ]);
  });
});

describe("pending markers", () => {
  it("finds both kinds, with or without an explanation", () => {
    expect(
      findPendingMarkers(
        "a [preencher] b [preencher: e-mail] c [confirmar com o usuário antes de publicar: razão] d"
      )
    ).toEqual([
      "[preencher]",
      "[preencher: e-mail]",
      "[confirmar com o usuário antes de publicar: razão]",
    ]);
  });

  it("finds a marker whatever its case, wording or closing (AC-9)", () => {
    expect(
      findPendingMarkers(
        "[Preencher] [confirmar: razão] [ confirmar com o usuario] [preencher sem fechar"
      )
    ).toEqual([
      "[Preencher]",
      "[confirmar: razão]",
      "[ confirmar com o usuario]",
      "[preencher sem fechar",
    ]);
  });

  it("ignores ordinary brackets and an empty text", () => {
    expect(findPendingMarkers("[1] e [outro]")).toEqual([]);
    expect(findPendingMarkers("")).toEqual([]);
  });
});

describe("the documents still to accept", () => {
  const documents = {
    privacy: { ...LEGAL_DOCUMENTS.privacy, minAcceptedVersion: 2, version: 3 },
    terms: { ...LEGAL_DOCUMENTS.terms, minAcceptedVersion: 1, version: 2 },
  };

  it("asks for both documents from someone who accepted nothing", () => {
    expect(pendingLegalDocuments({})).toEqual(["terms", "privacy"]);
    expect(pendingLegalDocuments({}, documents)).toEqual(["terms", "privacy"]);
  });

  it("asks only for a document below its floor, not for one below the version in force (L5)", () => {
    expect(pendingLegalDocuments({ privacy: 1, terms: 1 }, documents)).toEqual([
      "privacy",
    ]);
    expect(pendingLegalDocuments({ privacy: 2, terms: 1 }, documents)).toEqual(
      []
    );
  });

  it("lets through someone who accepted the versions in force", () => {
    expect(
      pendingLegalDocuments({
        privacy: LEGAL_DOCUMENTS.privacy.version,
        terms: LEGAL_DOCUMENTS.terms.version,
      })
    ).toEqual([]);
  });

  it("says what changed for every version after the first (L5)", () => {
    for (const document of LEGAL_DOCUMENT_IDS) {
      const { changes, version } = LEGAL_DOCUMENTS[document];
      if (version > 1) {
        expect(changes?.trim()).toBeTruthy();
      }
    }
  });

  it("recognizes only the two documents", () => {
    expect(isLegalDocumentId("terms")).toBe(true);
    expect(isLegalDocumentId("privacy")).toBe(true);
    expect(isLegalDocumentId("cookies")).toBe(false);
    expect(isLegalDocumentId(1)).toBe(false);
  });
});
