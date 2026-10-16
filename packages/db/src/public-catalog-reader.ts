import { Client } from "pg";

/**
 * The public side of the catalog (plan PR86 to PR91, ADR 0069): the four
 * functions the public database role may run, and nothing else. Every call looks
 * at the plan in the database, so what is returned is what may be shown right now;
 * a store that is not shown (unknown address, switched off, outside the plan,
 * closed) is `null`, never an error, and indistinguishable from one that does not
 * exist. No organization ID, cost, stock or SKU is ever part of an answer.
 */

export interface PublicCatalogProfile {
  description: string | null;
  instagram: string | null;
  name: string;
  slug: string;
  whatsapp: string | null;
}

export interface PublicCatalogProductSummary {
  coverAssetId: string | null;
  description: string | null;
  id: string;
  name: string;
  /** The lowest list price, as a decimal string, or null when no variant has one. */
  priceFrom: string | null;
}

export interface PublicCatalogPage {
  /** The cursor for the next page, or null at the end. */
  next: string | null;
  products: PublicCatalogProductSummary[];
}

export interface PublicCatalogProduct {
  description: string | null;
  id: string;
  media: { assetId: string; height: number; width: number }[];
  name: string;
  variants: { id: string; label: string | null; price: string | null }[];
}

/** Where the server reads an image from. It holds the private storage path: it is never sent to a visitor. */
export interface PublicCatalogMedia {
  byteSize: number;
  contentType: string;
  storageKey: string;
}

export interface PublicCatalogReader {
  media: (
    slug: string,
    productId: string,
    assetId: string
  ) => Promise<PublicCatalogMedia | null>;
  product: (
    slug: string,
    productId: string
  ) => Promise<PublicCatalogProduct | null>;
  products: (
    slug: string,
    options?: { after?: string | null; limit?: number }
  ) => Promise<PublicCatalogPage | null>;
  profile: (slug: string) => Promise<PublicCatalogProfile | null>;
}

export const PUBLIC_CATALOG_MAX_PAGE_SIZE = 60;
const DEFAULT_PAGE_SIZE = 24;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The address is stored in lowercase; anything else is looked up as typed and found nowhere. */
function addressOf(slug: string): string {
  return slug.trim().toLowerCase();
}

function idOrNull(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && uuidPattern.test(value)
    ? value.toLowerCase()
    : null;
}

interface Queryable {
  query: (
    text: string,
    values: unknown[]
  ) => Promise<{ rows: { result: unknown }[] }>;
}

export function publicCatalogReaderOver(
  client: Queryable
): PublicCatalogReader {
  const call = async <T>(statement: string, values: unknown[]) => {
    const { rows } = await client.query(
      `SELECT ${statement} AS result`,
      values
    );
    return (rows[0]?.result ?? null) as T | null;
  };
  return {
    media(slug, productId, assetId) {
      const product = idOrNull(productId);
      const asset = idOrNull(assetId);
      if (product === null || asset === null) {
        return Promise.resolve(null);
      }
      return call<PublicCatalogMedia>(
        "public.public_catalog_media($1, $2::uuid, $3::uuid)",
        [addressOf(slug), product, asset]
      );
    },
    product(slug, productId) {
      const product = idOrNull(productId);
      if (product === null) {
        return Promise.resolve(null);
      }
      return call<PublicCatalogProduct>(
        "public.public_catalog_product($1, $2::uuid)",
        [addressOf(slug), product]
      );
    },
    products(slug, options = {}) {
      const limit = Math.min(
        Math.max(Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE), 1),
        PUBLIC_CATALOG_MAX_PAGE_SIZE
      );
      const cursor = options.after ?? null;
      const after = idOrNull(cursor);
      if (cursor !== null && after === null) {
        // a cursor that is not one of ours is not a page of this store
        return Promise.resolve(null);
      }
      return call<PublicCatalogPage>(
        "public.public_catalog_products($1, $2, $3::uuid)",
        [addressOf(slug), limit, after]
      );
    },
    profile(slug) {
      return call<PublicCatalogProfile>("public.public_catalog_profile($1)", [
        addressOf(slug),
      ]);
    },
  };
}

/**
 * Opens one connection with the public role's login, runs the reads and closes
 * it. A Worker makes one per request (Hyperdrive pools behind it).
 */
export async function withPublicCatalog<T>(
  connectionString: string,
  operation: (catalog: PublicCatalogReader) => Promise<T>
): Promise<T> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 8000,
    statement_timeout: 5000,
  });
  // a connection that breaks between queries must not crash the Worker; the failing call reports it
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await operation(publicCatalogReaderOver(client));
  } finally {
    await client.end().catch(() => undefined);
  }
}
