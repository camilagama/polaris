import type {
  PublicCatalogPage,
  PublicCatalogProduct,
  PublicCatalogProfile,
} from "@polaris/db/public-catalog-reader";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HomeView,
  NotFoundView,
  ProductView,
  StoreView,
  UnavailableView,
  useFooterHref,
} from "./views";

const SITE = "https://polaris.example/";
const ORIGIN = "https://catalogo.example";
const PRODUCT_ID = "0199a0a0-0000-7000-8000-000000000001";
const HREF = /href="([^"]+)"/;
const WA_HREF = /href="(https:\/\/wa\.me[^"]+)"/;
const STYLE_ATTRIBUTE = /\sstyle=/i;
const PRIVATE_WORDS = /sku|stock|estoque|custo|cost|storage|organization/i;

const profile: PublicCatalogProfile = {
  description: "Roupas e acessórios.",
  instagram: "loja.ana",
  name: "Loja da Ana",
  slug: "loja-da-ana",
  whatsapp: "5511912345678",
};
const noContact = { ...profile, instagram: null, whatsapp: null };
const product: PublicCatalogProduct = {
  description: "Algodão penteado.",
  id: PRODUCT_ID,
  media: [
    { assetId: "a1", height: 640, width: 640 },
    { assetId: "a2", height: 640, width: 640 },
  ],
  name: "Camiseta básica",
  variants: [
    { id: "v1", label: "Branca · P", price: "49.90" },
    { id: "v2", label: "Preta · G", price: null },
  ],
};
const page: PublicCatalogPage = {
  next: null,
  products: [
    {
      coverAssetId: "a1",
      description: null,
      id: PRODUCT_ID,
      name: "Camiseta básica",
      priceFrom: "49.90",
    },
    {
      coverAssetId: null,
      description: null,
      id: "0199a0a0-0000-7000-8000-000000000002",
      name: "Boné",
      priceFrom: null,
    },
  ],
};

