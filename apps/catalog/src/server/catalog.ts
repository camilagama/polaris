import {
  type PublicCatalogPage,
  type PublicCatalogProduct,
  type PublicCatalogProfile,
  type PublicCatalogReader,
  withPublicCatalog,
} from "@polaris/db/public-catalog-reader";
import { isNotFound, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

/**
 * The server side of the public catalog. Everything a page shows comes from the
 * four functions the public database role may run, so a store that is not shown
 * for any reason (unknown address, switched off, outside the plan, closed) is the
 * same 404 as one that never existed. Input that cannot be an address or an ID is
 * a 404 too, without opening a database connection; a failure on our side is a
 * generic error, never the driver's message.
 */

export interface StorePage {
  origin: string;
  page: PublicCatalogPage;
  profile: PublicCatalogProfile;
}

export interface ProductPage {
  origin: string;
  product: PublicCatalogProduct;
  profile: PublicCatalogProfile;
}

const PAGE_SIZE = 24;
const MIN_SLUG_LENGTH = 3;
const MAX_SLUG_LENGTH = 40;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_ORIGIN = "http://127.0.0.1:5174";

/** These functions are reachable by a direct request, so the input is checked, not just typed. */
function slugOf(value: unknown): string {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    slug.length < MIN_SLUG_LENGTH ||
    slug.length > MAX_SLUG_LENGTH ||
    !SLUG_PATTERN.test(slug)
  ) {
    throw notFound();
  }
  return slug;
}

function uuidOf(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw notFound();
  }
  return value;
}

function cursorOf(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : uuidOf(value);
}

function connectionString(): string {
  const value = env.CATALOG_HYPERDRIVE?.connectionString;
  if (!value) {
    throw new Error("catalog_unavailable");
  }
  return value;
}

/** The canonical origin is configured, never taken from the request; only local development may go without it. */
function origin(): string {
  const configured = env.CATALOG_ORIGIN;
  if (configured) {
    return configured;
  }
  if (import.meta.env.DEV) {
    return LOCAL_ORIGIN;
  }
  throw new Error("catalog_unavailable");
}

/** Runs the reads; any failure other than "not found" is logged here and reaches the visitor as a generic error. */
async function read<T>(
  operation: (catalog: PublicCatalogReader) => Promise<T | null>
): Promise<T> {
  let found: T | null;
  try {
    found = await withPublicCatalog(connectionString(), operation);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw error;
    }
    console.error("catalog read failed", error);
    throw new Error("catalog_unavailable", { cause: error });
  }
  if (found === null) {
    throw notFound();
  }
  return found;
}

export const getStore = createServerFn()
  .validator((data: unknown) => {
    const input = (data ?? {}) as Record<string, unknown>;
    return { after: cursorOf(input.after), slug: slugOf(input.slug) };
  })
  .handler(async ({ data }): Promise<StorePage> => {
    const found = await read(async (catalog) => {
      const profile = await catalog.profile(data.slug);
      if (!profile) {
        return null;
      }
      const page = await catalog.products(data.slug, {
        after: data.after ?? null,
        limit: PAGE_SIZE,
      });
      return page ? { page, profile } : null;
    });
    return { ...found, origin: origin() };
  });

export const getProduct = createServerFn()
  .validator((data: unknown) => {
    const input = (data ?? {}) as Record<string, unknown>;
    return { productId: uuidOf(input.productId), slug: slugOf(input.slug) };
  })
  .handler(async ({ data }): Promise<ProductPage> => {
    const found = await read(async (catalog) => {
      const profile = await catalog.profile(data.slug);
      if (!profile) {
        return null;
      }
      const product = await catalog.product(data.slug, data.productId);
      return product ? { product, profile } : null;
    });
    return { ...found, origin: origin() };
  });
