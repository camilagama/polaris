/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * Corte 2.5, PR B: the dialog "Importar planilha" in the real route, with the API answered by the test, which keeps
 * the products of the store as a server would (one product per row, the same product for the same IDs, "already
 * exists" for a name the store has, the plan's limit):
 * - AC-3: a file of the three groups (valid, with an error, already in the store); the products counted before the
 *   preview, after it and after the confirmation; nothing written before "Importar";
 * - AC-14: the actions from "Importar planilha" to the products in the list, recorded in the report of the test and
 *   compared with three products by hand (AC-25 of the Início: 6 each);
 * - AC-10: the button off with its reason without a connection; the connection lost in the middle (an answer lost with
 *   it), "Continuar de onde parou" with the same IDs, and no product twice (AC-5);
 * - AC-6: the plan's room in the preview (only the first ones, with "Você usa N de M"), and the plan's refusal in the
 *   middle said as the limit, never as a fault of the file;
 * - AC-13: the result in a status, the table with its headers, no sideways scroll at 320 px.
 * Each slice is one row and goes at most every 6 s (`IMPORT_SLICE_INTERVAL_MS`): the tests keep few rows.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const NOW = "2026-10-27T12:00:00.000Z";
const IMPORT_DIALOG = "Importar planilha";
const STOCK_TEXT = "Estoque de abertura lançado com a data de hoje.";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFLINE_REASON = /Importar precisa de conexão/;
const BLAMES_THE_FILE = /arquivo tem erro/i;
/** Three products by hand, as AC-25 of the Início measured each one (`product-opening-stock.e2e.ts`). */
const BY_HAND_ACTIONS = 3 * 6;
/** The hypothesis of the corte: up to 6 taps and one choice of file. */
const MAX_TAPS = 6;

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

const planOf = (used: number) => ({
  accessEndsAt: null,
  cycleMonths: null,
  kept: { historyMonths: 3, products: 50, sales: 47 },
  limits: { goals: 1, images: 50, variants: 50 },
  method: null,
  nextCharge: null,
  offer: { methods: ["card"], prices: [{ amount: "24.90", cycleMonths: 1 }] },
  recovery: null,
  refund: null,
  refundPending: false,
  refundWindowEndedOn: null,
  renewalCancelled: false,
  resubscribeFrom: null,
  state: "free",
  trialAvailable: false,
  usage: { goals: 0, images: 0, variants: used },
});

interface ImportRow {
  initialStock: {
    commandId: string;
    quantity: number;
    unitCost: string | null;
  } | null;
  listPrice: string | null;
  name: string;
  productId: string;
  rowNumber: number;
}

interface BatchCall {
  rows: ImportRow[];
}

const productOf = (name: string, id: string) => ({
  archivedAt: null,
  categoryId: null,
  createdAt: NOW,
  deletedAt: null,
  description: null,
  id,
  name,
  organizationId: ORGANIZATION.id,
  status: "active",
  updatedAt: NOW,
  version: 1,
});

interface ServerOptions {
  /** What each call of `product.importBatch` does before the server answers (by its number, from 1). */
  beforeAnswer?: (call: number, route: Route) => Promise<"answer" | "lost">;
  existing?: readonly string[];
  /** The variants of the store the plan holds; another tab may take some in the middle (`takeRoom`). */
  room?: number;
  used?: number;
}

/** The store as a server keeps it: the products, the calls of the import and the reads of the preview. */
async function openProducts(
  page: Page,
  { beforeAnswer, existing = [], room = 49, used = 1 }: ServerOptions = {}
) {
  const store = {
    batches: [] as BatchCall[],
    namesAsked: 0,
    products: existing.map((name, index) =>
      productOf(name, `0199c2d0-0000-7000-8000-00000000b00${index}`)
    ),
    room,
    used,
  };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  const createRow = (row: ImportRow) => {
    if (store.products.some((product) => product.id === row.productId)) {
      return {
        productId: row.productId,
        rowNumber: row.rowNumber,
        status: "repeated",
      };
    }
    const key = row.name.toLowerCase();
    if (store.products.some((product) => product.name.toLowerCase() === key)) {
      return { rowNumber: row.rowNumber, status: "exists_by_name" };
    }
    if (store.room <= 0) {
      return { rowNumber: row.rowNumber, status: "limit_reached" };
    }
    store.room -= 1;
    store.used += 1;
    store.products.push(productOf(row.name, row.productId));
    return {
      productId: row.productId,
      rowNumber: row.rowNumber,
      status: "created",
    };
  };
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    const body = () =>
      (route.request().postDataJSON() as { json: Record<string, unknown> })
        .json;
    switch (procedure) {
      case "organization/listMine":
        return route.fulfill(
          rpc({ billingSelfService: true, organizations: [ORGANIZATION] })
        );
      case "category/list":
        return route.fulfill(rpc({ categories: [] }));
      case "product/list":
        return route.fulfill(rpc({ products: store.products }));
      case "inventory/listBalances":
        return route.fulfill(
          rpc({ entries: [], more: false, nextCursor: null })
        );
      case "paymentProfile/list":
        return route.fulfill(rpc({ profiles: [] }));
      case "billing/readPlan":
        return route.fulfill(rpc(planOf(store.used)));
      case "product/namesExisting": {
        store.namesAsked += 1;
        const names = body().names as string[];
        const have = new Set(store.products.map((p) => p.name.toLowerCase()));
        return route.fulfill(
          rpc({ names: names.filter((name) => have.has(name.toLowerCase())) })
        );
      }
      case "product/importBatch": {
        const rows = body().rows as ImportRow[];
        store.batches.push({ rows });
        const results = rows.map(createRow);
        const fate =
          (await beforeAnswer?.(store.batches.length, route)) ?? "answer";
        return fate === "lost"
          ? route.abort("internetdisconnected")
          : route.fulfill(rpc({ results }));
      }
      default:
        return route.abort("internetdisconnected");
    }
  });
  await page.goto("/products");
  await expect(page.getByRole("heading", { name: "Produtos" })).toBeVisible();
  return store;
}

