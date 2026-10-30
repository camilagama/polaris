import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  fillLegalCompanyFields,
  findUnfilledFields,
  LEGAL_COMPANY_FIELDS,
} from "@polaris/domain/legal/legal-company";
import {
  LEGAL_CONTENT_SLUGS,
  LEGAL_DOCUMENT_IDS,
  LEGAL_DOCUMENTS,
  LEGAL_DRAFT_NOTICE,
  type LegalDocumentId,
  type LegalDocumentVersion,
} from "@polaris/domain/legal/legal-documents";
import { describe, expect, it } from "vitest";
import {
  checkLegalDocuments,
  isProductionBuild,
  legalCompanyValues,
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
const pendingMarkerStart = /\[\s*(?:preencher|confirmar)/iu;
const encode = (text: string) => new TextEncoder().encode(text);
const company = {
  VITE_LEGAL_CONTATO_EMAIL: "contato@empresa.com.br",
  VITE_LEGAL_DPO_EMAIL: "dpo@empresa.com.br",
  VITE_LEGAL_ENDERECO: "Rua das Flores, 10, Centro",
  VITE_LEGAL_RAZAO_SOCIAL: "Agência Summit Serviços Digitais Ltda.",
};

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
      company: {},
      production: false,
      readText: readRepositoryText,
    });
    expect(errors).toEqual([]);
  });

  it.each(LEGAL_DOCUMENT_IDS)(
    "the hash of %s is the one of the template, with its tokens, and not of the filled text",
    (document) => {
      const { sha256, version } = LEGAL_DOCUMENTS[document];
      const bytes = readRepositoryText(document, version) ?? new Uint8Array();
      const template = new TextDecoder().decode(bytes);
      expect(findUnfilledFields(template).length).toBeGreaterThan(0);
      expect(sha256Hex(bytes)).toBe(sha256);
      const { values } = legalCompanyValues(company, true);
      const filled = fillLegalCompanyFields(template, values);
      expect(findUnfilledFields(filled)).toEqual([]);
      expect(sha256Hex(encode(filled))).not.toBe(sha256);
    }
  );

  it("carry each of the four tokens of the company, and no pending marker of its own", () => {
    const templates = LEGAL_DOCUMENT_IDS.map((document) =>
      new TextDecoder().decode(
        readRepositoryText(document, LEGAL_DOCUMENTS[document].version) ??
          new Uint8Array()
      )
    ).join("\n");
    for (const { token } of LEGAL_COMPANY_FIELDS) {
      expect(templates).toContain(token);
    }
    expect(templates).not.toMatch(pendingMarkerStart);
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
          changes: null,
          effectiveFrom,
          minAcceptedVersion: 1,
          sha256: sha256Hex(encode(texts[document])),
          version: 1,
        },
      ]
    )
  ) as Record<LegalDocumentId, LegalDocumentVersion>;
  return {
    company,
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

  it("today the real texts, with every variable set, stop a production build only for the draft notice and the effective date", () => {
    const { errors } = checkLegalDocuments({
      company,
      production: true,
      readText: readRepositoryText,
    });
    expect(errors).toEqual([
      "Build de produção com texto legal ainda não final: terms: [preencher na publicação] (data de vigência).",
      "Build de produção com texto legal ainda não final: privacy: [preencher na publicação] (data de vigência).",
      `Build de produção com texto legal ainda não final: aviso de rascunho: "${LEGAL_DRAFT_NOTICE}".`,
    ]);
  });
});

