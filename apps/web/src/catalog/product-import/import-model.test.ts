import { describe, expect, it } from "vitest";
import { previewImport } from "../product-import-rows";
import { IMPORT_MAX_BYTES } from "../product-import-csv";
import { createImportRun, skipStuckRow } from "../product-import-send";
import {
  enteredAndLeft,
  estimateText,
  headerNotes,
  importButtonLabel,
  importTemplateCsv,
  noCategoryText,
  overLimitText,
  planImport,
  planRoom,
  previewCounts,
  previewTableRows,
  readImportFile,
  resultFailedRows,
  resultTexts,
  stepAfter,
  stockEntered,
  stockText,
} from "./import-model";

const CATEGORY = {
  id: "0199c2d0-0000-7000-8000-0000000000c1",
  name: "Camisetas",
  status: "active" as const,
};

function preview(text: string) {
  const result = previewImport(new TextEncoder().encode(text), [CATEGORY]);
  if (result.kind !== "ok") {
    throw new Error(`expected a file that reads: ${result.problem}`);
  }
  return result;
}

let counter = 0;
const newId = () => {
  counter += 1;
  return `0199c2d0-0000-7000-8000-${String(counter).padStart(12, "0")}`;
};

/** A file of the three groups of the corte (valid, with an error, already in the store), a repeat and a category. */
const FILE = [
  "Produto;Preço;Qtd;Categoria;Marca",
  "Camiseta;49,90;10;Camisetas;X",
  "Boné;abc;;;",
  "Meia;12;2;Meias;",
  "Caneca;25;;;",
  "camiseta;50;;;",
].join("\n");

describe("the plan of an import", () => {
  it("splits the file into what enters, what exists, the errors and the repeats, in the order of the file", () => {
    const plan = planImport(preview(FILE), ["CANECA"], null);

    expect(plan.total).toBe(5);
    expect(plan.toSend.map((row) => row.name)).toEqual(["Camiseta", "Meia"]);
    expect(previewTableRows(plan)).toEqual([
      { name: "Camiseta", reason: null, rowNumber: 2, situation: "enters" },
      {
        name: "Boné",
        reason: "Preço de tabela: Informe um valor em reais, como 59,90.",
        rowNumber: 3,
        situation: "error",
      },
      {
        name: "Meia",
        reason:
          "A categoria “Meias” não existe na loja. O produto entra sem categoria.",
        rowNumber: 4,
        situation: "no_category",
      },
      {
        name: "Caneca",
        reason: "Já existe um produto com este nome. Fica como está.",
        rowNumber: 5,
        situation: "exists",
      },
      {
        name: "camiseta",
        reason: "Nome repetido na linha 2.",
        rowNumber: 6,
        situation: "error",
      },
    ]);
    expect(previewCounts(plan)).toEqual([
      "5 linhas no arquivo",
      "2 vão entrar",
      "1 já existe (fica como está)",
      "2 com erro (não entram)",
    ]);
    expect(noCategoryText(plan)).toBe(
      "1 produto entra sem categoria (a categoria do arquivo não existe na loja)."
    );
    expect(headerNotes(plan)).toEqual([
      "Lemos “Produto” como Nome.",
      "Lemos “Preço” como Preço de tabela.",
      "Lemos “Qtd” como Quantidade.",
      "A coluna “Marca” não é usada.",
    ]);
    expect(importButtonLabel(plan.toSend.length)).toBe("Importar 2 produtos");
    expect(importButtonLabel(1)).toBe("Importar 1 produto");
  });

  it("holds the rows the plan has room for, the first ones, and says how many are left out", () => {
    const file = "Nome\nA\nB\nC\nD\n";
    const plan = planImport(preview(file), [], 2);

    expect(plan.toSend.map((row) => row.name)).toEqual(["A", "B"]);
    expect(plan.overLimit.map((row) => row.name)).toEqual(["C", "D"]);
    expect(overLimitText(plan)).toBe(
      "Cabem 2 no seu plano. Entram as 2 primeiras; 2 ficam de fora."
    );
    expect(previewCounts(plan)).toEqual([
      "4 linhas no arquivo",
      "2 vão entrar",
      "2 além do limite do plano (ficam de fora)",
    ]);
    expect(overLimitText(planImport(preview(file), [], 1))).toBe(
      "Cabe 1 no seu plano. Entra a primeira; 3 ficam de fora."
    );
    expect(overLimitText(planImport(preview(file), [], 0))).toBe(
      "O plano chegou ao limite: nenhum produto novo cabe."
    );
    // it fits, or the plan was not read: nothing to say, and the server stops at the limit
    expect(overLimitText(planImport(preview(file), [], 4))).toBeNull();
    expect(overLimitText(planImport(preview(file), [], null))).toBeNull();
    // the rows the store already has take no room
    expect(planImport(preview(file), ["a", "b"], 2).overLimit).toEqual([]);
  });

  it("reads the room from the plan: the limit less what is used, never below zero, none without a limit", () => {
    const plan = (variants: number | null, used: number) => ({
      limits: { goals: null, images: null, variants },
      usage: { goals: 0, images: 0, variants: used },
    });
    expect(planRoom(plan(50, 45))).toBe(5);
    expect(planRoom(plan(50, 52))).toBe(0);
    expect(planRoom(plan(null, 3))).toBeNull();
    expect(planRoom(null)).toBeNull();
  });
});

