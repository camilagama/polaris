import { createHash } from "node:crypto";
import {
  fillLegalCompanyFields,
  findUnfilledFields,
  LEGAL_COMPANY_FIELDS,
  type LegalCompanyValues,
} from "@polaris/domain/legal/legal-company";
import {
  findPendingMarkers,
  LEGAL_CONTENT_SLUGS,
  LEGAL_DOCUMENT_IDS,
  LEGAL_DOCUMENTS,
  LEGAL_DRAFT_NOTICE,
  type LegalDocumentId,
  type LegalDocumentVersion,
  legalVersionLine,
} from "@polaris/domain/legal/legal-documents";
import { parseMarkdown } from "../src/legal/markdown";

/**
 * The checks of the legal texts that the build runs (ADR 0100). They are a function of the text and
 * of the build mode so a test can run them on any input.
 *
 * Always: each document has the text of the version in force, and the SHA-256 of that text is the
 * one in the constant (so a text that changed without a new version, or a constant that was not
 * updated, stops the build), and the text parses with the restricted Markdown (so a text the page
 * cannot render never reaches a user). The hash is the one of the template, with its `{{FICHA}}`
 * tokens, and the text that must parse is the filled one: the company data comes from the `VITE_LEGAL_*`
 * variables and never changes a version. Production (see `isProductionBuild`) only: no `[preencher...]` or `[confirmar com o usuário antes
 * de publicar...]` marker left in the text, in the version line or in a value, no `{{` token left in
 * the final text, a value for each variable (an e-mail where it must be one), and no draft notice.
 * Staging may carry the markers, and the page shows them; where a variable is absent it shows an example.
 */
export interface LegalGuardInput {
  /** The `VITE_LEGAL_*` variables of the build, which fill the tokens of the templates. */
  company: LegalCompanyEnv;
  /** The constant under check; the real one unless a test brings its own. */
  documents?: Readonly<Record<LegalDocumentId, LegalDocumentVersion>>;
  /** The draft notice under check; the real one unless a test brings its own. */
  draftNotice?: string | null;
  /** The bytes of `content/<slug>/v<version>.md`, or null when the file does not exist. */
  readText: (document: LegalDocumentId, version: number) => Uint8Array | null;
  production: boolean;
}

export interface LegalGuardResult {
  /** What stops the build. */
  errors: string[];
  /** What only staging may carry: reported, not blocking. */
  warnings: string[];
}

const calendarDate = /^\d{4}-\d{2}-\d{2}$/;
const emailAddress = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const markdownOrLineBreak = /[\r\n*[\]<>|`]/;

export type LegalCompanyEnv = Readonly<Record<string, string | undefined>>;

/**
 * The build that carries the pending markers of the legal texts says so twice: `CLOUDFLARE_ENV` is
 * `staging`, or it is empty and `LEGAL_DRAFT_BUILD` is `1` (the `build` script of the app sets it, so
 * local and CI builds work). Everything else is production and refuses them: a missing, empty or
 * unknown `CLOUDFLARE_ENV` never loosens the check, so a typo in the name or a build with no
 * environment cannot publish a draft.
 */
export function isProductionBuild(env: Record<string, string | undefined>) {
  const name = (env.CLOUDFLARE_ENV ?? "").trim().toLowerCase();
  if (name === "staging") {
    return false;
  }
  return !(name === "" && env.LEGAL_DRAFT_BUILD === "1");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Outside production an absent variable takes its example; in production it is a problem. */
export function legalCompanyValues(
  env: LegalCompanyEnv,
  production: boolean
): { problems: string[]; values: LegalCompanyValues } {
  const problems: string[] = [];
  const values: Record<string, string> = {};
  for (const { env: name, example, kind, token } of LEGAL_COMPANY_FIELDS) {
    const value = (env[name] ?? "").trim();
    if (value === "") {
      if (production) {
        problems.push(`variável ${name} ausente ou vazia`);
      } else {
        values[token] = example;
      }
      continue;
    }
    values[token] = value;
    if (findPendingMarkers(value).length > 0) {
      problems.push(`variável ${name} com marcador pendente: "${value}"`);
    } else if (value.includes("{{") || markdownOrLineBreak.test(value)) {
      problems.push(
        `variável ${name} com ficha, quebra de linha ou caractere de Markdown`
      );
    } else if (kind === "email" && !emailAddress.test(value)) {
      problems.push(`variável ${name} não é um e-mail válido`);
    }
  }
  return { problems, values };
}

export function checkLegalDocuments(input: LegalGuardInput): LegalGuardResult {
  const documents = input.documents ?? LEGAL_DOCUMENTS;
  const draftNotice =
    input.draftNotice === undefined ? LEGAL_DRAFT_NOTICE : input.draftNotice;
  const errors: string[] = [];
  const company = legalCompanyValues(input.company, input.production);
  const pending: string[] = [...company.problems];
  for (const document of LEGAL_DOCUMENT_IDS) {
    const { effectiveFrom, sha256, version } = documents[document];
    const where = `content/${LEGAL_CONTENT_SLUGS[document]}/v${version}.md`;
    if (effectiveFrom !== null && !calendarDate.test(effectiveFrom)) {
      errors.push(`${document}: effectiveFrom deve ser AAAA-MM-DD ou null.`);
    }
    const bytes = input.readText(document, version);
    if (bytes === null) {
      errors.push(`${document}: falta o arquivo ${where}.`);
      continue;
    }
    if (sha256Hex(bytes) !== sha256) {
      errors.push(
        `${document}: o texto de ${where} não bate com o hash da versão ${version}. ` +
          "Texto mudado pede versão nova (e hash novo) em packages/domain/src/legal/legal-documents.ts."
      );
    }
    const template = new TextDecoder().decode(bytes);
    const text = fillLegalCompanyFields(template, company.values);
    try {
      const ids = parseMarkdown(text).flatMap((block) =>
        block.kind === "heading" ? [block.id] : []
      );
      if (new Set(ids).size !== ids.length) {
        errors.push(
          `${document}: dois títulos com a mesma âncora em ${where}.`
        );
      }
    } catch (error) {
      errors.push(
        `${document}: ${where} não cabe no Markdown restrito: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    pending.push(
      ...findPendingMarkers(template).map((marker) => `${document}: ${marker}`),
      ...findUnfilledFields(text).map(
        (field) => `${document}: ficha sem valor ${field}`
      ),
      ...findPendingMarkers(legalVersionLine(document, documents)).map(
        (marker) => `${document}: ${marker} (data de vigência)`
      )
    );
  }
  if (draftNotice !== null) {
    pending.push(`aviso de rascunho: "${draftNotice}"`);
  }
  if (input.production) {
    errors.push(
      ...pending.map(
        (item) => `Build de produção com texto legal ainda não final: ${item}.`
      )
    );
    return { errors, warnings: [] };
  }
  return { errors, warnings: pending };
}
