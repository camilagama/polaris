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

const SPREAD_ROW = /^<li[^>]*class="[^"]*\bflex-1\b/;

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
    renderToStaticMarkup(
      <TopProductsBlock products={PRODUCTS} salesCount={9} />
    )
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
          <TopProductsBlock products={PRODUCTS} salesCount={9} />
        </ThumbnailLoaderProvider>
      )
    );
    expect(rows[0]).toContain('src="blob:');
    expect(rows[0]).toContain("width:32px");
    expect(rows[1]).not.toContain("<img");
    expect(rows[1]).toContain("width:32px");
  });
});

describe("Mais vendidos: a altura que o cartão recebe", () => {
  const product = (index: number) => ({
    deleted: false,
    name: `Produto ${index}`,
    netSales: "100.00",
    coverAssetId: null,
    productId: `0199c2d0-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
    quantity: index,
  });
  const rowsOf = (count: number) =>
    items(
      renderToStaticMarkup(
        <TopProductsBlock
          products={Array.from({ length: count }, (_, index) =>
            product(index + 1)
          )}
          salesCount={count}
        />
      )
    );

  it("de três linhas em diante cada uma divide a altura por igual", () => {
    for (const count of [3, 5]) {
      const rows = rowsOf(count);
      expect(rows).toHaveLength(count);
      for (const row of rows) {
        expect(row).toMatch(SPREAD_ROW);
      }
    }
  });

  it("com uma ou duas linhas a lista fica no alto, sem esticar a linha", () => {
    for (const count of [1, 2]) {
      for (const row of rowsOf(count)) {
        expect(row).not.toMatch(SPREAD_ROW);
      }
    }
  });
});

describe("Mais vendidos: o período em que nada vendeu", () => {
  it("fica na mesma caixa, com a frase do gráfico no lugar da lista", () => {
    const html = renderToStaticMarkup(
      <TopProductsBlock products={[]} salesCount={0} />
    );
    expect(text(html)).toBe("Mais vendidos do mês Sem vendas no período.");
    expect(html).not.toContain("<ol");
  });

  it("com vendas e nenhum produto restante diz que foram devolvidas, na mesma caixa", () => {
    const empty = renderToStaticMarkup(
      <TopProductsBlock products={[]} salesCount={0} />
    );
    const returned = renderToStaticMarkup(
      <TopProductsBlock products={[]} salesCount={3} />
    );
    expect(text(returned)).toBe(
      "Mais vendidos do mês As vendas do período foram devolvidas."
    );
    expect(returned).not.toContain("<ol");
    expect(returned.replace("As vendas do período foram devolvidas.", "")).toBe(
      empty.replace("Sem vendas no período.", "")
    );
  });
});
