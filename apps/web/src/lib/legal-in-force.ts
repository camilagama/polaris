import {
  LEGAL_DOCUMENTS,
  withEffectiveFromFallback,
} from "@polaris/domain/legal/legal-documents";

/**
 * The legal documents as this build shows them: the constant, with the day they came into force taken
 * from the public `VITE_LEGAL_VIGENCIA` variable while the constant has none. The pages and the
 * acceptance screen read this one, so the two never show different days. The variable is for staging:
 * the production build guard refuses a build whose constant has no day, whatever the variable says
 * (`legal-guard.ts`); outside production an absent variable keeps the marker of the draft.
 */
export const LEGAL_DOCUMENTS_IN_FORCE = withEffectiveFromFallback(
  LEGAL_DOCUMENTS,
  import.meta.env.VITE_LEGAL_VIGENCIA
);
