import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_VALUE,
  DESCRIPTION_TOO_LONG,
  EXTRA_CELLS,
  FORBIDDEN_CHARACTER,
  IMPORT_FILE_PROBLEM_MESSAGES,
  type ImportPreview,
  NAME_LINE_BREAK,
  NAME_TOO_LONG,
  previewImport,
  splitExisting,
  spreadsheetDecimal,
  VALUE_TOO_LONG,
} from "./product-import-rows";
import {
  emptyOpeningDraft,
  PRODUCT_NAME_REQUIRED,
  QUANTITY_FOR_COST,
  validateOpening,
} from "./product-opening-model";

const HEADER = "Nome;Preço de tabela;Quantidade;Custo de cada unidade";
const categories = [
  {
    id: "0199c2d0-0000-7000-8000-0000000c0001",
    name: "Camisetas",
    status: "active",
  },
  {
    id: "0199c2d0-0000-7000-8000-0000000c0002",
    name: "Velhos",
    status: "archived",
  },
] as const;

const file = (text: string) => new TextEncoder().encode(text);

function preview(text: string): Extract<ImportPreview, { kind: "ok" }> {
  const result = previewImport(file(text), categories);
  if (result.kind !== "ok") {
    throw new Error(`expected a preview, got ${result.problem}`);
  }
  return result;
}

/** One row of the import through the importer: the value it would send, or the messages of each field. */
function importOne(cells: {
  listPrice?: string;
  quantity?: string;
  unitCost?: string;
}) {
  const result = preview(
    `${HEADER}\nProduto;${cells.listPrice ?? ""};${cells.quantity ?? ""};${cells.unitCost ?? ""}\n`
  );
  const [ready] = result.ready;
  if (ready) {
    return {
      errors: {},
      value: { initialStock: ready.initialStock, listPrice: ready.listPrice },
    };
  }
  return {
    errors: Object.fromEntries(
      (result.refused[0]?.errors ?? []).map((error) => [
        error.column,
        error.message,
      ])
    ),
    value: null,
  };
}

describe("AC-1: the same rules as the form of a new product", () => {
  // the cases of the form, as a person types them: the importer gives the same value or the same message
  const cases: { listPrice?: string; quantity?: string; unitCost?: string }[] =
    [
      {},
      { listPrice: "49,9" },
      { listPrice: " 49.90 " },
      { listPrice: "0" },
      { listPrice: "12,345" },
      { listPrice: "abc" },
      { listPrice: "-5" },
      { listPrice: "1".repeat(19) },
      { quantity: "10" },
      { quantity: "0" },
      { quantity: "1,5" },
      { quantity: "-3" },
      { quantity: "99999999999" },
      { quantity: "2147483648" },
      { quantity: "10", unitCost: "12,5" },
      { quantity: "3", unitCost: "0" },
      { unitCost: "12,50" },
      { quantity: "2", unitCost: "1,1234567" },
      { quantity: "2", unitCost: "x" },
      { listPrice: "x", quantity: "y", unitCost: "z" },
    ];

  it.each(cases)("%j reads as in the form", (cells) => {
    expect(importOne(cells)).toEqual(
      validateOpening({ ...emptyOpeningDraft, ...cells })
    );
  });

  it("asks for the quantity of a cost with the form's own message", () => {
    expect(importOne({ unitCost: "12,50" }).errors).toEqual({
      quantity: QUANTITY_FOR_COST,
    });
  });

  it("refuses a row without a name with the form's message, and never cuts a long one", () => {
    const result = preview(
      `Nome;Descrição\n  ;x\n${"n".repeat(201)};\nok;${"d".repeat(5001)}\n${"n".repeat(200)};\n`
    );
    expect(result.refused.map((row) => [row.rowNumber, row.errors])).toEqual([
      [2, [{ column: "name", message: PRODUCT_NAME_REQUIRED }]],
      [3, [{ column: "name", message: NAME_TOO_LONG }]],
      [4, [{ column: "description", message: DESCRIPTION_TOO_LONG }]],
    ]);
    expect(result.ready.map((row) => row.name.length)).toEqual([200]);
  });

  it.each([
    ["U+0000", "\u0000"],
    ["U+202E", "\u202E"],
    ["U+2066", "\u2066"],
    ["U+2069", "\u2069"],
  ])(
    "refuses %s in a name or a description, by the rule the server keeps",
    (_label, char) => {
      const result = preview(`Nome;Descrição\nBol${char}sa;x\nok;a${char}b\n`);
      expect(result.refused.map((row) => row.errors)).toEqual([
        [{ column: "name", message: FORBIDDEN_CHARACTER }],
        [{ column: "description", message: FORBIDDEN_CHARACTER }],
      ]);
      expect(result.ready).toEqual([]);
    }
  );

  it("refuses a name in several lines, a control character and more cells than the header", () => {
    const result = preview(
      'Nome;Descrição\n"Bolsa\nazul";x\nBo\u0001né;x\nMeia;linha 1\tfim\nLuva;x;sobra\n'
    );
    expect(result.refused.map((row) => [row.rowNumber, row.errors])).toEqual([
      [2, [{ column: "name", message: NAME_LINE_BREAK }]],
      [3, [{ column: "name", message: FORBIDDEN_CHARACTER }]],
      [5, [{ column: null, message: EXTRA_CELLS }]],
    ]);
    // a tab inside a description is text, as in the form
    expect(result.ready.map((row) => row.description)).toEqual([
      "linha 1\tfim",
    ]);
  });

  it("refuses a value longer than product.create takes, without reading it", () => {
    const result = preview(`${HEADER}\nA;${"1".repeat(65)};;\n`);
    expect(result.refused[0]?.errors).toEqual([
      { column: "listPrice", message: VALUE_TOO_LONG },
    ]);
  });
});

