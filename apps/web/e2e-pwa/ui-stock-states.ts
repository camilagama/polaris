/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Locator, Page, Route } from "@playwright/test";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The states of the stock screen the interface guardrails measure: the screen in the lab of the screens
 * (`/offline-screens-lab?screen=stock`) over the real offline runtime, with the server answered by the test
 * (`page.route`) and synthetic data only. The lab's own controls are hidden at the end of each state, so what
 * is measured is the screen alone. Same shape as `ui-sale-states.ts`.
 */
const SHIRT_ROW = /Camiseta do teste/;
const SUBMITTED =
  /Confirmar (?:recebimento|contagem|baixa|custo)|Tentar novamente \(seguro\)/;

const rpc = (body: unknown, status = 200) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

const entry = (
  n: number,
  productName: string,
  value: string | null,
  quantity: number,
  cost: string | null,
  overrides: Record<string, unknown> = {}
) => ({
  isDefaultVariant: value === null,
  listPrice: "50.00",
  movingAverageCost: cost,
  productId: `0199c2d0-0000-7000-8000-0000000000f${n}`,
  productName,
  productStatus: "active",
  quantity,
  sku: `SKU-${n}`,
  updatedAt: "2026-10-14T12:00:00.000Z",
  values: value === null ? [] : [{ optionName: "cor", optionValueName: value }],
  variantId: `0199c2d0-0000-7000-8000-0000000000b${n}`,
  version: 1,
  ...overrides,
});

// the cost of the shirt is unknown ("Informar custo" sets it), the jeans have one, the cap is out of stock and the
// mug is archived, so the list shows every tone a row has
const SHIRT = entry(1, "Camiseta do teste", "Azul", 5, null);
const JEANS = entry(2, "Calça jeans", "42", 3, "62.400000");
const CAP = entry(3, "Boné aba reta", null, 0, "18.000000", { sku: null });
const MUG = entry(
  4,
  "Caneca esmaltada de uma loja com um nome bem comprido",
  "Branca",
  12,
  "9.500000",
  {
    productStatus: "archived",
  }
);
const ROWS = [SHIRT, JEANS, CAP, MUG];

const balance = (quantity: number, cost: string | null) => ({
  movingAverageCost: cost,
  quantity,
  variantId: SHIRT.variantId,
  version: 2,
});

const movement = {
  commandId: "00000000-0000-4000-8000-000000000001",
  commandIndex: 0,
  commandVersion: 1,
  createdAt: "2026-10-15T15:00:01.000Z",
  id: "00000000-0000-4000-8000-000000000002",
  movementType: "receipt",
  occurredOn: "2026-10-15",
  organizationId: "0199c2d0-0000-7000-8000-00000000a001",
  productId: SHIRT.productId,
  quantityDelta: 10,
  unitCost: "12.500000",
  variantId: SHIRT.variantId,
};

const refusal = (reason: string) =>
  rpc(
    {
      code: "BAD_REQUEST",
      data: { reason },
      defined: true,
      message: "Bad request",
      status: 400,
    },
    400
  );

/** The rows the read asks for: by balance and by cost, as the server filters them. */
function matching(body: string, entries: readonly unknown[]) {
  return (entries as (typeof SHIRT)[]).filter(
    (row) =>
      (!body.includes("without_stock") || row.quantity === 0) &&
      (!body.includes('"with_stock"') || row.quantity > 0) &&
      (!body.includes('"cost":"unknown"') || row.movingAverageCost === null)
  );
}

/**
 * The reads of "Precisa de ação" (a page of 100 of active products) are told apart from the list's (a page of 50):
 * they count the rows that fit, whatever the list was asked for.
 */
function attentionPage(body: string, entries: readonly unknown[]) {
  if (!body.includes('"limit":100')) {
    return null;
  }
  return {
    entries: matching(body, entries).filter(
      (row) => row.productStatus === "active"
    ),
    nextCursor: null,
  };
}

interface ServedList {
  /** Called for each read of the list, with the body the screen sent; answers the route. */
  answer: (body: string, route: Route) => Promise<void> | void;
}

const served = (
  entries: readonly unknown[],
  nextCursor: string | null = null
): ServedList => ({
  answer: (body, route) =>
    route.fulfill(
      rpc(
        attentionPage(body, entries) ?? {
          entries: matching(body, entries),
          nextCursor,
        }
      )
    ) as Promise<void>,
});

async function serveList(page: Page, list: ServedList) {
  await page.route("**/rpc/inventory/listBalances", (route: Route) =>
    list.answer(route.request().postData() ?? "", route)
  );
}

const serverFailure = () =>
  rpc(
    {
      code: "INTERNAL_SERVER_ERROR",
      data: undefined,
      defined: false,
      message: "Internal server error",
      status: 500,
    },
    500
  );

/** The list of the stock screen answered with the synthetic rows: for the screen opened in the real shell. */
export async function serveStockRows(page: Page) {
  await serveList(page, served(ROWS, "cursor-2"));
}

