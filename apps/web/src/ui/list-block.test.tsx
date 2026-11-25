import { Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListBlock, type ListBlockProps } from "./list-block";

const HEADING = /<h2[^>]*id="([^"]+)"[^>]*>Produtos<\/h2>/;
const COUNT =
  /<p[^>]*aria-live="polite"[^>]*data-list-count=""[^>]*>([^<]*)<\/p>/;
const REGION = /<div[^>]*role="region"[^>]*aria-labelledby="([^"]+)"/;
const STATUS = /<p class="sr-only" role="status">([^<]*)<\/p>/;
const COUNT_CLASS = /<p[^>]*class="([^"]*)"[^>]*data-list-count=""/;
const ROWS = /data-list-block-row=""/g;
const ANY_HEADING = /<h[1-6]\b/g;
const COUNT_AS_HEADING = /<h[1-6][^>]*>2 produtos/;
const SKELETON_BOX = /aria-hidden="true" class="divide-y/;
const SHAPE = /data-shape/g;

function draw(
  props: Partial<ListBlockProps> & { state?: ListBlockProps["state"] },
  children?: ReactNode
) {
  const state = props.state ?? "rows";
  const shared = {
    count: "2 produtos",
    emptyNotice: <p>Nenhum produto com essa busca.</p>,
    skeleton: <span data-shape="">forma</span>,
    title: "Produtos",
  };
  return renderToStaticMarkup(
    <ListBlock {...shared} {...props} state={state as "rows"}>
      {children}
    </ListBlock>
  );
}

const rows = [
  <ListBlock.Row key="a">Camiseta</ListBlock.Row>,
  <ListBlock.Row key="b">Boné</ListBlock.Row>,
];

describe("ListBlock: o título e a contagem na árvore de acessibilidade", () => {
  it("o título é um h2 que dá nome à região, e a lista aponta para ele", () => {
    const html = draw({}, rows);
    const heading = HEADING.exec(html)?.[1];
    expect(heading).toBeDefined();
    expect(REGION.exec(html)?.[1]).toBe(heading);
    expect(html).toContain(`<ul aria-labelledby="${heading}"`);
    expect(html.match(ANY_HEADING)).toHaveLength(1);
  });

  it("a contagem é texto de apoio com aria-live, nunca um título", () => {
    const html = draw({}, rows);
    expect(COUNT.exec(html)?.[1]).toBe("2 produtos");
    expect(html).not.toMatch(COUNT_AS_HEADING);
  });

  it("a contagem fica no lugar, vazia, enquanto carrega: a altura do cabeçalho não muda", () => {
    const html = draw({ count: "", state: "loading" }, rows);
    expect(COUNT.exec(html)?.[1]).toBe("");
    expect(html).toContain("min-h-5");
  });

  it("a contagem fica vazia sozinha em loading, mesmo que a tela passe o texto", () => {
    const html = draw({ count: "2 produtos", state: "loading" }, rows);
    expect(COUNT.exec(html)?.[1]).toBe("");
    expect(html).not.toContain("2 produtos");
  });

  it("fora de loading a contagem da tela aparece", () => {
    for (const state of ["rows", "filtered-empty"] as const) {
      expect(COUNT.exec(draw({ count: "7 produtos", state }, rows))?.[1]).toBe(
        "7 produtos"
      );
    }
  });

  it("com ação, abaixo de 760 px a contagem ocupa o resto da linha, e a reserva de largura só vale de 760 px quando as linhas estão na tela", () => {
    const html = draw(
      { action: <button type="button">Exportar</button> },
      rows
    );
    const count = COUNT_CLASS.exec(html)?.[1]?.split(" ");
    expect(count).toContain("max-md:grow");
    expect(count).toContain("md:min-w-28");
    expect(count).not.toContain("min-w-28");
  });

  it("com ação, em loading a reserva vale no celular também: o cabeçalho quebra igual quando o texto chega", () => {
    const html = draw(
      { action: <button type="button">Exportar</button>, state: "loading" },
      rows
    );
    const count = COUNT_CLASS.exec(html)?.[1]?.split(" ");
    expect(count).toContain("min-w-28");
    expect(count).toContain("max-md:grow");
  });

  it("sem ação nada muda: a reserva de largura vale em todas as larguras e a contagem não cresce", () => {
    for (const state of ["rows", "loading"] as const) {
      const count = COUNT_CLASS.exec(draw({ state }, rows))?.[1]?.split(" ");
      expect(count).toContain("min-w-28");
      expect(count).not.toContain("max-md:grow");
    }
  });

  it("sem count e sem ação, com linhas, não há contagem nem a reserva de largura", () => {
    const html = draw({ count: undefined, state: "rows" }, rows);
    expect(html).not.toContain("data-list-count");
    expect(html).not.toContain("min-w-28");
    expect(html).not.toContain("aria-live");
    expect(html).toContain("Camiseta");
  });

  it("count vazio continua reservando o lugar, e sem count a ação e o loading mantêm a contagem", () => {
    expect(COUNT_CLASS.exec(draw({ count: "" }, rows))?.[1]).toContain(
      "min-w-28"
    );
    expect(
      draw(
        { action: <button type="button">Exportar</button>, count: undefined },
        rows
      )
    ).toContain("data-list-count");
    expect(draw({ count: undefined, state: "loading" }, rows)).toContain(
      "data-list-count"
    );
  });

  it("com ação, o grupo da direita ocupa a linha e encosta à direita; sem ação, não", () => {
    const withAction = draw(
      { action: <button type="button">Exportar</button> },
      rows
    );
    expect(withAction).toContain("max-md:grow max-md:justify-end");
    expect(draw({}, rows)).not.toContain("max-md:grow max-md:justify-end");
  });

  it("a ação fica depois da contagem, à direita do cabeçalho", () => {
    const html = draw({ action: <button type="button">Novo</button> }, rows);
    expect(html.indexOf("Novo")).toBeGreaterThan(
      html.indexOf("data-list-count")
    );
  });
});

