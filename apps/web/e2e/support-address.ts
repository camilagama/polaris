import { LEGAL_COMPANY_FIELDS } from "@polaris/domain/legal/legal-company";

const field = LEGAL_COMPANY_FIELDS.find(
  (item) => item.env === "VITE_LEGAL_CONTATO_EMAIL"
);

/** The address the build under test carries: `VITE_LEGAL_CONTATO_EMAIL`, or the example the Terms show without it. */
export const SUPPORT_ADDRESS =
  (process.env.VITE_LEGAL_CONTATO_EMAIL ?? "").trim() || (field?.example ?? "");
