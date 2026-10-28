import { describe, expect, it } from "vitest";
import { previewImport } from "../product-import-rows";
import { IMPORT_MAX_BYTES } from "../product-import-csv";
import type { ProductImportRowInput } from "@polaris/contracts";
import { failedImportCsv } from "../product-import-failed-csv";
import {
  createImportRun,
  runImport,
  skipStuckRow,
  summarizeImport,
} from "../product-import-send";
import {
  enteredAndLeft,
  estimateText,
  FAILED_KIND_LABELS,
  failedCsvLabel,
  headerNotes,
  importButtonLabel,
  importTemplateCsv,
  noCategoryText,
  nothingToImportText,
  overLimitText,
  pauseText,
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

const CANCEL_OR_UNDO = /cancel|desfe|desfaz/i;

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

describe("a long category", () => {
  it("is cut in the reason of the preview, as a header is", () => {
    const long = "C".repeat(80);
    const plan = planImport(preview(`Nome;Categoria\nA;${long}\n`), [], null);
    expect(previewTableRows(plan)[0]?.reason).toBe(
      `A categoria “${"C".repeat(60)}…” não existe na loja. O produto entra sem categoria.`
    );
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
      limitReached: false,
      notEntered: "3 linhas não entraram, 1 delas pelo limite do plano.",
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
      limitReached: true,
      notEntered: "3 linhas não entraram: o plano chegou ao limite.",
      title: "Nenhum produto foi importado.",
    });
    expect(texts.notEntered).not.toContain("arquivo");
    expect(stockEntered(run)).toBe(false);
  });

  it("counts the rows of a limit reached in the middle once: one sentence with the total and the part (T446-3)", () => {
    const sentences = (file: string) => {
      const plan = planImport(preview(file), [], null);
      const run = createImportRun(plan.toSend, newId);
      run.rows.forEach((row, index) => {
        run.results.set(
          row.rowNumber,
          index === 0
            ? {
                productId: row.productId,
                rowNumber: row.rowNumber,
                status: "created",
              }
            : { rowNumber: row.rowNumber, status: "limit_reached" }
        );
      });
      run.nextIndex = run.rows.length;
      const texts = resultTexts(plan, run);
      return [texts.title, texts.notEntered, texts.unconfirmed].filter(
        (text) => text !== null
      );
    };
    // the limit took every row that did not enter
    expect(sentences("Nome\nUm\nDois\nTrês\n")).toEqual([
      "Importamos 1 produto.",
      "2 linhas não entraram: o plano chegou ao limite.",
    ]);
    // a row of the file with an error, and two of the limit: the total, then the part
    expect(
      sentences("Nome;Preço de tabela\nUm;1\nDois;2\nTrês;3\nQuatro;x\n")
    ).toEqual([
      "Importamos 1 produto.",
      "3 linhas não entraram, 2 delas pelo limite do plano.",
    ]);
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

describe("a row the server never answers (Léo, VC1)", () => {
  it("is skipped after its tries, the rows after it enter, and the result says it is not confirmed, never an error", async () => {
    const plan = planImport(preview("Nome\nA\nB\nC\n"), [], null);
    const run = createImportRun(plan.toSend, newId);
    const stuck = run.rows[1]?.rowNumber;
    const sent: number[] = [];
    let clock = 0;
    const dependencies = {
      now: () => clock,
      organizationId: "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0",
      retryAfterMs: () => null,
      send: (input: { rows: ProductImportRowInput[] }) => {
        const [row] = input.rows;
        sent.push(row?.rowNumber ?? 0);
        return row?.rowNumber === stuck
          ? Promise.reject(
              Object.assign(new Error("fault"), {
                code: "INTERNAL_SERVER_ERROR",
              })
            )
          : Promise.resolve({
              results: input.rows.map((each) => ({
                productId: each.productId,
                rowNumber: each.rowNumber,
                status: "created" as const,
              })),
            });
      },
      wait: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
    };

    expect((await runImport(run, dependencies)).kind).toBe("interrupted");
    const pause = stepAfter(
      { error: new Error("fault"), kind: "interrupted" },
      null,
      true
    );
    // the screen continues it by itself a few times; then the pause offers "Pular esta linha"
    expect(pause).toBe("continue");
    expect(
      pauseText({ kind: "interrupted" }, summarizeImport(run).entered, 2)
    ).toBe(
      "O servidor não respondeu a esta linha. 1 produto entrou; 2 faltam."
    );

    skipStuckRow(run);
    expect(await runImport(run, dependencies)).toEqual({ kind: "done" });
    expect(sent).toEqual([2, 3, 3, 3, 4]);
    expect(resultTexts(plan, run)).toMatchObject({
      notEntered: null,
      title: "Importamos 2 produtos.",
      unconfirmed:
        "1 linha não foi confirmada: confira na lista de produtos antes de enviar de novo.",
    });
    const failed = resultFailedRows(plan, run);
    expect(failed.map((row) => [row.rowNumber, row.kind])).toEqual([
      [3, "unconfirmed"],
    ]);
    expect(FAILED_KIND_LABELS.unconfirmed).toBe("Não confirmada");
    // the file of the rows that failed says it was not confirmed, not that it was refused
    const csvLine = failedImportCsv(failed).trimEnd().split("\r\n").at(-1);
    expect(csvLine).toBe(
      "B,,,,,,3,Esta linha não foi confirmada. Confira na lista de produtos antes de enviar de novo."
    );
  });
});

describe("Parar depois desta linha (Everton)", () => {
  it("says what entered stays and what is left, never cancelling or undoing", () => {
    const texts = (
      [
        { kind: "stopped" },
        { kind: "offline" },
        { kind: "interrupted" },
        { kind: "rate_limited" },
        { kind: "refused", message: "O servidor recusou o envio." },
      ] as const
    ).map((pause) => pauseText(pause, 2, 1));
    expect(texts[0]).toBe("Importação parada. 2 produtos entraram; 1 falta.");
    expect(texts[1]).toBe("Sem internet. 2 produtos entraram; 1 falta.");
    for (const text of texts) {
      expect(text).not.toMatch(CANCEL_OR_UNDO);
    }
  });

  it("leaves the rows it did not send as not confirmed, never as errors", () => {
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
    expect(resultTexts(plan, run).notEntered).toBeNull();
    expect(
      resultFailedRows(plan, run).map(
        (row) => FAILED_KIND_LABELS[row.kind as "unconfirmed"]
      )
    ).toEqual(["Não confirmada", "Não confirmada"]);
  });
});

describe("o botão do CSV do resultado (Everton)", () => {
  it("diz 'que falharam' sem linha não confirmada e 'para conferir' com ela", () => {
    expect(failedCsvLabel([{ kind: "error" }])).toBe(
      "Baixar a linha que falhou (CSV)"
    );
    expect(failedCsvLabel([{ kind: "error" }, { kind: "not_entered" }])).toBe(
      "Baixar as 2 linhas que falharam (CSV)"
    );
    expect(failedCsvLabel([{ kind: "unconfirmed" }])).toBe(
      "Baixar a linha para conferir (CSV)"
    );
    expect(
      failedCsvLabel([
        { kind: "error" },
        { kind: "unconfirmed" },
        { kind: "unconfirmed" },
      ])
    ).toBe("Baixar as 3 linhas para conferir (CSV)");
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
    // the pace of the import (2.5 s a call, ~3 s with the answer): 100 rows left are about 4 to 5 minutes
    expect(estimateText(10, 30_000, 100)).toBe(
      "Estimativa pelo ritmo desta importação: cerca de 5 minutos."
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
  it("has only the six columns with the form's labels: no example row that could become a product (T446-2)", () => {
    const csv = importTemplateCsv();
    expect(csv).toBe(
      "\uFEFFNome,Preço de tabela,Quantidade,Custo de cada unidade,Categoria,Descrição\r\n"
    );
    // read back, it has the columns and no row at all
    expect(preview(csv)).toMatchObject({
      ignoredHeaders: [],
      ready: [],
      refused: [],
    });
    // sent as it came, the preview says the file has no row, not that its rows were refused
    expect(nothingToImportText(planImport(preview(csv), [], null))).toBe(
      "O arquivo não tem linhas abaixo do cabeçalho."
    );
    expect(
      nothingToImportText(
        planImport(preview("Nome;Preço de tabela\nA;abc\n"), [], null)
      )
    ).toBe("Nenhuma linha do arquivo pode entrar.");
  });
});