describe("ListBlock: os estados", () => {
  it("rows: desenha as linhas e nenhum esqueleto nem aviso", () => {
    const html = draw({}, rows);
    expect(html.match(ROWS)).toHaveLength(2);
    expect(html).not.toContain("data-shape");
    expect(html).not.toContain("data-list-block-notice");
    expect(STATUS.exec(html)?.[1]).toBe("");
  });

  it("loading: repete a forma da linha, só o leitor de tela lê Carregando… e as linhas não aparecem", () => {
    const html = draw({ skeletonRows: 4, state: "loading" }, rows);
    expect(html.match(SHAPE)).toHaveLength(4);
    expect(STATUS.exec(html)?.[1]).toBe("Carregando…");
    expect(html).not.toMatch(ROWS);
    expect(html).toMatch(SKELETON_BOX);
  });

  it("filtered-empty: mostra a frase da busca sem resultado no lugar das linhas", () => {
    const html = draw({ count: "0 produtos", state: "filtered-empty" }, rows);
    expect(html).toContain("Nenhum produto com essa busca.");
    expect(html).not.toMatch(ROWS);
  });

  it("rows sem nenhuma linha não desenha uma lista vazia", () => {
    expect(draw({}, null)).not.toContain("<ul");
  });
});

describe("ListBlock: o cabeçalho de coluna e o total", () => {
  const header = (
    <ListBlock.Header key="h">
      <span>Produto</span>
    </ListBlock.Header>
  );
  const total = <ListBlock.Total count="2 produtos" key="t" value="R$ 10,00" />;

  it("o cabeçalho é a primeira linha e o total a última, mesmo declarados fora de ordem", () => {
    const html = draw({}, [total, ...rows, header]);
    const head = html.indexOf("data-list-block-header");
    expect(head).toBeGreaterThan(-1);
    expect(head).toBeLessThan(html.indexOf("data-list-block-row"));
    expect(html.lastIndexOf("data-list-block-row")).toBeLessThan(
      html.indexOf("data-list-total")
    );
  });

  it.each(["rows", "loading", "filtered-empty"] as const)(
    "o total fica por último em %s",
    (state) => {
      const html = draw({ state }, [total, header, ...rows]);
      const foot = html.indexOf("data-list-total");
      expect(foot).toBeGreaterThan(html.indexOf("data-list-block-header"));
      expect(html.slice(foot)).not.toContain("data-list-block-row");
      expect(html.slice(foot)).not.toContain("data-shape");
      expect(html.slice(foot)).not.toContain("data-list-block-notice");
    }
  );

  it("o painel rola de lado por dentro: a moldura e o título ficam fora do rolo", () => {
    const html = draw({}, [header, ...rows, total]);
    const scroll = html.indexOf("data-list-block-scroll");
    expect(html.indexOf('data-slot="card-frame-header"')).toBeLessThan(scroll);
    expect(html.indexOf("data-list-block-header")).toBeGreaterThan(scroll);
    expect(html.indexOf("data-list-total")).toBeGreaterThan(scroll);
  });
});

