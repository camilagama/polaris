import type { PublicCatalogProfileReadModel } from "@polaris/contracts";

/** What the organization is typing into its public profile. */
export interface PublicProfileDraft {
  description: string;
  instagram: string;
  publicName: string;
  slug: string;
  whatsapp: string;
}

export const MAX_PUBLIC_DESCRIPTION = 280;
export const MAX_PUBLIC_NAME = 80;
/** The server takes at most this many products in one call. */
const PUBLICATION_BATCH_SIZE = 200;

const MAX_SLUG_LENGTH = 40;
const DIACRITICS = /\p{Diacritic}/gu;
const NOT_ALLOWED_IN_SLUG = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;
const TRAILING_SLASHES = /\/+$/;

export const blankProfileDraft: PublicProfileDraft = {
  description: "",
  instagram: "",
  publicName: "",
  slug: "",
  whatsapp: "",
};

export function draftFromProfile(
  profile: PublicCatalogProfileReadModel | null
): PublicProfileDraft {
  return profile
    ? {
        description: profile.description ?? "",
        instagram: profile.instagram ?? "",
        publicName: profile.publicName,
        slug: profile.slug,
        whatsapp: profile.whatsapp ?? "",
      }
    : blankProfileDraft;
}

/** A first suggestion for the address from the public name: lowercase, no accents, hyphens. */
export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(NOT_ALLOWED_IN_SLUG, "-")
    .replace(EDGE_HYPHENS, "")
    .slice(0, MAX_SLUG_LENGTH);
  return slug.replace(EDGE_HYPHENS, "");
}

/** The address a visitor opens, or null while the origin is not configured. */
export function publicUrl(origin: string | null, slug: string): string | null {
  return origin ? `${origin.replace(TRAILING_SLASHES, "")}/${slug}` : null;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The request for the server: blank optional fields are not sent, the rest is the server's to validate. */
export function profileRequest(
  draft: PublicProfileDraft,
  expectedVersion: number | undefined
) {
  return {
    description: blankToNull(draft.description),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    instagram: blankToNull(draft.instagram),
    publicName: draft.publicName.trim(),
    slug: draft.slug.trim().toLowerCase(),
    whatsapp: blankToNull(draft.whatsapp),
  };
}

/** True when the draft differs from what is saved (a blank draft against no profile is not a change). */
export function hasProfileChanges(
  draft: PublicProfileDraft,
  profile: PublicCatalogProfileReadModel | null
): boolean {
  const saved = draftFromProfile(profile);
  return (
    draft.description.trim() !== saved.description ||
    draft.instagram.trim() !== saved.instagram ||
    draft.publicName.trim() !== saved.publicName ||
    draft.slug.trim().toLowerCase() !== saved.slug ||
    draft.whatsapp.trim() !== saved.whatsapp
  );
}

/** Splits ids into calls the server accepts. */
export function inBatches<T>(
  items: readonly T[],
  size = PUBLICATION_BATCH_SIZE
) {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

export type CatalogVisibility = "live" | "off" | "waiting-plan";

/**
 * What a visitor can see right now: the organization's switch is on and the plan
 * includes the catalog. A profile that is switched on while the plan does not
 * include it is kept, and says so.
 */
export function visibilityOf(input: {
  enabled: boolean;
  profile: PublicCatalogProfileReadModel | null;
}): CatalogVisibility {
  if (!input.profile?.published) {
    return "off";
  }
  return input.enabled ? "live" : "waiting-plan";
}
