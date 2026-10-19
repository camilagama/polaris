import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LEGAL_CONTENT_SLUGS,
  LEGAL_DOCUMENT_IDS,
  LEGAL_DOCUMENTS,
  type LegalDocumentId,
  type LegalDocumentVersion,
} from "@polaris/domain/legal/legal-documents";
import { describe, expect, it } from "vitest";
import {
  checkLegalDocuments,
  isProductionBuild,
  sha256Hex,
} from "./legal-guard";

const contentFile = (document: LegalDocumentId, version: number) =>
  fileURLToPath(
    new URL(
      `../src/legal/content/${LEGAL_CONTENT_SLUGS[document]}/v${version}.md`,
      import.meta.url
    )
  );
const readRepositoryText = (document: LegalDocumentId, version: number) => {
  try {
    return readFileSync(contentFile(document, version));
  } catch {
    return null;
  }
};
const encode = (text: string) => new TextEncoder().encode(text);

describe("the texts in the repository", () => {
  it.each(LEGAL_DOCUMENT_IDS)(
    "the file of %s has the hash of its version",
    (document) => {
      const { sha256, version } = LEGAL_DOCUMENTS[document];
      const bytes = readRepositoryText(document, version);
      expect(bytes).not.toBeNull();
      expect(sha256Hex(bytes ?? new Uint8Array())).toBe(sha256);
    }
  );

  it.each(LEGAL_DOCUMENT_IDS)(
    "the file of %s is UTF-8 with LF line ends",
    (document) => {
      const bytes = readRepositoryText(
        document,
        LEGAL_DOCUMENTS[document].version
      );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes ?? new Uint8Array()
      );
      expect(text).not.toContain("\r");
      expect(text.endsWith("\n")).toBe(true);
    }
  );

  it("agree with the constant and the restricted Markdown, which no build mode relaxes", () => {
    const { errors } = checkLegalDocuments({
      production: false,
      readText: readRepositoryText,
    });
    expect(errors).toEqual([]);
  });
});

/** Documents whose constant matches the given texts, as it is after a real publication. */
const publish = (
  texts: Record<LegalDocumentId, string>,
  effectiveFrom: string | null
) => {
  const documents = Object.fromEntries(
    LEGAL_DOCUMENT_IDS.map(
      (document): [LegalDocumentId, LegalDocumentVersion] => [
        document,
        {
          effectiveFrom,
          minAcceptedVersion: 1,
          sha256: sha256Hex(encode(texts[document])),
          version: 1,
        },
      ]
    )
  ) as Record<LegalDocumentId, LegalDocumentVersion>;
  return {
    documents,
    readText: (document: LegalDocumentId) => encode(texts[document]),
  };
};
const finalTexts = {
  privacy: "# Política\n\n## 1. Um\n\nTexto final.\n",
  terms: "# Termos\n\n## 1. Um\n\nTexto final.\n",
};

describe("the markers and the draft notice (AC-9, AC-10)", () => {
  it("let a final text through a production build", () => {
    const result = checkLegalDocuments({
      ...publish(finalTexts, "2026-11-01"),
      draftNotice: null,
      production: true,
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it.each([
    "[preencher: e-mail]",
    "[Preencher]",
    "[confirmar com o usuário antes de publicar: razão social]",
    "[confirmar: razão social]",
  ])(
    "stop a production build that still has %s, and only warn in staging",
    (marker) => {
      const texts = {
        ...finalTexts,
        privacy: `${finalTexts.privacy}\nContato: ${marker}.\n`,
      };
      const input = { ...publish(texts, "2026-11-01"), draftNotice: null };
      const production = checkLegalDocuments({ ...input, production: true });
      expect(production.errors).toHaveLength(1);
      expect(production.errors[0]).toContain("Build de produção");
      expect(production.errors[0]).toContain(marker);
      const staging = checkLegalDocuments({ ...input, production: false });
      expect(staging.errors).toEqual([]);
      expect(staging.warnings).toEqual([`privacy: ${marker}`]);
    }
  );

  it("stop a production build while the effective date is still a marker", () => {
    const input = { ...publish(finalTexts, null), draftNotice: null };
    const production = checkLegalDocuments({ ...input, production: true });
    expect(production.errors).toHaveLength(2);
    expect(production.errors.join("\n")).toContain(
      "[preencher na publicação] (data de vigência)"
    );
    expect(
      checkLegalDocuments({ ...input, production: false }).warnings
    ).toHaveLength(2);
  });

  it("stop a production build while the draft notice exists", () => {
    const input = publish(finalTexts, "2026-11-01");
    const production = checkLegalDocuments({
      ...input,
      draftNotice: "Rascunho.",
      production: true,
    });
    expect(production.errors).toEqual([
      'Build de produção com texto legal ainda não final: aviso de rascunho: "Rascunho.".',
    ]);
  });

  it("today the real texts have markers and the notice, so a production build would stop", () => {
    const { errors } = checkLegalDocuments({
      production: true,
      readText: readRepositoryText,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("the checks that no mode relaxes", () => {
  const input = publish(finalTexts, "2026-11-01");

  it("fail when a text changed and the version constant did not", () => {
    const { errors } = checkLegalDocuments({
      ...input,
      production: false,
      readText: (document) =>
        encode(
          document === "terms"
            ? `${finalTexts.terms}Uma frase nova.\n`
            : finalTexts[document]
        ),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("terms");
    expect(errors[0]).toContain("não bate com o hash da versão 1");
  });

  it("fail when the file of the version in force is missing", () => {
    const { errors } = checkLegalDocuments({
      ...input,
      production: false,
      readText: (document) =>
        document === "privacy" ? null : encode(finalTexts[document]),
    });
    expect(errors).toEqual([
      "privacy: falta o arquivo content/privacidade/v1.md.",
    ]);
  });

  it("fail when a text the page could not render has the right hash", () => {
    const texts = { ...finalTexts, terms: "# Termos\n\n<b>oi</b>\n" };
    const { errors } = checkLegalDocuments({
      ...publish(texts, "2026-11-01"),
      production: false,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("não cabe no Markdown restrito");
  });

  it("fail when two headings would share an anchor", () => {
    const texts = {
      ...finalTexts,
      terms: "# Termos\n\n## 1. Um\n\n## 1. Um\n",
    };
    const { errors } = checkLegalDocuments({
      ...publish(texts, "2026-11-01"),
      production: false,
    });
    expect(errors.join("\n")).toContain("a mesma âncora");
  });

  it("fail when the effective date is neither null nor a day", () => {
    const { errors } = checkLegalDocuments({
      ...publish(finalTexts, "19/10/2026"),
      production: false,
    });
    expect(errors).toHaveLength(2);
  });
});

describe("what is a production build", () => {
  it("is every build the deploy names, except staging; local and CI leave the name empty", () => {
    expect(isProductionBuild({ CLOUDFLARE_ENV: "production" })).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: "Production" })).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: "prod" })).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: "staging" })).toBe(false);
    expect(isProductionBuild({ CLOUDFLARE_ENV: " " })).toBe(false);
    expect(isProductionBuild({})).toBe(false);
  });
});
