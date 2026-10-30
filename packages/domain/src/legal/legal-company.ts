/**
 * The company data the legal texts carry as `{{FICHA}}` tokens, filled at build time from public
 * `VITE_*` variables (they reach the browser). The SHA-256 of a version is the one of the template,
 * so changing a value is a new deploy and never a new version.
 */
export const LEGAL_COMPANY_FIELDS = Object.freeze([
  Object.freeze({
    env: "VITE_LEGAL_RAZAO_SOCIAL",
    example: "Razão Social de Exemplo Ltda. (exemplo)",
    kind: "text",
    token: "{{EMPRESA_RAZAO_SOCIAL}}",
  }),
  Object.freeze({
    env: "VITE_LEGAL_ENDERECO",
    example: "Rua de Exemplo, 100 (endereço de exemplo)",
    kind: "text",
    token: "{{EMPRESA_ENDERECO}}",
  }),
  Object.freeze({
    env: "VITE_LEGAL_CONTATO_EMAIL",
    example: "contato-exemplo@example.com",
    kind: "email",
    token: "{{CONTATO_EMAIL}}",
  }),
  Object.freeze({
    env: "VITE_LEGAL_DPO_EMAIL",
    example: "dpo-exemplo@example.com",
    kind: "email",
    token: "{{DPO_EMAIL}}",
  }),
] as const);

export type LegalCompanyField = (typeof LEGAL_COMPANY_FIELDS)[number];

export type LegalCompanyValues = Readonly<Record<string, string>>;

/** Replaces every known token of a template by its value; a token with no value stays as it is. */
export function fillLegalCompanyFields(
  template: string,
  values: LegalCompanyValues
): string {
  let text = template;
  for (const { token } of LEGAL_COMPANY_FIELDS) {
    const value = values[token];
    if (value !== undefined) {
      text = text.replaceAll(token, () => value);
    }
  }
  return text;
}

const UNFILLED_FIELD = /\{\{[^\n}]*(?:\}\}?)?/gu;

/** The `{{...}}` tokens still in a text, closed or not, in order. */
export function findUnfilledFields(text: string): string[] {
  return text.match(UNFILLED_FIELD) ?? [];
}
