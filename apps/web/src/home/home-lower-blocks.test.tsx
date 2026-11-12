import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LowerBlocks } from "./home-lower-blocks";

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
  it("a ordem do DOM é a da leitura: Meta, Vendas por dia, Ritmo, Mais vendidos", () => {
    expect(order(html({}))).toEqual(["goal", "chart", "rhythm", "ranking"]);
  });

  it("são duas linhas de par: Meta e gráfico, mapa e ranking", () => {
    const [upper, lower] = rows(html({}));
    expect(upper).toContain("data-pair");
    expect(upper).toContain(
      "@min-[60rem]/home:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
    );
    expect(lower).toContain("data-pair");
    expect(lower).toContain(
      "@min-[60rem]/home:grid-cols-[30rem_minmax(0,1fr)]"
    );
  });

  it("a faixa da Meta passa o gráfico para a linha inteira (a linha lê a marca da faixa)", () => {
    const [upper] = rows(html({}));
    expect(upper).toContain(
      "@min-[60rem]/home:has-data-[goal-strip]:grid-cols-1"
    );
  });

  it("o par é medido pelo contêiner dos blocos, não pela janela", () => {
    expect(html({})).toContain('class="@container/home min-w-0"');
  });

  it("sem o Ritmo (sem conexão e sem cópia) o ranking ocupa a linha inteira", () => {
    const markup = html({ rhythm: null });
    expect(order(markup)).toEqual(["goal", "chart", "ranking"]);
    const [, lower] = rows(markup);
    expect(lower).not.toContain("data-pair");
    expect(lower).not.toContain("grid-cols-[30rem");
  });

  it("sem o gráfico a Meta fica sozinha na linha e deitada (não é par)", () => {
    const [upper] = rows(html({ chart: null }));
    expect(upper).not.toContain("data-pair");
  });

  it("sem nenhum bloco não desenha linha", () => {
    expect(
      rows(html({ chart: null, goal: null, ranking: null, rhythm: null }))
    ).toEqual([]);
  });
});