describe("AC-2: values as a spreadsheet in Brazil writes them", () => {
  it.each([
    ["R$ 59,90", "59.90"],
    ["R$59,90", "59.90"],
    ["r$ 1.234,56", "1234.56"],
    ["1.234,56", "1234.56"],
    ["1.234.567,8", "1234567.80"],
    ["1.234.567", "1234567.00"],
    ["1,234.56", "1234.56"],
    ["12,5", "12.50"],
    ["12.50", "12.50"],
    ["R$\u00A010,00", "10.00"],
  ])("reads the price %s as %s, exactly, as text", (cell, price) => {
    expect(importOne({ listPrice: cell }).value?.listPrice).toBe(price);
  });

  it("reads a cost with thousands and up to six decimals as text", () => {
    expect(
      importOne({ quantity: "1", unitCost: "R$ 1.234,123456" }).value
        ?.initialStock
    ).toEqual({ quantity: 1, unitCost: "1234.123456" });
  });

  it("never guesses 1.234: the row is refused and says how to write it", () => {
    expect(spreadsheetDecimal("1.234")).toEqual({ kind: "ambiguous" });
    expect(importOne({ listPrice: "1.234" }).errors).toEqual({
      listPrice: AMBIGUOUS_VALUE,
    });
    expect(
      importOne({ listPrice: "1.234", quantity: "2", unitCost: "2.500" }).errors
    ).toEqual({ listPrice: AMBIGUOUS_VALUE, unitCost: AMBIGUOUS_VALUE });
    // a group of thousands never starts with 0: "0.500" is half a real
    expect(spreadsheetDecimal("0.500")).toEqual({ kind: "ok", text: "0.500" });
  });

  it("reads a file saved by Excel in Portuguese: Windows-1252, ; and CRLF", () => {
    const text =
      "Nome;Preço de tabela;Quantidade;Custo de cada unidade;Categoria;Descrição\r\nCamiseta Ação;R$ 1.234,56;10;12,5;camisetas;Algodão\r\n";
    const bytes = new Uint8Array([...text].map((char) => char.charCodeAt(0)));
    const result = previewImport(bytes, categories);
    expect(result).toMatchObject({
      kind: "ok",
      ready: [
        {
          categoryId: categories[0].id,
          description: "Algodão",
          initialStock: { quantity: 10, unitCost: "12.5" },
          listPrice: "1234.56",
          name: "Camiseta Ação",
          rowNumber: 2,
        },
      ],
    });
  });

  it("reads a file saved by Google Sheets: UTF-8, , and quotes around the decimals", () => {
    const result = preview(
      'Nome,Preço de tabela,Quantidade,Custo de cada unidade\n"Boné, aba reta","59,90",3,\n'
    );
    expect(result.ready).toMatchObject([
      {
        initialStock: { quantity: 3, unitCost: null },
        listPrice: "59.90",
        name: "Boné, aba reta",
      },
    ]);
  });
});

