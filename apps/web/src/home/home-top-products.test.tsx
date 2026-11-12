import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThumbnailLoaderProvider } from "../catalog/product-thumbnail";
import { ThumbnailCache } from "../catalog/thumbnail-cache";
import { ThumbnailLoader } from "../catalog/thumbnail-queue";
import { TopProductsBlock } from "./home-figures";

const PRODUCTS = [
  {
    deleted: false,
    name: "Tênis esportivo de corrida leve com amortecedor duplo, preto",
    netSales: "900.00",
    coverAssetId: "0199c2d0-0000-7000-8000-0000000000c1",
    productId: "0199c2d0-0000-7000-8000-0000000000b1",
    quantity: 12,
  },
  {
    deleted: true,
    name: "Boné antigo",
    netSales: "120.00",
    coverAssetId: null,
    productId: "0199c2d0-0000-7000-8000-0000000000b2",
    quantity: 4,
  },
];

const THUMBNAIL_STATE = /data-thumbnail="(\w+)"/;

const CONTAINER_ROW = /^<li[^>]*class="@container /;

const items = (html: string) =>
  [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map((match) => match[0]);

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("Mais vendidos do mês: a marcação de cada linha", () => {
  const rows = items(
    renderToStaticMarkup(<TopProductsBlock products={PRODUCTS} />)
  );

  it("mantém a ordem, o nome completo, o valor e as unidades de cada produto", () => {
    expect(rows.map(text)).toEqual([
      "TÊ 1 Tênis esportivo de corrida leve com amortecedor duplo, preto R$ 900,00 12 un.",
      "BO 2 Boné antigo R$ 120,00 4 un.",
    ]);
  });

  it("cada linha tem a caixa de 32 px da miniatura, com as iniciais do nome, com ou sem capa, sem pedir nada fora do escopo", () => {
    expect(rows.map((row) => row.match(THUMBNAIL_STATE)?.[1])).toEqual([
      "marker",
      "marker",
    ]);
    expect(rows[0]).toContain("width:32px");
    expect(rows[0]).toContain(">TÊ<");
    expect(rows[1]).toContain(">BO<");
    expect(rows.join("")).not.toContain("<img");
  });

  it("mantém o link do produto e deixa o excluído sem link", () => {
    expect(rows[0]).toContain(
      'href="/products?produto=0199c2d0-0000-7000-8000-0000000000b1"'
    );
    expect(rows[1]).not.toContain("<a ");
  });

  it("cada linha mede a própria caixa e o nome pode ter a sua linha", () => {
    for (const row of rows) {
      expect(row).toMatch(CONTAINER_ROW);
      expect(row).toContain("line-clamp-2");
    }
  });
});

describe("Mais vendidos: a miniatura de cada linha", () => {
  const COVER = "0199c2d0-0000-7000-8000-0000000000c1";

  it("com a capa já no cache a caixa é a mesma de 32 px e a imagem vem sobre o marcador; sem capa fica o marcador", async () => {
    let urls = 0;
    const cache = new ThumbnailCache({
      createUrl: () => {
        urls += 1;
        return `blob:https://polaris.test/thumb-${urls}`;
      },
      disk: null,
      now: () => 0,
      revokeUrl: () => undefined,
    });
    const loader = new ThumbnailLoader({
      cache,
      isOnline: () => true,
      organizationId: "org-1",
      random: () => 0.5,
      schedule: () => () => undefined,
      subscribeOnline: () => () => undefined,
      transport: ({ ids }) =>
        Promise.resolve({
          items: new Map(
            ids.map((id) => [id, new Blob(["webp"], { type: "image/webp" })])
          ),
          kind: "ok" as const,
        }),
    });
    loader.show(COVER);
    for (let round = 0; round < 6; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each round lets the promises of the previous one run
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const rows = items(
      renderToStaticMarkup(
        <ThumbnailLoaderProvider loader={loader}>
          <TopProductsBlock products={PRODUCTS} />
        </ThumbnailLoaderProvider>
      )
    );
    expect(rows[0]).toContain('src="blob:');
    expect(rows[0]).toContain("width:32px");
    expect(rows[1]).not.toContain("<img");
    expect(rows[1]).toContain("width:32px");
  });
});