const csvFile = (lines: readonly string[]) => ({
  buffer: Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8"),
  mimeType: "text/csv",
  name: "produtos.csv",
});

const dialogOf = (page: Page) =>
  page.getByRole("dialog", { name: IMPORT_DIALOG });

async function chooseFile(page: Page, lines: readonly string[]) {
  await dialogOf(page)
    .locator('input[type="file"]')
    .setInputFiles(csvFile(lines));
  await expect(dialogOf(page).getByText("produtos.csv")).toBeVisible();
}

/** The status of the dialog that says a step (its text is the step's own). */
const statusIn = (dialog: Locator, text: string | RegExp) =>
  dialog.getByRole("status").filter({ hasText: text });

test("AC-3 e AC-14: prévia de 3 grupos não grava nada; a confirmação cria só as válidas, e o resultado bate com a loja", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const store = await openProducts(page, { existing: ["Caneca"] });
  let taps = 0;
  const tap = async (locator: Locator) => {
    taps += 1;
    await locator.click();
  };
  const before = store.products.length;

  await tap(page.getByRole("button", { name: "Importar planilha" }));
  const dialog = dialogOf(page);
  await expect(dialog.getByText("Passo 1 de 4 · Arquivo")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Escolher arquivo" })
  ).toBeFocused();
  await expect(
    dialog.getByText(
      "Cria produtos novos a partir de um arquivo CSV. Nada do que já existe muda ou some."
    )
  ).toBeVisible();
  // the one choice of a file
  await chooseFile(page, [
    "Nome;Preço de tabela;Quantidade;Custo de cada unidade",
    "Camiseta básica;49,90;10;12,50",
    "Boné;abc;;",
    "caneca;25;;",
    "Meia;12;;",
  ]);
  await tap(dialog.getByRole("button", { name: "Ver a prévia" }));

  await expect(dialog.getByText("Passo 2 de 4 · Prévia")).toBeVisible();
  await Promise.all(
    [
      "4 linhas no arquivo",
      "2 vão entrar",
      "1 já existe (fica como está)",
      "1 com erro (não entra)",
    ].map((line) =>
      expect(dialog.getByText(line, { exact: true })).toBeVisible()
    )
  );
  await expect(
    dialog.getByText(
      "O estoque informado é de abertura, com a data de hoje. Linha com quantidade e sem custo entra com custo desconhecido."
    )
  ).toBeVisible();
  // the table opens on the rows with an error, with its headers
  const errors = dialog.getByRole("table", {
    name: "Linhas do arquivo: Com erro",
  });
  await expect(errors.getByRole("columnheader")).toHaveText([
    "Linha",
    "Nome",
    "Situação",
  ]);
  await expect(errors.getByRole("row").nth(1)).toContainText("3");
  await expect(errors.getByRole("row").nth(1)).toContainText(
    "Preço de tabela: Informe um valor em reais, como 59,90."
  );
  await dialog.getByRole("tab", { name: "Já existem (1)" }).click();
  await expect(
    dialog.getByRole("table", { name: "Linhas do arquivo: Já existem" })
  ).toContainText("Já existe um produto com este nome. Fica como está.");
  // after the preview: nothing written
  expect(store.batches).toHaveLength(0);
  expect(store.products).toHaveLength(before);

  await tap(dialog.getByRole("button", { name: "Importar 2 produtos" }));
  await expect(statusIn(dialog, "Importamos 2 produtos.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(statusIn(dialog, "1 linha não entrou.")).toBeVisible();
  await expect(
    statusIn(dialog, "1 já existia e ficou como estava.")
  ).toBeVisible();
  await expect(dialog.getByText(STOCK_TEXT, { exact: true })).toBeVisible();
  // the store has the two valid rows, once each, and nothing of the others
  expect(store.products.map((product) => product.name).sort()).toEqual(
    ["Caneca", "Camiseta básica", "Meia"].sort()
  );
  // one row per call (the measure of the Free plan), the IDs named once, the money as exact text
  expect(store.batches.map((batch) => batch.rows.length)).toEqual([1, 1]);
  const [camiseta] = store.batches[0]?.rows ?? [];
  expect(camiseta).toMatchObject({
    initialStock: { quantity: 10, unitCost: "12.50" },
    listPrice: "49.90",
    name: "Camiseta básica",
    rowNumber: 2,
  });
  expect(camiseta?.productId).toMatch(UUID);
  expect(camiseta?.initialStock?.commandId).toMatch(UUID);

  // the rows that did not enter, in a table and in a CSV to fix and send again
  await expect(
    dialog
      .getByRole("table", { name: "Linhas que não entraram" })
      .getByRole("row")
  ).toHaveCount(2);
  const download = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Baixar a linha que falhou (CSV)" })
    .click();
  const file = await download;
  const text = await (await file.createReadStream()).toArray();
  const csv = Buffer.concat(text).toString("utf8");
  expect(csv).toContain("Linha,Motivo");
  expect(csv).toContain(
    'Boné,abc,,,,,3,"Preço de tabela: Informe um valor em reais, como 59,90."'
  );

  await tap(dialog.getByRole("button", { name: "Ver os produtos" }));
  await expect(dialog).toHaveCount(0);
  const list = page.getByRole("list", { name: "Produtos" });
  await expect(list.getByText("Camiseta básica")).toBeVisible();
  await expect(list.getByText("Meia")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Importar planilha" })
  ).toBeFocused();

  testInfo.annotations.push({
    description: `${taps} toques e 1 escolha de arquivo (3 produtos à mão: ${BY_HAND_ACTIONS} ações)`,
    type: "AC-14",
  });
  await testInfo.attach("AC-14-contagem-de-acoes.json", {
    body: JSON.stringify(
      {
        escolhasDeArquivo: 1,
        hipoteseDoCorte: `até ${MAX_TAPS} toques e 1 escolha de arquivo`,
        metodo:
          "um toque ou uma escolha = uma ação (o mesmo do AC-25 do Início)",
        passos: [
          "tocar em Importar planilha",
          "escolher o arquivo",
          "tocar em Ver a prévia",
          "tocar em Importar 2 produtos",
          "tocar em Ver os produtos",
        ],
        toques: taps,
        tresProdutosAMao: BY_HAND_ACTIONS,
      },
      null,
      2
    ),
    contentType: "application/json",
  });
  console.log(
    `AC-14: ${taps} toques e 1 escolha de arquivo (hipótese: até ${MAX_TAPS}; 3 produtos à mão: ${BY_HAND_ACTIONS})`
  );
  expect(taps).toBeLessThanOrEqual(MAX_TAPS);
});

test("AC-10 e AC-5: a conexão cai no meio (com uma resposta perdida), a tela diz o que entrou e o que falta, e continua sem duplicar", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const store = await openProducts(page, {
    beforeAnswer: async (call) => {
      if (call === 2) {
        // the server created the second row, and the connection went before its answer
        await page.context().setOffline(true);
        return "lost";
      }
      return "answer";
    },
  });
  await page.getByRole("button", { name: "Importar planilha" }).click();
  const dialog = dialogOf(page);
  await chooseFile(page, ["Nome", "Alfa", "Beta", "Gama"]);
  await dialog.getByRole("button", { name: "Ver a prévia" }).click();
  await dialog.getByRole("button", { name: "Importar 3 produtos" }).click();
  await expect(dialog.getByText("Passo 3 de 4 · Importando")).toBeVisible();
  // nothing closes the dialog while rows are on their way
  await expect(dialog.getByRole("button", { name: "Fechar" })).toHaveCount(0);

  await expect(
    statusIn(dialog, "Sem internet. 1 produto entrou; 2 faltam.")
  ).toBeVisible({ timeout: 30_000 });
  const again = dialog.getByRole("button", { name: "Continuar de onde parou" });
  await expect(again).toHaveAttribute("aria-disabled", "true");
  await expect(again).toHaveAccessibleDescription(OFFLINE_REASON);
  expect(store.products).toHaveLength(2);

  await page.context().setOffline(false);
  await expect(again).not.toHaveAttribute("aria-disabled", "true");
  await again.click();
  await expect(statusIn(dialog, "Importamos 3 produtos.")).toBeVisible({
    timeout: 45_000,
  });
  await expect(statusIn(dialog, "não entr")).toHaveCount(0);
  // the row whose answer was lost went again with the same IDs: the server said "repeated", nothing twice
  const sent = store.batches.map((batch) => batch.rows[0]);
  expect(sent.map((row) => row?.name)).toEqual([
    "Alfa",
    "Beta",
    "Beta",
    "Gama",
  ]);
  expect(sent[1]?.productId).toBe(sent[2]?.productId);
  expect(store.products.map((product) => product.name)).toEqual([
    "Alfa",
    "Beta",
    "Gama",
  ]);
});