describe("the header", () => {
  it("takes the usual names of each column, without accents, case or a trailing colon", () => {
    const result = preview(
      "PRODUTO;preco;Qtd;Custo unitário;categoria:;descricao;Fornecedor\nA;1;2;3;;;Fulano\n"
    );
    expect(result.ready).toMatchObject([
      {
        initialStock: { quantity: 2, unitCost: "3" },
        listPrice: "1.00",
        name: "A",
      },
    ]);
    expect(result.ignoredHeaders).toEqual(["Fornecedor"]);
  });

  it.each([
    ["Preço;Quantidade\n1;2\n", "missing_name_column"],
    ["Nome;Produto\nA;B\n", "repeated_column"],
    ["", "empty"],
  ])("refuses the file %j: %s", (text, problem) => {
    expect(previewImport(file(text), categories)).toEqual({
      kind: "problem",
      problem,
    });
    expect(
      IMPORT_FILE_PROBLEM_MESSAGES[
        problem as keyof typeof IMPORT_FILE_PROBLEM_MESSAGES
      ]
    ).toBeTruthy();
  });

  it("refuses a file of more than 500 rows or 1 MB, and says where a quote never closes", () => {
    expect(
      previewImport(
        file(
          `Nome\n${Array.from({ length: 501 }, (_, i) => `P${i}`).join("\n")}`
        ),
        categories
      )
    ).toEqual({ kind: "problem", problem: "too_many_rows" });
    expect(previewImport(new Uint8Array(1024 * 1024 + 1), categories)).toEqual({
      kind: "problem",
      problem: "too_large",
    });
    expect(previewImport(file('Nome\n"A\n'), categories)).toEqual({
      kind: "problem",
      problem: "unclosed_quote",
      rowNumber: 2,
    });
  });
});

describe("AC-8: hostile text is only text", () => {
  const hostile = [
    "=1+1",
    "+SOMA(A1:A2)",
    "-2+3",
    "@SUM(1)",
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
  ];

  it("keeps each one as it came, with no apostrophe and no escaping", () => {
    const result = preview(
      `Nome;Descrição\n${hostile.map((text) => `"${text}";"${text}"`).join("\n")}\n`
    );
    expect(result.ready.map((row) => row.name)).toEqual(hostile);
    expect(result.ready.map((row) => row.description)).toEqual(hostile);
  });
});

describe("names and categories", () => {
  it("imports the first row of a name the file repeats and says which one the later ones repeat", () => {
    const result = preview(
      "Nome\nCamiseta Azul\ncamiseta   azul\nBoné\nCAMISETA AZUL\n"
    );
    expect(result.ready.map((row) => row.rowNumber)).toEqual([2, 4]);
    expect(
      result.duplicates.map((row) => [row.rowNumber, row.firstRowNumber])
    ).toEqual([
      [3, 2],
      [5, 2],
    ]);
  });

  it("takes an active category of the store by its name, and leaves the others without one, with a warning", () => {
    const result = preview(
      "Nome;Categoria\nA; CAMISETAS \nB;Velhos\nC;Inexistente\nD;\n"
    );
    expect(result.ready.map((row) => row.categoryId)).toEqual([
      categories[0].id,
      null,
      null,
      null,
    ]);
    expect(result.categoryWarnings).toEqual([
      { rowNumber: 3 },
      { rowNumber: 4 },
    ]);
  });

  it("splits the ready rows by the names the store already has", () => {
    const result = preview("Nome\nCamiseta Azul\nBoné\n");
    const { existing, fresh } = splitExisting(result.ready, ["camiseta  azul"]);
    expect(existing.map((row) => row.name)).toEqual(["Camiseta Azul"]);
    expect(fresh.map((row) => row.name)).toEqual(["Boné"]);
  });
});
