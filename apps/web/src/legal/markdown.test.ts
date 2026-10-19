import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, slugify } from "./markdown";

describe("slugify", () => {
  it("makes an anchor without accents or punctuation", () => {
    expect(slugify("1. Quem somos")).toBe("1-quem-somos");
    expect(slugify("5. Por quanto tempo guardamos")).toBe(
      "5-por-quanto-tempo-guardamos"
    );
    expect(slugify("Crianças e jovens!")).toBe("criancas-e-jovens");
  });
});

describe("inline text", () => {
  it("reads bold, an internal link and a marker", () => {
    expect(parseInline("a **b** [Termos](/termos) [preencher: x]")).toEqual([
      { kind: "text", text: "a " },
      { children: [{ kind: "text", text: "b" }], kind: "bold" },
      { kind: "text", text: " " },
      { href: "/termos", kind: "link", text: "Termos" },
      { kind: "text", text: " " },
      { kind: "marker", text: "[preencher: x]" },
    ]);
  });

  it("finds a marker inside bold", () => {
    expect(parseInline("**[preencher: e-mail]**.")).toEqual([
      {
        children: [{ kind: "marker", text: "[preencher: e-mail]" }],
        kind: "bold",
      },
      { kind: "text", text: "." },
    ]);
  });

  it.each([
    "[x](https://exemplo.com)",
    "[x](//exemplo.com)",
    "[x](javascript:alert(1))",
    "[x](mailto:a@b.c)",
    String.raw`[x](/\exemplo.com)`,
    '[x](/a "titulo")',
    "[x](pagina)",
  ])("refuses a link that is not a page of the app: %s", (text) => {
    expect(() => parseInline(text)).toThrow();
  });
});

describe("blocks", () => {
  it("reads headings, paragraphs, lists and tables", () => {
    const blocks = parseMarkdown(
      [
        "# Título",
        "",
        "Um parágrafo",
        "em duas linhas.",
        "",
        "## 1. Seção",
        "",
        "- um",
        "- dois",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | **2** |",
      ].join("\n")
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
      "table",
    ]);
    expect(blocks[1]).toEqual({
      children: [{ kind: "text", text: "Um parágrafo em duas linhas." }],
      kind: "paragraph",
    });
    expect(blocks[2]).toMatchObject({ id: "1-secao", level: 2 });
    const [, , , , table] = blocks;
    expect(table).toMatchObject({ header: ["A", "B"], kind: "table" });
    expect(table?.kind === "table" && table.rows).toHaveLength(1);
  });

  it.each([
    ["HTML", "<b>oi</b>"],
    ["an image", "![x](/a.png)"],
    ["code", "`x`"],
    ["a third-level heading", "### x"],
    ["a quote", "> citação"],
    ["a numbered list", "1. um"],
    [
      "a table row with the wrong number of columns",
      "| A | B |\n|---|---|\n| 1 |",
    ],
    ["a list glued to a paragraph", "texto\n- item"],
    ["a heading glued to a paragraph", "texto\n## Título"],
    ["a table without a separator", "| A | B |\n| 1 | 2 |"],
  ])("refuses %s", (_name, source) => {
    expect(() => parseMarkdown(source)).toThrow();
  });
});