/** Starts the lab's runtime and waits for the screen; the network is the lab's checkbox. */
async function openStockLab(page: Page, list: ServedList) {
  await serveList(page, list);
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=stock");
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await page.getByRole("heading", { exact: true, name: "Estoque" }).waitFor();
}

/** Hides the lab's own controls and waits for the fonts: what stays is the screen. */
async function showScreenAlone(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-lab-chrome]")) {
      (element as HTMLElement).hidden = true;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
}

const rowOf = (page: Page, name: RegExp): Locator =>
  page.getByRole("listitem").filter({ hasText: name });

async function openList(page: Page) {
  await openStockLab(page, served(ROWS, "cursor-2"));
  await rowOf(page, SHIRT_ROW).waitFor();
}

async function openCommand(page: Page, action: string, product: string) {
  await page
    .getByRole("button", {
      name: new RegExp(`^${action} estoque de ${product}`),
    })
    .click();
}

const review = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Revisar" });

const confirm = (page: Page) => page.getByRole("button", { name: SUBMITTED });

async function fillReceipt(page: Page) {
  await page.getByLabel("Quantidade recebida").fill("10");
  await page.getByLabel("Custo unitário (R$)").fill("12,50");
}

/** Opens a select, picks the option and waits for the popup to leave: a slow machine still shows it fading out. */
async function chooseOption(page: Page, trigger: Locator, option: Locator) {
  await trigger.click();
  await option.click();
  await page.getByRole("listbox").waitFor({ state: "detached" });
}

async function openCost(page: Page) {
  await openList(page);
  await page
    .getByRole("button", { name: "Informar custo de Camiseta do teste · Azul" })
    .click();
  await page.getByLabel("Custo de cada unidade (R$)").waitFor();
}