test("AC-10: sem conexão, Importar planilha fica desligado com o motivo e não abre nada", async ({
  page,
}) => {
  await openProducts(page);
  await page.context().setOffline(true);
  const button = page.getByRole("button", { name: "Importar planilha" });
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).toHaveAccessibleDescription(
    "Importar planilha precisa de conexão."
  );
  await button.click({ force: true });
  await expect(dialogOf(page)).toHaveCount(0);
});

test("AC-6: a prévia diz quantas cabem no plano e importa só as primeiras, com 'Você usa N de M'", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const store = await openProducts(page, { room: 2, used: 48 });
  await page.getByRole("button", { name: "Importar planilha" }).click();
  const dialog = dialogOf(page);
  await chooseFile(page, ["Nome", "Um", "Dois", "Três", "Quatro"]);
  await dialog.getByRole("button", { name: "Ver a prévia" }).click();

  await expect(
    dialog.getByText(
      "Cabem 2 no seu plano. Entram as 2 primeiras; 2 ficam de fora."
    )
  ).toBeVisible();
  await expect(
    dialog.getByText("Você usa 48 de 50 variantes no plano Free.")
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Conhecer o Pro" })
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "Fora do limite (2)" }).click();
  await expect(
    dialog.getByRole("table", { name: "Linhas do arquivo: Fora do limite" })
  ).toContainText("Quatro");
  await dialog.getByRole("button", { name: "Importar 2 produtos" }).click();

  await expect(statusIn(dialog, "Importamos 2 produtos.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(statusIn(dialog, "2 linhas não entraram.")).toBeVisible();
  // no row past the limit was sent
  expect(
    store.batches.flatMap((batch) => batch.rows.map((row) => row.name))
  ).toEqual(["Um", "Dois"]);
});