describe("the company variables (VITE_LEGAL_*)", () => {
  const templates = {
    privacy: "# Política\n\n## 1. Um\n\nDPO: **{{DPO_EMAIL}}**.\n",
    terms:
      "# Termos\n\n## 1. Um\n\n**{{EMPRESA_RAZAO_SOCIAL}}**, **{{EMPRESA_ENDERECO}}**, **{{CONTATO_EMAIL}}**.\n",
  };
  const run = (env: Record<string, string | undefined>, production: boolean) =>
    checkLegalDocuments({
      ...publish(templates, "2026-11-01"),
      company: env,
      draftNotice: null,
      production,
    });

  it("let a production build through when every variable is a valid public value", () => {
    expect(run(company, true)).toEqual({ errors: [], warnings: [] });
  });

  it.each(Object.keys(company))(
    "stop a production build when %s is missing, empty or only spaces",
    (name) => {
      for (const value of [undefined, "", "   "]) {
        const { errors } = run({ ...company, [name]: value }, true);
        expect(errors.join("\n")).toContain(
          `Build de produção com texto legal ainda não final: variável ${name} ausente ou vazia.`
        );
      }
    }
  );

  it("name every missing variable when none is set", () => {
    const { errors } = run({}, true);
    for (const name of Object.keys(company)) {
      expect(errors.join("\n")).toContain(name);
    }
  });

  it("stop a production build that still has a token in the final text", () => {
    const texts = {
      ...templates,
      terms: `${templates.terms}\nOutro: {{OUTRA_FICHA}}.\n`,
    };
    const input = { ...publish(texts, "2026-11-01"), draftNotice: null };
    const production = checkLegalDocuments({
      ...input,
      company,
      production: true,
    });
    expect(production.errors).toEqual([
      "Build de produção com texto legal ainda não final: terms: ficha sem valor {{OUTRA_FICHA}}.",
    ]);
    const staging = checkLegalDocuments({
      ...input,
      company,
      production: false,
    });
    expect(staging.errors).toEqual([]);
    expect(staging.warnings).toEqual([
      "terms: ficha sem valor {{OUTRA_FICHA}}",
    ]);
  });

  it.each([
    "[preencher: e-mail]",
    "[confirmar com o usuário antes de publicar]",
    "[Preencher",
  ])("stop a production build when a value carries the marker %s", (marker) => {
    const { errors } = run(
      { ...company, VITE_LEGAL_RAZAO_SOCIAL: `Summit ${marker}` },
      true
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "VITE_LEGAL_RAZAO_SOCIAL com marcador pendente"
    );
  });

  it.each([
    "dpo@",
    "dpo",
    "dpo@empresa",
    "dpo empresa@x.com",
    "a@b@c.com",
    "dpo@empresa.c",
  ])("stop a production build when the e-mail %j is not valid", (value) => {
    for (const name of ["VITE_LEGAL_CONTATO_EMAIL", "VITE_LEGAL_DPO_EMAIL"]) {
      const { errors } = run({ ...company, [name]: value }, true);
      expect(errors.join("\n")).toContain(`${name} não é um e-mail válido`);
    }
  });

  it.each([
    "Rua A\nRua B",
    "Rua **A**",
    "Rua [A](/x)",
    "Rua <b>A</b>",
    "{{DPO_EMAIL}}",
    "Rua\tA",
    "Rua A",
    "Rua‮A",
  ])(
    "stop a production build when the value %j would change the Markdown or the tokens",
    (value) => {
      const { errors } = run({ ...company, VITE_LEGAL_ENDERECO: value }, true);
      expect(errors.join("\n")).toContain("VITE_LEGAL_ENDERECO");
    }
  );

  it("show examples that say so, with no error, where staging has no variable", () => {
    const { values } = legalCompanyValues({}, false);
    expect(Object.keys(values).sort()).toEqual(
      LEGAL_COMPANY_FIELDS.map((field) => field.token).sort()
    );
    expect(values["{{EMPRESA_RAZAO_SOCIAL}}"]).toContain("exemplo");
    expect(values["{{EMPRESA_ENDERECO}}"]).toContain("exemplo");
    expect(values["{{CONTATO_EMAIL}}"]).toContain("exemplo");
    expect(values["{{DPO_EMAIL}}"]).toContain("exemplo");
    expect(run({}, false)).toEqual({ errors: [], warnings: [] });
  });

  it.each([
    "Razão Social de Exemplo Ltda. (exemplo)",
    "Empresa Exemplo Ltda.",
    "contato@example.com",
    "contato@example.org",
  ])("stop a production build that carries the example %j", (value) => {
    for (const name of Object.keys(company)) {
      const { errors } = run({ ...company, [name]: value }, true);
      expect(errors.join("\n")).toContain(
        `variável ${name} com valor de exemplo`
      );
    }
  });

  it("let the examples through staging, which shows them on purpose", () => {
    expect(
      run(
        { ...company, VITE_LEGAL_DPO_EMAIL: "dpo-exemplo@example.com" },
        false
      )
    ).toEqual({ errors: [], warnings: [] });
  });

  it("keep the examples out of a production build that has no variable", () => {
    expect(legalCompanyValues({}, true).values).toEqual({});
  });

  it("only warn in staging about a value that still has a marker or is not an e-mail", () => {
    const result = run(
      {
        ...company,
        VITE_LEGAL_DPO_EMAIL: "dpo@",
        VITE_LEGAL_RAZAO_SOCIAL: "[confirmar]",
      },
      false
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(2);
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
  it("is every build the deploy names, except staging", () => {
    expect(isProductionBuild({ CLOUDFLARE_ENV: "production" })).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: "Production" })).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: "prod" })).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: "staging" })).toBe(false);
    expect(isProductionBuild({ CLOUDFLARE_ENV: " Staging " })).toBe(false);
  });

  it("fails closed: no environment, an empty one or an unknown one is production", () => {
    expect(isProductionBuild({})).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: "" })).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: " " })).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: undefined })).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: "stagin" })).toBe(true);
    expect(isProductionBuild({ CLOUDFLARE_ENV: "preview" })).toBe(true);
  });

  it("lets a build with no environment carry markers only when it says LEGAL_DRAFT_BUILD=1", () => {
    expect(isProductionBuild({ LEGAL_DRAFT_BUILD: "1" })).toBe(false);
    expect(
      isProductionBuild({ CLOUDFLARE_ENV: "", LEGAL_DRAFT_BUILD: "1" })
    ).toBe(false);
    expect(isProductionBuild({ LEGAL_DRAFT_BUILD: "true" })).toBe(true);
    expect(isProductionBuild({ LEGAL_DRAFT_BUILD: "0" })).toBe(true);
  });

  it("never lets LEGAL_DRAFT_BUILD loosen a named or unknown environment", () => {
    expect(
      isProductionBuild({
        CLOUDFLARE_ENV: "production",
        LEGAL_DRAFT_BUILD: "1",
      })
    ).toBe(true);
    expect(
      isProductionBuild({ CLOUDFLARE_ENV: "stagin", LEGAL_DRAFT_BUILD: "1" })
    ).toBe(true);
  });

  it("blocks the pending markers when the environment is empty or unknown", () => {
    const texts = {
      privacy: "# P\n\n## 1. Um\n\nContato: **[preencher: e-mail]**.\n",
      terms: finalTexts.terms,
    };
    for (const env of [
      {},
      { CLOUDFLARE_ENV: "" },
      { CLOUDFLARE_ENV: "oops" },
    ]) {
      const result = checkLegalDocuments({
        ...publish(texts, "2026-11-01"),
        draftNotice: null,
        production: isProductionBuild(env),
      });
      expect(result.errors.join("\n")).toContain("[preencher: e-mail]");
    }
    const staging = checkLegalDocuments({
      ...publish(texts, "2026-11-01"),
      draftNotice: null,
      production: isProductionBuild({ CLOUDFLARE_ENV: "staging" }),
    });
    expect(staging.errors).toEqual([]);
    expect(staging.warnings.join("\n")).toContain("[preencher: e-mail]");
  });
});
