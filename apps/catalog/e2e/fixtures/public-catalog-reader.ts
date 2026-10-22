import type {
  PublicCatalogPage,
  PublicCatalogProduct,
  PublicCatalogProfile,
  PublicCatalogReader,
} from "@polaris/db/public-catalog-reader";

/**
 * Stands in for @polaris/db/public-catalog-reader in the "fixture-data" build of the browser tests (see
 * vite.config.ts): the same four reads, over a few stores kept in memory, so the pages of a store with
 * products are rendered by the real Worker without a database. Never part of a deployed build.
 */

const HORIZONTE: PublicCatalogProfile = {
  description:
    "Roupas e acessórios no centro de Santarém. Retirada na loja ou entrega combinada pelo WhatsApp.",
  instagram: "loja.horizonte",
  name: "Loja Horizonte",
  slug: "loja-horizonte",
  whatsapp: "5593912345678",
};

const SEM_CONTATO: PublicCatalogProfile = {
  description: null,
  instagram: null,
  name: "Loja sem contato",
  slug: "sem-contato",
  whatsapp: null,
};

const VAZIA: PublicCatalogProfile = {
  description: "Em breve.",
  instagram: null,
  name: "Loja vazia",
  slug: "vazia",
  whatsapp: null,
};

const id = (n: number) =>
  `0199a0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** The id of the product the browser tests open: three photos, four variants, one without a price. */
export const PRODUCT_WITH_PHOTOS = id(1);
/** One photo and a long name with characters that break a careless link. */
export const PRODUCT_WITH_ONE_PHOTO = id(2);
/** No photo, every variant without a price. */
export const PRODUCT_WITHOUT_PHOTO = id(3);

const photo = (assetId: string) => ({ assetId, height: 640, width: 640 });

const PRODUCTS: PublicCatalogProduct[] = [
  {
    description:
      "Algodão penteado, gola redonda. Tamanhos P a GG. Lavar do avesso.",
    id: PRODUCT_WITH_PHOTOS,
    media: [photo(id(101)), photo(id(102)), photo(id(103))],
    name: "Camiseta básica",
    variants: [
      { id: id(201), label: "Branca · P", price: "49.90" },
      { id: id(202), label: "Branca · M", price: "49.90" },
      { id: id(203), label: "Preta · M", price: "54.90" },
      { id: id(204), label: "Preta · G", price: null },
    ],
  },
  {
    description: null,
    id: PRODUCT_WITH_ONE_PHOTO,
    media: [photo(id(104))],
    name: `Camisa "Tom & Jerry" #1 🎉 ${"edição limitada ".repeat(20).trim()}`,
    variants: [{ id: id(205), label: null, price: "139.90" }],
  },
  {
    description: "Sem foto ainda.",
    id: PRODUCT_WITHOUT_PHOTO,
    media: [],
    name: "Boné aba reta",
    variants: [
      { id: id(206), label: "Preto", price: null },
      { id: id(207), label: "Cinza", price: null },
    ],
  },
];

/** The names of the grid beyond the three above, so the page has the weight of a real store. */
const EXTRA = [
  ["Cinto de couro", "79.90"],
  ["Meia esportiva (par)", "12.50"],
  ["Tênis casual", "219.00"],
  ["Mochila 20 L", "129.00"],
  ["Camisa polo", "89.90"],
] as const;

const summaryOf = (product: PublicCatalogProduct) => {
  const prices = product.variants.flatMap((variant) =>
    variant.price === null ? [] : [Number(variant.price)]
  );
  return {
    coverAssetId: product.media[0]?.assetId ?? null,
    description: product.description,
    id: product.id,
    name: product.name,
    priceFrom: prices.length === 0 ? null : Math.min(...prices).toFixed(2),
  };
};

const horizonteProducts: PublicCatalogPage["products"] = [
  ...PRODUCTS.map(summaryOf),
  ...EXTRA.map(([name, price], index) => ({
    coverAssetId: index % 2 === 0 ? id(110 + index) : null,
    description: null,
    id: id(10 + index),
    name,
    priceFrom: price,
  })),
];

const STORES: Record<
  string,
  { products: PublicCatalogPage["products"]; profile: PublicCatalogProfile }
> = {
  "loja-horizonte": { products: horizonteProducts, profile: HORIZONTE },
  "sem-contato": { products: horizonteProducts, profile: SEM_CONTATO },
  vazia: { products: [], profile: VAZIA },
};

const reader: PublicCatalogReader = {
  media: () => Promise.resolve(null),
  product: (slug, productId) =>
    Promise.resolve(
      STORES[slug]
        ? (PRODUCTS.find((product) => product.id === productId) ?? null)
        : null
    ),
  products: (slug) => {
    const store = STORES[slug];
    return Promise.resolve(
      store ? { next: null, products: store.products } : null
    );
  },
  profile: (slug) => Promise.resolve(STORES[slug]?.profile ?? null),
};

export function withPublicCatalog<T>(
  _connectionString: string,
  operation: (catalog: PublicCatalogReader) => Promise<T>
): Promise<T> {
  return operation(reader);
}