test("AC-6: o plano chega ao limite no meio (outra aba criou produto): diz o limite, sem culpar o arquivo", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const store = await openProducts(page, {
    beforeAnswer: (call) => {
      if (call === 1) {
        // another tab takes the last room after the first row
        store.room = 0;
      }
      return Promise.resolve("answer");
    },
    room: 5,
    used: 45,
  });
  await page.getByRole("button", { name: "Importar planilha" }).click();
  const dialog = dialogOf(page);
  await chooseFile(page, ["Nome", "Um", "Dois", "Três"]);
  await dialog.getByRole("button", { name: "Ver a prévia" }).click();
  await dialog.getByRole("button", { name: "Importar 3 produtos" }).click();

  await expect(statusIn(dialog, "Importamos 1 produto.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    statusIn(dialog, "2 linhas não entraram porque o plano chegou ao limite.")
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Conhecer o Pro" })
  ).toBeVisible();
  await expect(
    dialog.getByRole("table", { name: "Linhas que não entraram" })
  ).toContainText("O plano chegou ao limite. Nada foi criado nesta linha.");
  await expect(dialog.getByText(BLAMES_THE_FILE)).toHaveCount(0);
  // the server stopped at the limit: the third row was never sent
  expect(store.batches).toHaveLength(2);
});

