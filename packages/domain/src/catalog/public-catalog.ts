/**
 * The public catalog profile (plan PR87): the few facts an organization
 * chooses, one by one, to show the world. Nothing here is copied from the
 * owner, the login or the billing data: a field is public only because the
 * organization typed it into this profile. Pure: no clock, no database.
 */

export const MAX_PUBLIC_NAME_LENGTH = 80;
export const MAX_PUBLIC_DESCRIPTION_LENGTH = 280;
export const MIN_SLUG_LENGTH = 3;
export const MAX_SLUG_LENGTH = 40;

/**
 * Addresses the catalog itself needs, so no organization can take them. The
 * database refuses the same names (the constraint on the profile table).
 */
export const RESERVED_SLUGS = Object.freeze([
  "admin",
  "api",
  "app",
  "assets",
  "catalog",
  "catalogo",
  "login",
  "m",
  "polaris",
  "robots",
  "sitemap",
  "static",
  "www",
] as const);

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WHATSAPP_FORMATTING = /[\s()+.-]/g;
const WHATSAPP_PATTERN = /^[0-9]{10,15}$/;
const INSTAGRAM_PATTERN = /^[a-z0-9._]{1,30}$/;
const LEADING_AT = /^@/;

export type PublicProfileRefusalCode =
  | "invalid_description"
  | "invalid_instagram"
  | "invalid_name"
  | "invalid_slug"
  | "invalid_whatsapp"
  | "reserved_slug";

export class InvalidPublicCatalogProfileError extends Error {
  readonly code: PublicProfileRefusalCode;

  constructor(code: PublicProfileRefusalCode) {
    super(code);
    this.name = "InvalidPublicCatalogProfileError";
    this.code = code;
  }
}

/** The slug is already another organization's public address. */
export class PublicCatalogSlugTakenError extends Error {
  readonly code = "public_catalog_slug_taken";

  constructor() {
    super("public_catalog_slug_taken");
    this.name = "PublicCatalogSlugTakenError";
  }
}

/** Publishing needs a profile first: there is nothing public to show without one. */
export class PublicCatalogProfileMissingError extends Error {
  readonly code = "public_catalog_profile_missing";

  constructor() {
    super("public_catalog_profile_missing");
    this.name = "PublicCatalogProfileMissingError";
  }
}

export class PublicCatalogVersionConflictError extends Error {
  readonly code = "public_catalog_version_conflict";

  constructor() {
    super("public_catalog_version_conflict");
    this.name = "PublicCatalogVersionConflictError";
  }
}

/** A product that cannot be published: it is not there, or it is archived or deleted. */
export class PublicCatalogProductUnavailableError extends Error {
  readonly code = "public_catalog_product_unavailable";

  constructor() {
    super("public_catalog_product_unavailable");
    this.name = "PublicCatalogProductUnavailableError";
  }
}

export interface PublicProfileInput {
  description?: string | null | undefined;
  instagram?: string | null | undefined;
  publicName: string;
  slug: string;
  whatsapp?: string | null | undefined;
}

export interface PublicProfile {
  description: string | null;
  instagram: string | null;
  publicName: string;
  slug: string;
  whatsapp: string | null;
}

/** The public address: lowercase letters, digits and single hyphens, 3 to 40 characters, never a reserved name. */
export function normalizeSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (
    slug.length < MIN_SLUG_LENGTH ||
    slug.length > MAX_SLUG_LENGTH ||
    !SLUG_PATTERN.test(slug)
  ) {
    throw new InvalidPublicCatalogProfileError("invalid_slug");
  }
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) {
    throw new InvalidPublicCatalogProfileError("reserved_slug");
  }
  return slug;
}

const LINE_FEED = 10;

/**
 * Text that is published must show what it says: no control characters (a line
 * break is allowed where the field is a paragraph), no zero-width characters, and
 * no bidirectional overrides that reorder what the visitor reads.
 */
function hasHiddenCharacters(text: string, allowLineBreak: boolean): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 32 || (code >= 127 && code <= 159);
    if (control && !(allowLineBreak && code === LINE_FEED)) {
      return true;
    }
    if (
      (code >= 0x20_0b && code <= 0x20_0f) ||
      (code >= 0x20_2a && code <= 0x20_2e) ||
      (code >= 0x20_60 && code <= 0x20_69) ||
      code === 0xfe_ff
    ) {
      return true;
    }
  }
  return false;
}

function optionalText(
  value: string | null | undefined,
  maxLength: number,
  code: PublicProfileRefusalCode
): string | null {
  const text = value?.trim() ?? "";
  if (text === "") {
    return null;
  }
  if ([...text].length > maxLength || hasHiddenCharacters(text, true)) {
    throw new InvalidPublicCatalogProfileError(code);
  }
  return text;
}

/**
 * Checks what an organization typed for its public profile. The WhatsApp number
 * is kept as digits only (country code included, 10 to 15 digits) and the
 * Instagram name without the @, both optional.
 */
export function normalizePublicProfile(
  input: PublicProfileInput
): PublicProfile {
  const publicName = input.publicName.trim();
  if (
    publicName === "" ||
    [...publicName].length > MAX_PUBLIC_NAME_LENGTH ||
    hasHiddenCharacters(publicName, false)
  ) {
    throw new InvalidPublicCatalogProfileError("invalid_name");
  }
  const rawWhatsapp = input.whatsapp?.trim() ?? "";
  const whatsapp =
    rawWhatsapp === "" ? null : rawWhatsapp.replace(WHATSAPP_FORMATTING, "");
  if (whatsapp !== null && !WHATSAPP_PATTERN.test(whatsapp)) {
    throw new InvalidPublicCatalogProfileError("invalid_whatsapp");
  }
  const rawInstagram = input.instagram?.trim() ?? "";
  const instagram =
    rawInstagram === ""
      ? null
      : rawInstagram.replace(LEADING_AT, "").toLowerCase();
  if (instagram !== null && !INSTAGRAM_PATTERN.test(instagram)) {
    throw new InvalidPublicCatalogProfileError("invalid_instagram");
  }
  return {
    description: optionalText(
      input.description,
      MAX_PUBLIC_DESCRIPTION_LENGTH,
      "invalid_description"
    ),
    instagram,
    publicName,
    slug: normalizeSlug(input.slug),
    whatsapp,
  };
}
