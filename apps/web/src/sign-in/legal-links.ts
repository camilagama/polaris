/**
 * The links to the privacy policy and the terms of use (AC-36). The pages are the P6 pull request;
 * until it is merged a link would lead to "Página não encontrada", so the links stay behind this
 * constant. The pull request that brings the pages turns it on, with the e2e that opens both.
 */
export const LEGAL_PAGES_PUBLISHED: boolean = false;

export const LEGAL_LINKS = {
  privacy: "/privacidade",
  terms: "/termos",
} as const;