/** The element inside a router with the real paths and a root loader like the app's, so Link and the footer hook work. */
async function render(
  view: (footerHref: string | null) => ReactNode,
  footerHref: string | null
): Promise<string> {
  const root = createRootRoute({
    component: () => {
      const href = useFooterHref();
      return (
        <>
          {view(href)}
          <Outlet />
        </>
      );
    },
    loader: () => ({ footerHref }),
  });
  const store = createRoute({
    component: () => null,
    getParentRoute: () => root,
    path: "/$slug",
  });
  const detail = createRoute({
    component: () => null,
    getParentRoute: () => root,
    path: "/$slug/p/$productId",
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/loja-da-ana"] }),
    routeTree: root.addChildren([store, detail]),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const FOOTER_TEXT = "Catálogo feito com";
const anchors = (html: string) =>
  [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);

describe("the Polaris footer (A3)", () => {
  const pages: [string, (href: string | null) => ReactNode][] = [
    [
      "loja",
      (href) => (
        <StoreView
          footerHref={href}
          page={page}
          profile={profile}
          slug="loja-da-ana"
        />
      ),
    ],
    [
      "produto",
      (href) => (
        <ProductView
          footerHref={href}
          origin={ORIGIN}
          product={product}
          profile={profile}
          slug="loja-da-ana"
        />
      ),
    ],
    ["raiz", (href) => <HomeView footerHref={href} />],
    ["não encontrada", (href) => <NotFoundView footerHref={href} />],
    ["erro", (href) => <UnavailableView footerHref={href} />],
  ];

  for (const [name, view] of pages) {
    it(`is on the ${name} page, with a safe link when the address is valid`, async () => {
      const html = await render(view, SITE);
      expect(html).toContain(FOOTER_TEXT);
      const link = anchors(html).find((tag) => tag.includes(`href="${SITE}"`));
      expect(link, "the Polaris link").toBeDefined();
      expect(link).toContain('rel="noopener noreferrer"');
      // HTML attribute names are case-insensitive; React writes this one in camel case
      expect(link?.toLowerCase()).toContain('referrerpolicy="no-referrer"');
      // the destination is fixed: nothing of the store in it
      expect(html).not.toContain(`${SITE}?`);
      expect(html).not.toContain("loja-da-ana?");
    });

    it(`is only text on the ${name} page when there is no valid address`, async () => {
      const html = await render(view, null);
      expect(html).toContain(`${FOOTER_TEXT} Polaris`);
      expect(html).not.toContain("polaris.example");
    });
  }
});

describe("the contacts of the store", () => {
  it("shows both, with the safer rel", async () => {
    const html = await render(
      (href) => (
        <StoreView
          footerHref={href}
          page={page}
          profile={profile}
          slug="loja-da-ana"
        />
      ),
      null
    );
    expect(html).toContain('href="https://wa.me/5511912345678"');
    expect(html).toContain('href="https://www.instagram.com/loja.ana/"');
    for (const tag of anchors(html).filter((a) => a.includes("btn-sm"))) {
      expect(tag).toContain('rel="noopener noreferrer"');
    }
  });

  it("leaves no empty paragraph without a contact", async () => {
    const html = await render(
      (href) => (
        <StoreView
          footerHref={href}
          page={page}
          profile={noContact}
          slug="loja-da-ana"
        />
      ),
      null
    );
    expect(html).not.toContain("contacts");
    expect(html).not.toContain("wa.me");
  });
});

describe("Perguntar no WhatsApp on the product page (A1)", () => {
  const view =
    (p: PublicCatalogProfile, item = product) =>
    (href: string | null) => (
      <ProductView
        footerHref={href}
        origin={`${ORIGIN}/`}
        product={item}
        profile={p}
        slug="loja-da-ana"
      />
    );

  it("is a link to wa.me with the name and the page address, opening in a new tab", async () => {
    const html = await render(view(profile), null);
    const link = anchors(html).find((tag) => tag.includes("wa.me"));
    expect(link).toBeDefined();
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Perguntar no WhatsApp");
    const href = HREF.exec(link ?? "")?.[1] ?? "";
    const url = new URL(href.replaceAll("&amp;", "&"));
    expect(url.origin + url.pathname).toBe("https://wa.me/5511912345678");
    const text = url.searchParams.get("text") ?? "";
    expect(text).toContain("Camiseta básica");
    expect(text).toContain(`${ORIGIN}/loja-da-ana/p/${PRODUCT_ID}`);
    // never the price, the id of a variant or anything but name and address
    expect(text).not.toContain("49");
    expect(text).not.toContain("v1");
  });

  it("survives & # quotes and emoji in the name", async () => {
    const name = 'Tom & "Jerry" #1 🎉';
    const html = await render(view(profile, { ...product, name }), null);
    const href = WA_HREF.exec(html)?.[1] ?? "";
    const url = new URL(href.replaceAll("&amp;", "&"));
    expect([...url.searchParams.keys()]).toEqual(["text"]);
    expect(url.hash).toBe("");
    expect(url.searchParams.get("text")).toContain(name);
  });

  it("is absent, and leaves no empty paragraph, without a WhatsApp", async () => {
    const html = await render(view({ ...profile, whatsapp: null }), null);
    expect(html).not.toContain("Perguntar no WhatsApp");
    expect(html).not.toContain("wa.me");
    expect(html).not.toContain("contacts");
    // an Instagram alone does not make a WhatsApp button
    expect(await render(view(noContact), null)).not.toContain("contacts");
  });

  it("is absent for a number that is not a valid link", async () => {
    const html = await render(view({ ...profile, whatsapp: "12345" }), null);
    expect(html).not.toContain("wa.me");
  });

  it("does not break the layout with a 300-character name", async () => {
    const html = await render(
      view(profile, { ...product, name: "x".repeat(300) }),
      null
    );
    // the page shows the whole name; only the message of the chat is cut
    expect(html).toContain("x".repeat(300));
    const href = WA_HREF.exec(html)?.[1] ?? "";
    expect(href.length).toBeLessThan(900);
  });
});

describe("the price of a variant without one (A2)", () => {
  it("says 'Preço sob consulta' with a contact, in the row of the variant", async () => {
    const html = await render(
      (href) => (
        <ProductView
          footerHref={href}
          origin={ORIGIN}
          product={product}
          profile={profile}
          slug="s"
        />
      ),
      null
    );
    expect(html).toContain('<span class="unknown">Preço sob consulta</span>');
    expect(html).toContain("<small>R$</small>49,90");
    expect(html).not.toContain("0,00");
    expect(html).not.toContain("Preço não informado");
  });

  it("says 'Preço não informado' without any contact", async () => {
    const html = await render(
      (href) => (
        <ProductView
          footerHref={href}
          origin={ORIGIN}
          product={product}
          profile={noContact}
          slug="s"
        />
      ),
      null
    );
    expect(html).toContain('<span class="unknown">Preço não informado</span>');
    expect(html).not.toContain("sob consulta");
  });

  it("shows only 'Preço …' when all the variants lack a price", async () => {
    const allNull = {
      ...product,
      variants: [
        { id: "v1", label: "P", price: null },
        { id: "v2", label: null, price: null },
      ],
    };
    const html = await render(
      (href) => (
        <ProductView
          footerHref={href}
          origin={ORIGIN}
          product={allNull}
          profile={profile}
          slug="s"
        />
      ),
      null
    );
    expect(html.match(/Preço sob consulta/g)).toHaveLength(2);
    expect(html).not.toContain("R$");
    expect(html).toContain("Único");
  });

  it("uses 'a partir de' only for a product that has a price, the neutral text for the rest", async () => {
    const html = await render(
      (href) => (
        <StoreView footerHref={href} page={page} profile={profile} slug="s" />
      ),
      null
    );
    expect(html).toContain("a partir de <strong>R$ 49,90</strong>");
    expect(html.match(/a partir de/g)).toHaveLength(1);
    expect(html).toContain("Preço sob consulta");
    expect(html).not.toContain("0,00");
    const without = await render(
      (href) => (
        <StoreView footerHref={href} page={page} profile={noContact} slug="s" />
      ),
      null
    );
    expect(without).toContain("Preço não informado");
  });
});

describe("the states of the pages (AC-6)", () => {
  it("shows an empty store, a product with no photo and the placeholder in the grid", async () => {
    const empty = await render(
      (href) => (
        <StoreView
          footerHref={href}
          page={{ next: null, products: [] }}
          profile={profile}
          slug="s"
        />
      ),
      null
    );
    expect(empty).toContain("Ainda não há produtos neste catálogo.");
    expect(empty).not.toContain('class="grid"');

    const grid = await render(
      (href) => (
        <StoreView footerHref={href} page={page} profile={profile} slug="s" />
      ),
      null
    );
    expect(grid).toContain('class="card-image-empty"');
    expect(grid).toContain('class="card-image"');

    const plain = await render(
      (href) => (
        <ProductView
          footerHref={href}
          origin={ORIGIN}
          product={{ ...product, media: [] }}
          profile={profile}
          slug="s"
        />
      ),
      null
    );
    expect(plain).not.toContain('class="gallery"');
  });

  it("shows one photo or several, the first one eager", async () => {
    const one = await render(
      (href) => (
        <ProductView
          footerHref={href}
          origin={ORIGIN}
          product={{
            ...product,
            media: [{ assetId: "a1", height: 1, width: 1 }],
          }}
          profile={profile}
          slug="s"
        />
      ),
      null
    );
    expect(one.match(/<img /g)).toHaveLength(1);
    const many = await render(
      (href) => (
        <ProductView
          footerHref={href}
          origin={ORIGIN}
          product={product}
          profile={profile}
          slug="s"
        />
      ),
      null
    );
    expect(many.match(/<img /g)).toHaveLength(2);
    expect(many).toContain('loading="eager"');
    expect(many).toContain('loading="lazy"');
  });

  it("has the error and not-found texts in Portuguese", async () => {
    expect(
      await render((href) => <UnavailableView footerHref={href} />, null)
    ).toContain("Não foi possível carregar esta página agora.");
    expect(
      await render((href) => <NotFoundView footerHref={href} />, null)
    ).toContain("Página não encontrada");
  });
});

describe("nothing private reaches the HTML (AC-2)", () => {
  it("has no style attribute, no innerHTML source, no cost, stock, SKU or storage key", async () => {
    const store = await render(
      (href) => (
        <StoreView footerHref={href} page={page} profile={profile} slug="s" />
      ),
      SITE
    );
    const detail = await render(
      (href) => (
        <ProductView
          footerHref={href}
          origin={ORIGIN}
          product={product}
          profile={profile}
          slug="s"
        />
      ),
      SITE
    );
    for (const html of [store, detail]) {
      expect(html).not.toMatch(STYLE_ATTRIBUTE);
      expect(html).not.toContain("<style");
      expect(html).not.toContain("<use");
      expect(html).not.toContain("<image");
      expect(html).not.toMatch(PRIVATE_WORDS);
    }
  });
});