describe("the notes of the header", () => {
  it("writes a long header cut, never a whole cell of the file", () => {
    const long = "M".repeat(200);
    const plan = planImport(preview(`Nome;${long}\nA;x\n`), [], null);
    expect(headerNotes(plan)).toEqual([
      `A coluna “${"M".repeat(60)}…” não é usada.`,
    ]);
  });
});

describe("the result", () => {
  it("counts what entered, what did not and what existed, and lists only the rows that did not enter", () => {
    const plan = planImport(preview(FILE), ["Caneca"], 1);
    const run = createImportRun(plan.toSend, newId);
    const [camiseta] = run.rows;
    if (!camiseta) {
      throw new Error("expected a row");
    }
    run.results.set(camiseta.rowNumber, {
      productId: camiseta.productId,
      rowNumber: camiseta.rowNumber,
      status: "created",
    });
    run.nextIndex = 1;

    expect(resultTexts(plan, run)).toEqual({
      existing: "1 já existia e ficou como estava.",
      limit: null,
      notEntered: "3 linhas não entraram.",
      title: "Importamos 1 produto.",
      unconfirmed: null,
    });
    expect(
      resultFailedRows(plan, run).map((row) => [row.rowNumber, row.kind])
    ).toEqual([
      [3, "error"],
      [4, "not_entered"],
      [6, "error"],
    ]);
    expect(stockEntered(run)).toBe(true);
  });

  it("says the rows the plan stopped on the server, without blaming the file", () => {
    const plan = planImport(preview("Nome\nA\nB\nC\n"), [], null);
    const run = createImportRun(plan.toSend, newId);
    for (const row of run.rows) {
      run.results.set(row.rowNumber, {
        rowNumber: row.rowNumber,
        status: "limit_reached",
      });
    }

    const texts = resultTexts(plan, run);
    expect(texts).toMatchObject({
      limit: "3 linhas não entraram porque o plano chegou ao limite.",
      title: "Nenhum produto foi importado.",
    });
    expect(texts.limit).not.toContain("arquivo");
    expect(stockEntered(run)).toBe(false);
  });
});

describe("rows with no answer", () => {
  it("are not confirmed, never said as rows that did not enter: the stop and the row left out", () => {
    const plan = planImport(preview("Nome\nA\nB\nC\n"), [], null);
    const run = createImportRun(plan.toSend, newId);
    const [a] = run.rows;
    if (!a) {
      throw new Error("expected a row");
    }
    run.results.set(a.rowNumber, {
      productId: a.productId,
      rowNumber: a.rowNumber,
      status: "created",
    });
    run.nextIndex = 1;
    // B kept stopping the run and was left out; C was never sent
    skipStuckRow(run);

    expect(resultTexts(plan, run)).toMatchObject({
      notEntered: null,
      title: "Importamos 1 produto.",
      unconfirmed:
        "2 linhas não foram confirmadas: confira na lista de produtos antes de enviar de novo.",
    });
    expect(
      resultFailedRows(plan, run).map((row) => [row.rowNumber, row.kind])
    ).toEqual([
      [3, "unconfirmed"],
      [4, "unconfirmed"],
    ]);
  });
});

