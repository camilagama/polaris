const MIN_SLUG_LENGTH = 3;
const MAX_SLUG_LENGTH = 40;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * What a visitor's request may say. The public address is looked up in lowercase
 * and has the shape the database enforces, so anything else is not an address
 * and never needs a database connection. Both return null for what cannot be one.
 */
export function parseSlug(value: unknown): string | null {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  return slug.length >= MIN_SLUG_LENGTH &&
    slug.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(slug)
    ? slug
    : null;
}

export function parseUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}
