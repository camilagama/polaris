import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TopProductsBlock } from "./home-figures";

const PRODUCTS = [
  {
    deleted: false,
    name: "Tênis esportivo de corrida leve com amortecedor duplo, preto",
    netSales: "900.00",
    productId: "0199c2d0-0000-7000-8000-0000000000b1",
    quantity: 12,
  },
  {
    deleted: true,
    name: "Boné antigo",
    netSales: "120.00",
    productId: "0199c2d0-0000-7000-8000-0000000000b2",
    quantity: 4,
  },
];

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
      "1 Tênis esportivo de corrida leve com amortecedor duplo, preto R$ 900,00 12 un.",
      "2 Boné antigo R$ 120,00 4 un.",
    ]);
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
