import { describe, expect, it } from "vitest";
import { failedImportCsv, failedImportRows } from "./product-import-failed-csv";
import { type ImportPreview, previewImport } from "./product-import-rows";
import { createImportRun } from "./product-import-send";

const file = (text: string) => new TextEncoder().encode(text);

function preview(text: string): Extract<ImportPreview, { kind: "ok" }> {
  const result = previewImport(file(text), []);
  if (result.kind !== "ok") {
    throw new Error(result.problem);
  }
  return result;
}

let counter = 0;
const newId = () => {
  counter += 1;
  return `0199c2d0-0000-7000-8000-${String(counter).padStart(12, "0")}`;
};

describe("the CSV of the rows that failed", () => {
  it("neutralizes every cell a spreadsheet would run as a formula: =, +, -, @, tab and CR", () => {
    const csv = failedImportCsv([
      {
        reason: "Já existe um produto com este nome.",
        rowNumber: 2,
        source: {
          category: "@SUM(1)",
          description: "\tescondido",
          listPrice: "+SOMA(A1)",
          name: '=HYPERLINK("http://x")',
          quantity: "-2",
          unitCost: "\r1",
        },
      },
    ]);

    expect(csv.codePointAt(0)).toBe(0xfe_ff);
    const [header, line] = csv.slice(1).split("\r\n");
    expect(header).toBe(
      "Nome,Preço de tabela,Quantidade,Custo de cada unidade,Categoria,Descrição,Linha,Motivo"
    );
    // the leading apostrophe on each one (a plain number like -2 stays a number, as in the data export)
    expect(line).toBe(
      `"'=HYPERLINK(""http://x"")",'+SOMA(A1),-2,"'\r1",'@SUM(1),'\tescondido,2,Já existe um produto com este nome.`
    );
  });

  it("lists, in the order of the file, the rows refused in the preview, the repeats of the file and the server's refusals", () => {
    const result = preview(
      "Nome;Preço de tabela\n=cmd|' /C calc'!A0;abc\nBoné;10\nboné;11\nMeia;12\nLuva;13\n"
    );
    const run = createImportRun(result.ready, newId);
    const [bone, meia, luva] = run.rows;
    if (!(bone && meia && luva)) {
      throw new Error("expected three ready rows");
    }
    run.results.set(bone.rowNumber, {
      productId: bone.productId,
      rowNumber: bone.rowNumber,
      status: "created",
    });
    run.results.set(meia.rowNumber, {
      rowNumber: meia.rowNumber,
      status: "exists_by_name",
    });
    run.results.set(luva.rowNumber, {
      rowNumber: luva.rowNumber,
      status: "limit_reached",
    });

    const rows = failedImportRows({
      duplicates: result.duplicates,
      refused: result.refused,
      run,
      sources: new Map(result.ready.map((row) => [row.rowNumber, row.source])),
    });

    expect(rows.map((row) => [row.rowNumber, row.reason])).toEqual([
      [2, "Preço de tabela: Informe um valor em reais, como 59,90."],
      [4, "Nome repetido na linha 3."],
      [5, "Já existe um produto com este nome."],
      [6, "O plano chegou ao limite de variantes."],
    ]);
    const csv = failedImportCsv(rows);
    expect(csv).toContain(`'=cmd|' /C calc'!A0,abc,`);
    expect(csv).not.toContain("\n=cmd");
    expect(csv).not.toContain(",=cmd");
  });

  it("lists the rows the preview found in the store and the rows of the run with no answer", () => {
    const result = preview("Nome\nBoné\nMeia\nLuva\n");
    const run = createImportRun(result.ready.slice(1), newId);
    const [meia] = run.rows;
    if (!meia) {
      throw new Error("expected a row");
    }
    run.results.set(meia.rowNumber, {
      productId: meia.productId,
      rowNumber: meia.rowNumber,
      status: "created",
    });

    const rows = failedImportRows({
      duplicates: [],
      existing: result.ready.slice(0, 1),
      refused: [],
      run,
      sources: new Map(result.ready.map((row) => [row.rowNumber, row.source])),
    });

    expect(rows.map((row) => [row.rowNumber, row.reason])).toEqual([
      [2, "Já existe um produto com este nome."],
      [
        4,
        "Esta linha não foi confirmada. Confira na lista de produtos antes de enviar de novo.",
      ],
    ]);
  });
});
