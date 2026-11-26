import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LowerBlocks } from "./home-lower-blocks";

const ORDER_UTILITY = /(?:^|[\s:"])-?order-/;

const block = (name: string) => <section data-block={name}>{name}</section>;

const html = (props: Partial<Parameters<typeof LowerBlocks>[0]>) =>
  renderToStaticMarkup(
    <LowerBlocks
      chart={block("chart")}
      goal={block("goal")}
      ranking={block("ranking")}
      rhythm={block("rhythm")}
      {...props}
    />
  );

const order = (markup: string) =>
  [...markup.matchAll(/data-block="(\w+)"/g)].map((match) => match[1]);

const rows = (markup: string) =>
  [...markup.matchAll(/<div class="group\/row[^"]*"([^>]*)>/g)].map(
    (match) => match[0]
  );

describe("os blocos sob os cartões do Início", () => {
  it("a ordem do DOM é a da leitura: Vendas por dia, Mais vendidos, Meta, Ritmo", () => {
    expect(order(html({}))).toEqual(["chart", "ranking", "goal", "rhythm"]);
  });

  it("nenhuma linha inverte a ordem do DOM com order-*", () => {
    expect(html({})).not.toMatch(ORDER_UTILITY);
  });

  it("são duas linhas de par: gráfico (3/5) e ranking (2/5), Meta (2/5) e mapa (3/5)", () => {
    const [upper, lower] = rows(html({}));
    expect(upper).toContain("data-pair");
    expect(upper).toContain(
      "@min-[60rem]/home:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
    );
    expect(lower).toContain("data-pair");
    expect(lower).toContain(
      "@min-[60rem]/home:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    );
  });

  it("sem meta a grade não muda: nenhuma linha lê a marca da faixa, a Meta fica no par com o mapa", () => {
    const [upper, lower] = rows(html({}));
    expect(upper).not.toContain("goal-strip");
    expect(lower).not.toContain("goal-strip");
    expect(lower).not.toContain("grid-cols-1");
  });

  it("o par é medido pelo contêiner dos blocos, não pela janela", () => {
    expect(html({})).toContain('class="@container/home min-w-0"');
  });

  it("sem o Ritmo (sem conexão e sem cópia) a Meta ocupa a linha inteira", () => {
    const markup = html({ rhythm: null });
    expect(order(markup)).toEqual(["chart", "ranking", "goal"]);
    const [, lower] = rows(markup);
    expect(lower).not.toContain("data-pair");
    expect(lower).not.toContain("grid-cols-[");
  });

  it("sem o gráfico o ranking fica sozinho na linha (não é par)", () => {
    const [upper] = rows(html({ chart: null }));
    expect(upper).not.toContain("data-pair");
  });

  it("sem nenhum bloco não desenha linha", () => {
    expect(
      rows(html({ chart: null, goal: null, ranking: null, rhythm: null }))
    ).toEqual([]);
  });
});
