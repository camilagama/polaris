import type {
  PublicCatalogProduct,
  PublicCatalogProfile,
} from "@polaris/db/public-catalog-reader";
import { formatPrice } from "./format";

/**
 * What a search engine or a social preview reads from a public page (plan PR90):
 * title, description, canonical URL and Open Graph / Twitter tags. Built only from
 * the public profile and product, so it can never carry anything private.
 */

export interface HeadMeta {
  content?: string;
  name?: string;
  property?: string;
  title?: string;
}

interface HeadLink {
  href: string;
  rel: string;
}

export interface PageHead {
  links: HeadLink[];
  meta: HeadMeta[];
}

const DESCRIPTION_LIMIT = 160;
const SITE_NAME = "Polaris";
const LOCALE = "pt_BR";
const TRAILING_SLASHES = /\/+$/;
const WHITESPACE = /\s+/g;

/** The origin pages are addressed by, without a trailing slash. */
export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(TRAILING_SLASHES, "");
}

function storePath(slug: string): string {
  return `/${encodeURIComponent(slug)}`;
}

export function productPath(slug: string, productId: string): string {
  return `${storePath(slug)}/p/${encodeURIComponent(productId)}`;
}

/** A description short enough for a search result, cut at a word where it can be. */
export function summarize(text: string | null | undefined): string | null {
  const flat = (text ?? "").replace(WHITESPACE, " ").trim();
  if (flat === "") {
    return null;
  }
  const characters = [...flat];
  if (characters.length <= DESCRIPTION_LIMIT) {
    return flat;
  }
  const cut = characters.slice(0, DESCRIPTION_LIMIT - 1).join("");
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > DESCRIPTION_LIMIT / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function page(input: {
  description: string | null;
  origin: string;
  path: string;
  title: string;
  type: "website" | "product";
}): PageHead {
  const url = `${normalizeOrigin(input.origin)}${input.path}`;
  const meta: HeadMeta[] = [
    { title: input.title },
    ...(input.description
      ? [{ content: input.description, name: "description" }]
      : []),
    { content: input.title, property: "og:title" },
    ...(input.description
      ? [{ content: input.description, property: "og:description" }]
      : []),
    {
      content: input.type === "product" ? "product" : "website",
      property: "og:type",
    },
    { content: url, property: "og:url" },
    { content: SITE_NAME, property: "og:site_name" },
    { content: LOCALE, property: "og:locale" },
    { content: "summary", name: "twitter:card" },
    { content: input.title, name: "twitter:title" },
    ...(input.description
      ? [{ content: input.description, name: "twitter:description" }]
      : []),
  ];
  return { links: [{ href: url, rel: "canonical" }], meta };
}

export function storeHead(input: {
  origin: string;
  profile: PublicCatalogProfile;
}): PageHead {
  return page({
    description:
      summarize(input.profile.description) ??
      `Catálogo de ${input.profile.name}.`,
    origin: input.origin,
    path: storePath(input.profile.slug),
    title: input.profile.name,
    type: "website",
  });
}

export function productHead(input: {
  origin: string;
  product: PublicCatalogProduct;
  profile: PublicCatalogProfile;
}): PageHead {
  const prices = input.product.variants
    .map((variant) => variant.price)
    .filter((price): price is string => price !== null);
  const cheapest = prices.length > 0 ? lowestPrice(prices) : null;
  return page({
    description:
      summarize(input.product.description) ??
      (cheapest
        ? `${input.product.name} a partir de ${formatPrice(cheapest)} em ${input.profile.name}.`
        : `${input.product.name} em ${input.profile.name}.`),
    origin: input.origin,
    path: productPath(input.profile.slug, input.product.id),
    title: `${input.product.name} · ${input.profile.name}`,
    type: "product",
  });
}

/** The lowest of decimal strings with at most two places, compared in cents so no float is involved. */
function lowestPrice(prices: string[]): string {
  const cents = (price: string) => {
    const [whole = "0", fraction = ""] = price.split(".");
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  };
  return prices.reduce((lowest, price) =>
    cents(price) < cents(lowest) ? price : lowest
  );
}

/** The home page is not a store or a product and is kept out of search results (a not-found page answers 404, which search engines drop). */
export const keepOutOfSearch: HeadMeta = {
  content: "noindex",
  name: "robots",
};
