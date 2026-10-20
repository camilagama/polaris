import { LEGAL_DOCUMENTS } from "@polaris/domain/legal/legal-documents";

/** The `legalAcceptance` of a sign-up that accepts the versions in force (tests only). */
export const SIGN_UP_LEGAL_ACCEPTANCE = Object.freeze({
  privacy: LEGAL_DOCUMENTS.privacy.version,
  terms: LEGAL_DOCUMENTS.terms.version,
});
