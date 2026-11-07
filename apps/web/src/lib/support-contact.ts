import { LEGAL_COMPANY_FIELDS } from "@polaris/domain/legal/legal-company";

/**
 * The one place the app learns the e-mail of the support and of the data protection officer. They are the
 * `VITE_LEGAL_*` variables that fill `{{CONTATO_EMAIL}}` and `{{DPO_EMAIL}}` in the legal texts at build time,
 * so the app and the Terms never say two different addresses. A production build refuses an absent value
 * (`legal-build-guard-plugin.ts`); outside production the example of the field is what the legal texts show,
 * and it is what is shown here.
 */
export interface SupportContact {
  dpoEmail: string;
  supportEmail: string;
}

function fieldValue(
  env: Readonly<Record<string, string | undefined>>,
  variable: string
): string {
  const field = LEGAL_COMPANY_FIELDS.find((item) => item.env === variable);
  if (!field) {
    throw new Error(`campo legal desconhecido: ${variable}`);
  }
  const value = (env[variable] ?? "").trim();
  return value === "" ? field.example : value;
}

export function supportContactOf(
  env: Readonly<Record<string, string | undefined>>
): SupportContact {
  return {
    dpoEmail: fieldValue(env, "VITE_LEGAL_DPO_EMAIL"),
    supportEmail: fieldValue(env, "VITE_LEGAL_CONTATO_EMAIL"),
  };
}

/** A `mailto:` link for an address; the local part is encoded, so a `%` in it is not read as an escape. */
export function mailtoHref(address: string): string {
  const at = address.lastIndexOf("@");
  return `mailto:${encodeURIComponent(address.slice(0, at))}${address.slice(at)}`;
}

const contact = supportContactOf({
  VITE_LEGAL_CONTATO_EMAIL: import.meta.env.VITE_LEGAL_CONTATO_EMAIL,
  VITE_LEGAL_DPO_EMAIL: import.meta.env.VITE_LEGAL_DPO_EMAIL,
});

export const SUPPORT_EMAIL = contact.supportEmail;
export const DPO_EMAIL = contact.dpoEmail;