describe("ListBlock: filho embrulhado", () => {
  function WrappedTotal() {
    return <ListBlock.Total count="2 produtos" value="R$ 10,00" />;
  }

  it("um Total dentro de componente é tratado como linha: fica na lista, na ordem em que foi declarado", () => {
    const html = draw({}, [<WrappedTotal key="t" />, ...rows]);
    expect(html).toContain("data-list-total");
    const list = html.slice(html.indexOf("<ul"), html.indexOf("</ul>"));
    expect(list).toContain("data-list-total");
    expect(html.indexOf("data-list-total")).toBeLessThan(
      html.lastIndexOf("data-list-block-row")
    );
  });

  it("um Total dentro de fragmento também cai na lista", () => {
    const html = draw({}, [
      <Fragment key="t">
        <ListBlock.Total count="2 produtos" value="R$ 10,00" />
      </Fragment>,
      ...rows,
    ]);
    const list = html.slice(html.indexOf("<ul"), html.indexOf("</ul>"));
    expect(list).toContain("data-list-total");
  });

  it("o Total direto fica fora da lista, por último", () => {
    const html = draw({}, [
      <ListBlock.Total count="2 produtos" key="t" value="R$ 10,00" />,
      ...rows,
    ]);
    const list = html.slice(html.indexOf("<ul"), html.indexOf("</ul>"));
    expect(list).not.toContain("data-list-total");
    expect(html.indexOf("data-list-total")).toBeGreaterThan(
      html.indexOf("</ul>")
    );
  });
});

describe("ListBlock: o tipo (controles de compilação)", () => {
  const shared = { count: "", title: "Produtos" } as const;

  it("aceita os três estados", () => {
    const accepted = [
      <ListBlock {...shared} key="1" state="rows" />,
      <ListBlock {...shared} key="2" skeleton={<i />} state="loading" />,
      <ListBlock {...shared} emptyNotice="x" key="3" state="filtered-empty" />,
    ];
    expect(accepted).toHaveLength(3);
  });

  it("state empty e error não compilam, nem uma lista de ações, nem loading sem a forma da linha", () => {
    // @ts-expect-error a list with nothing at all is the `EmptyState` of the screen, not a state of the piece
    const empty = <ListBlock {...shared} state="empty" />;
    // @ts-expect-error a list that failed to load is the warning of the screen, not a state of the piece
    const failed = <ListBlock {...shared} state="error" />;
    // @ts-expect-error the loading state needs the shape of the row
    const bare = <ListBlock {...shared} state="loading" />;
    // @ts-expect-error the search with no result needs its sentence
    const mute = <ListBlock {...shared} state="filtered-empty" />;
    const pair = [<i key="a" />, <i key="b" />];
    // @ts-expect-error one action only, not a list of them
    const two = <ListBlock {...shared} action={pair} state="rows" />;
    expect([empty, failed, bare, mute, two]).toHaveLength(5);
  });
});