export const stockStates = {
  /** A count of the jeans, whose cost is known: the quantity and the date, no cost field. */
  async count(page: Page) {
    await openList(page);
    await openCommand(page, "Contar", "Calça jeans");
    await page.getByLabel("Quantidade contada").fill("7");
    await showScreenAlone(page);
  },

  /** The shirt has units and no cost: the cost panel, with the units it covers as a line and the cost field. */
  async cost(page: Page) {
    await openCost(page);
    await showScreenAlone(page);
  },

  /** The cost typed and reviewed: the summary that says it cannot be edited, before the confirmation. */
  async costConfirming(page: Page) {
    await openCost(page);
    await page.getByLabel("Custo de cada unidade (R$)").fill("12,50");
    await review(page).click();
    await confirm(page).waitFor();
    await showScreenAlone(page);
  },

  async costDone(page: Page) {
    await page.route("**/rpc/inventory/inventoryCount", (route: Route) =>
      route.fulfill(
        rpc({
          balance: balance(5, "12.500000"),
          movement: { ...movement, movementType: "count", quantityDelta: 0 },
          replayed: false,
        })
      )
    );
    await openCost(page);
    await page.getByLabel("Custo de cada unidade (R$)").fill("12,50");
    await review(page).click();
    await confirm(page).click();
    await page.getByText("Custo informado: R$ 12,50 por unidade.").waitFor();
    await showScreenAlone(page);
  },

  /** The list has no variant at all. */
  async empty(page: Page) {
    await openStockLab(page, served([]));
    await page.getByText("Nenhuma variante cadastrada.").waitFor();
    await showScreenAlone(page);
  },

  /** The reads of "Precisa de ação" fail while the list answers: the strip says its notices are unavailable. */
  async attentionUnavailable(page: Page) {
    await openStockLab(page, {
      answer: (body, route) =>
        route.fulfill(
          body.includes('"limit":100')
            ? serverFailure()
            : rpc({ entries: matching(body, ROWS), nextCursor: "cursor-2" })
        ) as Promise<void>,
    });
    await rowOf(page, SHIRT_ROW).waitFor();
    await page
      .getByText("Avisos do estoque indisponíveis agora.")
      .waitFor({ timeout: 20_000 });
    await showScreenAlone(page);
  },

  /** The read failed: the message and the retry. */
  async error(page: Page) {
    await openStockLab(page, {
      answer: (_body, route) => route.fulfill(serverFailure()) as Promise<void>,
    });
    await page.getByRole("button", { name: "Tentar novamente" }).waitFor();
    await page
      .getByText("Avisos do estoque indisponíveis agora.")
      .waitFor({ timeout: 20_000 });
    await showScreenAlone(page);
  },

  /** The list: every tone of a row (no cost, out of stock, archived, a name too long for the line) and the next page. */
  async list(page: Page) {
    await openList(page);
    await page.getByRole("button", { name: "Carregar mais" }).waitFor();
    await showScreenAlone(page);
  },

  /** The read does not answer: the screen waits. */
  async loading(page: Page) {
    await openStockLab(page, {
      answer: () => new Promise<void>(() => undefined),
    });
    await page
      .getByRole("status")
      .getByText("Carregando o estoque…")
      .waitFor({ state: "attached" });
    await showScreenAlone(page);
  },

  /** A search with nothing found. */
  async noResult(page: Page) {
    await openStockLab(page, {
      answer: (body, route) =>
        route.fulfill(
          rpc(
            attentionPage(body, ROWS) ?? {
              entries: body.includes("zzz") ? [] : ROWS,
              nextCursor: null,
            }
          )
        ) as Promise<void>,
    });
    await rowOf(page, SHIRT_ROW).waitFor();
    await page.getByLabel("Buscar no estoque").fill("zzz");
    await page.getByText("Nenhuma variante encontrada para “zzz”.").waitFor();
    await showScreenAlone(page);
  },

  /** Without a network the list is the device's, with no cost; and a receipt is kept on the device. */
  async offline(page: Page) {
    await openList(page);
    await page.getByLabel("Rede disponível").uncheck();
    await page.getByText("Sem conexão.").waitFor();
    await page.getByText("Só com conexão").first().waitFor();
    await showScreenAlone(page);
  },

  async offlineKept(page: Page) {
    await openList(page);
    await page.getByLabel("Rede disponível").uncheck();
    await page.getByText("Sem conexão.").waitFor();
    await openCommand(page, "Receber", "Camiseta do laboratório, Azul");
    await fillReceipt(page);
    await review(page).click();
    await confirm(page).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Recebimento guardado neste aparelho" })
      .waitFor({ timeout: 15_000 });
    await showScreenAlone(page);
  },

  /** The receipt of a variant with balance and no known cost is blocked: the notice, and "Revisar" off. */
  async receiveBlocked(page: Page) {
    await openList(page);
    await openCommand(page, "Receber", "Camiseta do teste");
    await page.getByText("Antes de receber, informe o custo").waitFor();
    await showScreenAlone(page);
  },

  /** The receipt filled and reviewed: the summary and its consequence, before the confirmation. */
  async receiveConfirming(page: Page) {
    await openList(page);
    await openCommand(page, "Receber", "Calça jeans");
    await fillReceipt(page);
    await review(page).click();
    await confirm(page).waitFor();
    await showScreenAlone(page);
  },

  async receiveDone(page: Page) {
    await page.route("**/rpc/inventory/receiveStock", (route: Route) =>
      route.fulfill(
        rpc({
          balance: balance(15, "12.500000"),
          movement,
          replayed: false,
        })
      )
    );
    await openList(page);
    await openCommand(page, "Receber", "Calça jeans");
    await fillReceipt(page);
    await review(page).click();
    await confirm(page).click();
    await page.getByText("Saldo: 15 unidades").waitFor();
    await showScreenAlone(page);
  },

  async receiveErrors(page: Page) {
    await openList(page);
    await openCommand(page, "Receber", "Calça jeans");
    await review(page).click();
    await page.getByText("Informe a quantidade recebida.").waitFor();
    await showScreenAlone(page);
  },

  /** The outcome is not known (the answer was lost): the attempt is locked and only a safe retry goes on. */
  async receiveLocked(page: Page) {
    await page.route("**/rpc/inventory/receiveStock", (route: Route) =>
      route.abort("failed")
    );
    await openList(page);
    await openCommand(page, "Receber", "Calça jeans");
    await fillReceipt(page);
    await review(page).click();
    await confirm(page).click();
    await page
      .getByRole("button", { name: "Descartar esta tentativa" })
      .waitFor();
    await showScreenAlone(page);
  },

  /** A write-off with the reason "Outro" and no note: the note is required. */
  async writeOffNote(page: Page) {
    await openList(page);
    await openCommand(page, "Baixar", "Calça jeans");
    await page.getByLabel("Quantidade a baixar").fill("1");
    await chooseOption(
      page,
      page.getByRole("combobox", { exact: true, name: "Motivo da baixa" }),
      page.getByRole("option", { name: "Outro (descreva)" })
    );
    await review(page).click();
    await page
      .getByText("Descreva o motivo", { exact: false })
      .first()
      .waitFor();
    await showScreenAlone(page);
  },

  /** The server refuses a write-off the balance cannot cover (it changed meanwhile). */
  async writeOffRefused(page: Page) {
    await page.route("**/rpc/inventory/writeOffStock", (route: Route) =>
      route.fulfill(refusal("insufficient_stock"))
    );
    await page.route("**/rpc/inventory/getBalance", (route: Route) =>
      route.fulfill(rpc(balance(2, null)))
    );
    await openList(page);
    await openCommand(page, "Baixar", "Camiseta do teste");
    await page.getByLabel("Quantidade a baixar").fill("4");
    await chooseOption(
      page,
      page.getByRole("combobox", { exact: true, name: "Motivo da baixa" }),
      page.getByRole("option", { exact: true, name: "Avariado" })
    );
    await review(page).click();
    await confirm(page).click();
    await page.getByText("O servidor recusou: o saldo agora é 2").waitFor();
    await showScreenAlone(page);
  },
};