describe("the file and the stops of the run", () => {
  it("does not read a file past the size of an import", async () => {
    const tooBig = {
      arrayBuffer: () => Promise.reject(new Error("read whole")),
      size: IMPORT_MAX_BYTES + 1,
    };
    expect(await readImportFile(tooBig)).toEqual({ kind: "too_large" });
    const small = {
      arrayBuffer: () => Promise.resolve(new Uint8Array([65]).buffer),
      size: 1,
    };
    expect(await readImportFile(small)).toEqual({
      bytes: new Uint8Array([65]),
      kind: "ok",
    });
  });

  it("makes each stop a step: the connection gone, the person's stop, the server's refusal in its own words", () => {
    expect(stepAfter({ kind: "done" }, null, true)).toEqual({
      kind: "result",
      limit: false,
    });
    expect(stepAfter({ kind: "limit_reached" }, null, true)).toEqual({
      kind: "result",
      limit: true,
    });
    expect(stepAfter({ kind: "aborted" }, "stopped", true)).toEqual({
      kind: "paused",
      pause: { kind: "stopped" },
    });
    expect(stepAfter({ kind: "aborted" }, "offline", false)).toEqual({
      kind: "paused",
      pause: { kind: "offline" },
    });
    // no answer with the connection up: the screen continues; with it down, it waits
    const lost = {
      error: new TypeError("Failed to fetch"),
      kind: "interrupted",
    } as const;
    expect(stepAfter(lost, null, true)).toBe("continue");
    expect(stepAfter(lost, null, false)).toEqual({
      kind: "paused",
      pause: { kind: "offline" },
    });
    const refusal = (code: string) =>
      stepAfter(
        { error: Object.assign(new Error(code), { code }), kind: "refused" },
        null,
        true
      );
    expect(refusal("FORBIDDEN")).toEqual({
      kind: "paused",
      pause: {
        kind: "refused",
        message: "Sua conta não tem acesso a esta loja ou a esta ação.",
      },
    });
    // never the words of the form of one product ("O produto não foi alterado.")
    expect(refusal("UNAUTHORIZED")).toEqual({
      kind: "paused",
      pause: { kind: "refused", message: "O servidor recusou o envio." },
    });
  });
});

describe("the progress says rows, never a promised time", () => {
  it("says what entered and what is left, and an estimate only from the pace seen, after three rows", () => {
    expect(enteredAndLeft(23, 23)).toBe("23 produtos entraram; 23 faltam.");
    expect(enteredAndLeft(1, 1)).toBe("1 produto entrou; 1 falta.");
    expect(estimateText(2, 12_000, 10)).toBeNull();
    // 6 s a row, 30 rows left: 3 minutes
    expect(estimateText(5, 30_000, 30)).toBe(
      "Estimativa pelo ritmo desta importação: cerca de 3 minutos."
    );
    expect(estimateText(5, 30_000, 4)).toBe(
      "Estimativa pelo ritmo desta importação: cerca de 1 minuto."
    );
    expect(estimateText(5, 30_000, 0)).toBeNull();
  });

  it("names no day for the opening stock: the server dates each row; past midnight, the day of each row", () => {
    expect(stockText(true)).toBe(
      "Estoque de abertura lançado com a data de hoje."
    );
    expect(stockText(false)).toBe(
      "Estoque de abertura lançado com a data do dia em que cada linha entrou."
    );
  });
});

describe("the template", () => {
  it("has the six columns with the form's labels and two rows marked as examples, and reads back as two rows", () => {
    const csv = importTemplateCsv();
    const [header, ...lines] = csv.slice(1).trimEnd().split("\r\n");
    expect(header).toBe(
      "Nome,Preço de tabela,Quantidade,Custo de cada unidade,Categoria,Descrição"
    );
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith("Exemplo: "))).toBe(true);
    const read = preview(csv);
    expect(read.refused).toEqual([]);
    expect(read.ready.map((row) => row.initialStock)).toEqual([
      { quantity: 10, unitCost: "18.00" },
      null,
    ]);
  });
});