test("o checklist do Início abre a importação pelo endereço, e o arquivo lido fica ao fechar por Esc", async ({
  page,
}) => {
  await openProducts(page);
  await page.goto("/products?importar=1");
  const dialog = dialogOf(page);
  await expect(dialog.getByText("Passo 1 de 4 · Arquivo")).toBeVisible();
  await chooseFile(page, ["Nome", "Um"]);
  await dialog.getByRole("button", { name: "Ver a prévia" }).click();
  await expect(dialog.getByText("Passo 2 de 4 · Prévia")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Importar planilha" }).click();
  await expect(dialog.getByText("Passo 2 de 4 · Prévia")).toBeVisible();
  await expect(dialog.getByText("1 vai entrar", { exact: true })).toBeVisible();
});

test("AC-8 na tela: nome hostil do arquivo aparece como texto, na prévia e no resultado, sem virar HTML", async ({
  page,
}) => {
  const store = await openProducts(page);
  await page.getByRole("button", { name: "Importar planilha" }).click();
  const dialog = dialogOf(page);
  const markup = "<img src=x onerror=window.polarisHostile=1>";
  const formula = "=cmd|' /C calc'!A0";
  await chooseFile(page, [
    "Nome;Preço de tabela",
    `${markup};10`,
    `${formula};abc`,
  ]);
  await dialog.getByRole("button", { name: "Ver a prévia" }).click();
  await dialog.getByRole("tab", { name: "Todas (2)" }).click();
  const all = dialog.getByRole("table", { name: "Linhas do arquivo: Todas" });
  await expect(all.getByText(markup, { exact: true })).toBeVisible();
  await expect(all.getByText(formula, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Importar 1 produto" }).click();
  await expect(statusIn(dialog, "Importamos 1 produto.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    dialog
      .getByRole("table", { name: "Linhas que não entraram" })
      .getByText(formula, { exact: true })
  ).toBeVisible();
  // no element came out of the text, and nothing ran
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { polarisHostile?: number }).polarisHostile
    )
  ).toBeUndefined();
  // the name went to the server as it came: neutralizing is for the CSV on the way out
  expect(store.batches[0]?.rows[0]?.name).toBe(markup);
});

test("AC-13: a prévia com nomes longos não rola de lado a 320 px", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 320 });
  await openProducts(page);
  await page.getByRole("button", { name: "Importar planilha" }).click();
  const dialog = dialogOf(page);
  const long = "Camiseta de algodão orgânico com estampa exclusiva tamanho GG";
  await chooseFile(page, [
    "Nome;Preço de tabela;Categoria",
    `${long};abc;`,
    `${long} azul;10;Inexistente`,
    `${"x".repeat(80)};10;`,
  ]);
  await dialog.getByRole("button", { name: "Ver a prévia" }).click();
  await expect(dialog.getByText("Passo 2 de 4 · Prévia")).toBeVisible();
  await dialog.getByRole("tab", { name: "Todas (3)" }).click();
  const overflow = await page.evaluate(() => {
    const body = document.querySelector('[data-slot="dialog-body"]');
    return {
      body: body ? body.scrollWidth - body.clientWidth : -1,
      page: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(overflow).toEqual({ body: 0, page: 0 });
});
