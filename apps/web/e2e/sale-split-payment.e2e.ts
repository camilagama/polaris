/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { LAB_PROFILE_SERVER_VERSION } from "../src/offline-poc/sale-lab-server";
import { SPLIT_PROFILE_HINT } from "../src/sales/sale-payment-hints";
import { chooseSelectOption } from "./select-option";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * "Dividir pagamento" on the sale screen, in the lab of the offline screens (no server: the reads and the
 * confirmation are answered here). Two parts at most; each with its method, amount, credit fields and profile.
 */
const SHIRT_OPTION = /Camiseta do laboratório · Azul/;
const LAB_PROFILE = /Maquininha do laboratório/;
const DESKTOP_ONLY = "teclas e linha única só no desktop";
const FALTA_50 = /Falta R\$\s50,00/;
const SUM_RULE =
  /A soma das partes precisa ser R\$\s300,00\. Falta R\$\s50,00\./;
const REVIEW_BUTTON = /^Revisei a prévia da parte/;
const OWN_DATE_REFUSAL = /tem data própria/;
const PART_2_PROFILE = /^Parte 2: O perfil de pagamento foi editado/;
const SPLIT_MISMATCH =
  "A soma das partes não fecha o total da venda. Confira o valor de cada parte e confirme de novo.";

const NOW = new Date("2026-10-01T12:00:00-03:00");
const STAMP = NOW.toISOString();

const PROFILE = {
  archivedAt: null,
  createdAt: STAMP,
  id: "0199c2d0-0000-7000-8000-0000000000c1",
  name: "Maquininha do laboratório",
  organizationId: "0199c2d0-0000-7000-8000-00000000a001",
  rules: [],
  status: "active",
  updatedAt: STAMP,
  version: 1,
};

const SECOND_PROFILE = {
  ...PROFILE,
  id: "0199c2d0-0000-7000-8000-0000000000c2",
  name: "Cartão reserva",
  version: 5,
};

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

const refusal = (code: string, status: number, data: unknown) =>
  rpc({ code, data, defined: false, message: code, status }, status);

interface ConfirmCalls {
  bodies: Record<string, unknown>[];
}

async function openSaleLab(
  page: Page,
  answer: (route: Route) => Promise<void> = (route) =>
    route.fulfill(
      refusal("BAD_REQUEST", 400, { reason: "sale_payment_split_mismatch" })
    ),
  profileVersion: { current: number } = { current: 1 },
  withSecondProfile = false
): Promise<ConfirmCalls> {
  const calls: ConfirmCalls = { bodies: [] };
  await page.clock.setFixedTime(NOW);
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill(
      rpc({
        profiles: [
          { ...PROFILE, version: profileVersion.current },
          ...(withSecondProfile ? [SECOND_PROFILE] : []),
        ],
      })
    )
  );
  await page.route("**/rpc/sale/confirm", async (route) => {
    const sent = route.request().postDataJSON() as {
      json: Record<string, unknown>;
    };
    calls.bodies.push(sent.json);
    await answer(route);
  });
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=sale");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(
    page.getByRole("heading", { exact: true, name: "Nova venda" })
  ).toBeVisible();
  return calls;
}

/** One shirt at R$ 300,00: the total of the example of the owner. */
async function sellShirtFor300(page: Page): Promise<void> {
  await page.getByLabel("Rede disponível").uncheck();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("camiseta azul");
  await page.getByRole("option", { name: SHIRT_OPTION }).click();
  await page.getByLabel("Rede disponível").check();
  await item.getByLabel("Quantidade").fill("1");
  await item.getByLabel("Preço cobrado").fill("300,00");
}

const splitButton = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Dividir pagamento" });
const part = (page: Page, ordinal: 1 | 2) =>
  page.getByRole("group", { exact: true, name: `Parte ${ordinal}` });

/** Total 300, part 1 Pix 100 with no profile, part 2 cash with no profile. */
async function splitTheExample(page: Page): Promise<void> {
  await sellShirtFor300(page);
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Pix" })
    .check();
  await chooseSelectOption(
    page.locator("form"),
    "Perfil de pagamento",
    "Sem perfil de pagamento"
  );
  await splitButton(page).click();
  await expect(part(page, 1).getByLabel("Valor")).toBeFocused();
  await part(page, 1).getByLabel("Valor").fill("100,00");
  await chooseSelectOption(part(page, 2), "Método", "Dinheiro");
  await chooseSelectOption(
    part(page, 2),
    "Perfil de pagamento",
    "Sem perfil de pagamento"
  );
}

test("o caso comum não pesa: Dividir pagamento é um botão de texto na linha fechada, uma parada depois do perfil, e nada mais à vista", async ({
  page,
}, testInfo) => {
  await openSaleLab(page);
  await sellShirtFor300(page);
  const start = splitButton(page);
  await expect(start).toBeVisible();
  await expect(page.getByRole("group", { name: "Parte 1" })).toHaveCount(0);
  await expect(page.getByLabel("Valor")).toHaveCount(0);
  const summaryLine = page.getByText("Agora · Sem ajuste");
  const lineBox = await summaryLine.boundingBox();
  const startBox = await start.boundingBox();
  const alter = page.getByRole("button", { name: "Alterar data e ajustes" });
  const alterBox = await alter.boundingBox();
  if (!(lineBox && startBox && alterBox)) {
    throw new Error("a linha fechada não está na tela");
  }
  if (testInfo.project.name.includes("mobile")) {
    // in one column it costs a line at most: the buttons wrap under the summary, together
    expect(Math.abs(startBox.y - alterBox.y)).toBeLessThan(2);
    expect(startBox.y - lineBox.y).toBeLessThan(
      lineBox.height + startBox.height + 4
    );
  } else {
    // on the desktop the closed line keeps its height: summary, Dividir and Alterar on one line
    expect(
      Math.abs(
        startBox.y + startBox.height / 2 - (lineBox.y + lineBox.height / 2)
      )
    ).toBeLessThan(4);
    expect(Math.abs(startBox.y - alterBox.y)).toBeLessThan(2);
  }
  // the Tab order gains one stop, right after the profile
  await page
    .getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    .focus();
  await page.keyboard.press("Tab");
  await expect(start).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(alter).toBeFocused();
  // the (i) of a single payment points at Dividir pagamento
  await page
    .getByRole("button", { exact: true, name: "Sobre Pagamento" })
    .click();
  await expect(page.getByRole("dialog", { name: "Pagamento" })).toContainText(
    "Um pagamento no valor total. Para receber de dois jeitos, use Dividir pagamento. O método não comprova o recebimento."
  );
});

test('o exemplo do usuário: total 300, Parte 1 = 100, a Parte 2 já mostra 200,00 "O restante" e o envio leva payments[]', async ({
  page,
}) => {
  const calls = await openSaleLab(page);
  await splitTheExample(page);
  const second = part(page, 2).getByLabel("Valor");
  await expect(second).toHaveValue("200,00");
  await expect(second).toHaveAccessibleDescription("O restante");
  const profileOf = (ordinal: 1 | 2) =>
    part(page, ordinal).getByRole("combobox", {
      exact: true,
      name: "Perfil de pagamento",
    });
  await expect(profileOf(1)).toHaveAccessibleDescription(SPLIT_PROFILE_HINT);
  await expect(profileOf(2)).toHaveAccessibleDescription(SPLIT_PROFILE_HINT);
  const status = page.locator("#sale-split-balance");
  await expect(status).toContainText("Fechou: R$ 300,00");
  const summary = page.getByRole("region", { exact: true, name: "Resumo" });
  await expect(summary).toContainText("Pagamento em 2 partes");
  await expect(summary).toContainText("Parte 1 · Pix");
  await expect(summary).toContainText("Parte 2 · Dinheiro");
  await expect(summary).toContainText("Taxas das duas partes");
  // no profile in a part: the fees of both are unknown, never zero
  await expect(summary).toContainText("desconhecida — não é zero");

  await page.getByRole("button", { name: "Confirmar venda" }).click();
  await expect.poll(() => calls.bodies.length).toBe(1);
  const [body] = calls.bodies;
  expect(body).not.toHaveProperty("payment");
  expect(body).not.toHaveProperty("paymentProfile");
  expect(body?.payments).toEqual([
    expect.objectContaining({
      amount: "100.00",
      method: "pix",
      paymentProfile: null,
    }),
    expect.objectContaining({
      amount: "200.00",
      method: "cash",
      paymentProfile: null,
    }),
  ]);
  // the server refuses the split: the reason is said and the parts stay as they were
  await expect(page.getByText(SPLIT_MISMATCH)).toBeVisible();
  await expect(part(page, 1).getByLabel("Valor")).toHaveValue("100,00");
  await expect(second).toHaveValue("200,00");
});

test("não confirma com diferença: Falta com ícone, nenhuma chamada, o foco na linha de estado e nada digitado se perde", async ({
  page,
}) => {
  const calls = await openSaleLab(page);
  await splitTheExample(page);
  const second = part(page, 2).getByLabel("Valor");
  await second.fill("150,00");
  const status = page.locator("#sale-split-balance");
  await expect(status).toContainText(FALTA_50);
  await expect(status.locator("svg")).toHaveCount(1);
  await page.getByRole("button", { name: "Confirmar venda" }).click();
  await expect(status).toBeFocused();
  expect(calls.bodies).toHaveLength(0);
  await expect(second).toHaveAccessibleDescription(SUM_RULE);
  await expect(part(page, 1).getByLabel("Valor")).toHaveValue("100,00");
  await expect(second).toHaveValue("150,00");
  // the button of the line closes the difference
  await status.getByRole("button", { name: "Pôr na parte 2" }).click();
  await expect(second).toHaveValue("200,00");
  await expect(status).toContainText("Fechou: R$ 300,00");
});

test("Ajustar para na parte em dinheiro, e o troco fica só na tela", async ({
  page,
}) => {
  await openSaleLab(page);
  await sellShirtFor300(page);
  await splitButton(page).click();
  await chooseSelectOption(part(page, 1), "Método", "Dinheiro");
  await part(page, 1).getByLabel("Valor").fill("250,00");
  await chooseSelectOption(part(page, 2), "Método", "Pix");
  await part(page, 2).getByLabel("Valor").fill("100,00");
  const status = page.locator("#sale-split-balance");
  await expect(status).toContainText("Passou R$ 50,00");
  await expect(status).toContainText(
    "Se for troco, a parte em dinheiro é R$ 200,00."
  );
  await status.getByRole("button", { name: "Ajustar para R$ 200,00" }).click();
  await expect(part(page, 1).getByLabel("Valor")).toHaveValue("200,00");
  await expect(part(page, 2).getByLabel("Valor")).toHaveValue("100,00");
  await expect(part(page, 1)).toContainText("Troco: R$ 50,00");
  await expect(status).toContainText("Fechou: R$ 300,00");
});

test("Voltar a um pagamento só pede confirmação e devolve os seis cartões com o método da parte 1", async ({
  page,
}) => {
  await openSaleLab(page);
  await splitTheExample(page);
  await page
    .getByRole("button", { exact: true, name: "Voltar a um pagamento só" })
    .click();
  await expect(
    page.getByText("Voltar a um pagamento só? A parte 2 sai da venda.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Manter as duas partes" }).click();
  await expect(part(page, 2)).toBeVisible();
  await page
    .getByRole("button", { exact: true, name: "Voltar a um pagamento só" })
    .click();
  await page
    .getByRole("button", { exact: true, name: "Voltar a um pagamento só" })
    .click();
  await expect(part(page, 1)).toHaveCount(0);
  const methods = page.getByRole("radiogroup", { name: "Método de pagamento" });
  await expect(methods.getByRole("radio", { name: "Pix" })).toBeChecked();
  await expect(splitButton(page)).toBeVisible();
});

test("no modo dividido as teclas 1 a 6 não fazem nada e os números somem", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), DESKTOP_ONLY);
  await openSaleLab(page);
  await sellShirtFor300(page);
  await expect(page.locator("[data-method-key]").first()).toBeVisible();
  await splitButton(page).click();
  await expect(page.locator("[data-method-key]")).toHaveCount(0);
  await expect(page.locator("[aria-keyshortcuts]")).toHaveCount(0);
  const method = part(page, 1).getByRole("combobox", {
    exact: true,
    name: "Método",
  });
  await method.focus();
  await page.keyboard.press("2");
  await expect(method).not.toContainText("Dinheiro");
});

test("perfil por parte: cada parte tem o seu no Resumo; a recusa do servidor diz a parte e as partes ficam", async ({
  page,
}) => {
  await openSaleLab(page, (route) =>
    route.fulfill(
      refusal("CONFLICT", 409, {
        part: 1,
        reason: "payment_profile_version_conflict",
      })
    )
  );
  await sellShirtFor300(page);
  await splitButton(page).click();
  await chooseSelectOption(part(page, 1), "Método", "Pix");
  await part(page, 1).getByLabel("Valor").fill("100,00");
  await chooseSelectOption(part(page, 1), "Perfil de pagamento", LAB_PROFILE);
  await chooseSelectOption(part(page, 2), "Método", "Dinheiro");
  await chooseSelectOption(part(page, 2), "Perfil de pagamento", LAB_PROFILE);
  const summary = page.getByRole("region", { exact: true, name: "Resumo" });
  await expect(summary).toContainText("Parte 1 · Pix");
  await expect(summary.getByText("Maquininha do laboratório")).toHaveCount(2);
  await page.getByRole("button", { name: "Confirmar venda" }).click();
  await expect(page.getByText(PART_2_PROFILE)).toBeVisible();
  await expect(part(page, 1).getByLabel("Valor")).toHaveValue("100,00");
  await expect(part(page, 2).getByLabel("Valor")).toHaveValue("200,00");
});

test("o mesmo perfil editado nas duas partes dá um aviso só, com um botão que revisa as duas", async ({
  page,
}) => {
  const version = { current: 1 };
  await openSaleLab(page, undefined, version);
  await sellShirtFor300(page);
  await splitButton(page).click();
  await chooseSelectOption(part(page, 1), "Método", "Pix");
  await part(page, 1).getByLabel("Valor").fill("100,00");
  await chooseSelectOption(part(page, 1), "Perfil de pagamento", LAB_PROFILE);
  await chooseSelectOption(part(page, 2), "Método", "Dinheiro");
  await chooseSelectOption(part(page, 2), "Perfil de pagamento", LAB_PROFILE);
  version.current = 2;
  await page
    .getByRole("button", { name: "Atualizar estoque e perfis" })
    .click();
  const shared = page
    .getByRole("alert")
    .filter({ hasText: "Revise a prévia das duas partes." });
  await expect(shared).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "mudou desde a última venda" })
  ).toHaveCount(0);
  await shared
    .getByRole("button", { name: "Revisei a prévia das duas partes" })
    .click();
  await expect(shared).toHaveCount(0);
  await expect(part(page, 1).getByLabel("Valor")).toHaveValue("100,00");
  await expect(part(page, 2).getByLabel("Valor")).toHaveValue("200,00");
});

test("sem internet: Dividir pagamento fica ligado, a venda dividida é guardada no aparelho com as partes e o servidor a recebe quando a rede volta", async ({
  page,
}) => {
  const calls = await openSaleLab(page);
  await sellShirtFor300(page);
  await page.getByLabel("Rede disponível").uncheck();
  const start = splitButton(page);
  await expect(start).not.toHaveAttribute("aria-disabled");
  await expect(page.getByText("Dividir precisa de internet")).toHaveCount(0);
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Pix" })
    .check();
  await chooseSelectOption(
    page.locator("form"),
    "Perfil de pagamento",
    "Sem perfil de pagamento"
  );
  await start.click();
  await part(page, 1).getByLabel("Valor").fill("100,00");
  await chooseSelectOption(part(page, 2), "Método", "Dinheiro");
  await chooseSelectOption(
    part(page, 2),
    "Perfil de pagamento",
    "Sem perfil de pagamento"
  );
  await expect(
    page.getByText("Fechou: R$ 300,00", { exact: true }).first()
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();
  expect(calls.bodies).toHaveLength(0);
  // the form starts over with one payment: the screen never opens split
  await expect(part(page, 1)).toHaveCount(0);

  await page.getByLabel("Rede disponível").check();
  await expect(page.getByTestId("server-records")).toHaveText("1", {
    timeout: 20_000,
  });
  expect(calls.bodies).toHaveLength(0);
});

interface QueuedCommand {
  commandId: string;
  payload: Record<string, unknown>;
}

/** The payloads of the commands this page keeps to send. */
async function queuedPayloads(page: Page): Promise<Record<string, unknown>[]> {
  return (await queuedCommands(page)).map((command) => command.payload);
}

/** The commands this page keeps to send (IndexedDB stores named `commands`). */
function queuedCommands(page: Page): Promise<QueuedCommand[]> {
  return page.evaluate(async () => {
    const payloads: QueuedCommand[] = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: a handful of tiny databases
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      if (database.objectStoreNames.contains("commands")) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const request = database
            .transaction("commands", "readonly")
            .objectStore("commands")
            .getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        for (const row of rows) {
          const { commandId, payload } = row as QueuedCommand;
          payloads.push({ commandId, payload });
        }
      }
      database.close();
    }
    return payloads;
  });
}

test("sem internet, cada parte usa os perfis da última conexão: o Resumo mostra a prévia de cada parte e a fila leva o perfil e a versão de cada uma", async ({
  page,
}) => {
  await openSaleLab(page, undefined, { current: 4 });
  await sellShirtFor300(page);
  // the profiles were read with the connection: the device keeps them for the sale without one
  await expect(
    page.getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
  ).toBeVisible();
  await page.getByLabel("Rede disponível").uncheck();
  await expect(
    page.getByText("estes são os perfis da última vez com conexão")
  ).toBeVisible();
  await splitButton(page).click();
  await chooseSelectOption(part(page, 1), "Método", "Pix");
  await part(page, 1).getByLabel("Valor").fill("100,00");
  await chooseSelectOption(
    part(page, 1),
    "Perfil de pagamento",
    "Sem perfil de pagamento"
  );
  await chooseSelectOption(part(page, 2), "Método", "Débito");
  await chooseSelectOption(part(page, 2), "Perfil de pagamento", LAB_PROFILE);
  await expect(
    page
      .getByRole("note")
      .filter({ hasText: "estes são os perfis da última vez com conexão" })
  ).toHaveCount(1);
  const summary = page.getByRole("region", { exact: true, name: "Resumo" });
  await expect(summary).toContainText("Parte 1 · Pix");
  await expect(summary).toContainText("Parte 2 · Cartão de débito");
  await expect(summary.getByText("Maquininha do laboratório")).toHaveCount(1);
  await expect(summary).toContainText("Taxas das duas partes");
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Vendas guardadas neste aparelho" })
      .getByRole("listitem")
  ).toContainText("Pix + Débito");
  const [payload] = await queuedPayloads(page);
  expect(payload).not.toHaveProperty("payment");
  expect(payload?.payments).toEqual([
    expect.objectContaining({
      amount: "100.00",
      method: "pix",
      paymentProfile: null,
    }),
    expect.objectContaining({
      amount: "200.00",
      method: "debit_card",
      paymentProfile: { expectedVersion: 4, id: PROFILE.id },
    }),
  ]);
});

test("sem internet, a venda de 1 parte segue como hoje", async ({ page }) => {
  await openSaleLab(page);
  await sellShirtFor300(page);
  await page.getByLabel("Rede disponível").uncheck();
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Pix" })
    .check();
  await chooseSelectOption(
    page.locator("form"),
    "Perfil de pagamento",
    "Sem perfil de pagamento"
  );
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();

  await page.getByLabel("Rede disponível").check();
  await expect(page.getByTestId("server-records")).toHaveText("1", {
    timeout: 20_000,
  });
  const recorded = await recordedSales(page);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.payments).toEqual([
    expect.objectContaining({ method: "pix", paymentProfile: null }),
  ]);
});

test("sem internet, a venda de 1 parte com perfil leva o id e a versão dele até o que o servidor guardou", async ({
  page,
}) => {
  const chosen = {
    expectedVersion: LAB_PROFILE_SERVER_VERSION,
    id: PROFILE.id,
  };
  await openSaleLab(page, undefined, { current: chosen.expectedVersion });
  await sellShirtFor300(page);
  await expect(
    page.getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
  ).toBeVisible();
  await page.getByLabel("Rede disponível").uncheck();
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Pix" })
    .check();
  await chooseSelectOption(
    page.locator("form"),
    "Perfil de pagamento",
    LAB_PROFILE
  );
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();
  const [queued] = await queuedPayloads(page);
  expect(queued?.paymentProfile).toEqual(chosen);

  await page.getByLabel("Rede disponível").check();
  await expect(page.getByTestId("server-records")).toHaveText("1", {
    timeout: 20_000,
  });
  const recorded = await recordedSales(page);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.payments).toEqual([
    expect.objectContaining({
      method: "pix",
      paymentProfile: chosen,
    }),
  ]);
});

test("sem internet, a venda dividida com 2 perfis leva o id e a versão do perfil escolhido em cada parte, e não os do 1º", async ({
  page,
}) => {
  const first = { expectedVersion: LAB_PROFILE_SERVER_VERSION, id: PROFILE.id };
  const second = {
    expectedVersion: SECOND_PROFILE.version,
    id: SECOND_PROFILE.id,
  };
  await openSaleLab(page, undefined, { current: first.expectedVersion }, true);
  await sellShirtFor300(page);
  await expect(
    page.getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
  ).toBeVisible();
  await page.getByLabel("Rede disponível").uncheck();
  await splitButton(page).click();
  await chooseSelectOption(part(page, 1), "Método", "Pix");
  await part(page, 1).getByLabel("Valor").fill("100,00");
  await chooseSelectOption(
    part(page, 1),
    "Perfil de pagamento",
    SECOND_PROFILE.name
  );
  await chooseSelectOption(part(page, 2), "Método", "Débito");
  await chooseSelectOption(part(page, 2), "Perfil de pagamento", LAB_PROFILE);
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();
  const [queued] = await queuedPayloads(page);
  expect(queued?.payments).toEqual([
    expect.objectContaining({ method: "pix", paymentProfile: second }),
    expect.objectContaining({ method: "debit_card", paymentProfile: first }),
  ]);

  await page.getByLabel("Rede disponível").check();
  await expect(page.getByTestId("server-records")).toHaveText("1", {
    timeout: 20_000,
  });
  const recorded = await recordedSales(page);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.payments).toEqual([
    expect.objectContaining({ method: "pix", paymentProfile: second }),
    expect.objectContaining({ method: "debit_card", paymentProfile: first }),
  ]);
});

test("sem item: Dividir pagamento fica desligado e diz por quê", async ({
  page,
}) => {
  await openSaleLab(page);
  const start = splitButton(page);
  await expect(start).toHaveAttribute("aria-disabled", "true");
  await expect(start).toHaveAccessibleDescription(
    "Adicione um item para dividir o pagamento."
  );
  const reason = page
    .getByRole("note")
    .filter({ hasText: "Adicione um item para dividir o pagamento." });
  await expect(reason).toHaveCount(0);
  await start.focus();
  await page.keyboard.press("Enter");
  await expect(reason).toBeVisible();
  await expect(page.getByRole("group", { name: "Parte 1" })).toHaveCount(0);
});

for (const edited of [1, 2] as const) {
  test(`o perfil editado só na parte ${edited} dá o aviso daquela parte, com o botão "Revisei a prévia da parte ${edited}"`, async ({
    page,
  }) => {
    const version = { current: 1 };
    await openSaleLab(page, undefined, version);
    await sellShirtFor300(page);
    await splitButton(page).click();
    await chooseSelectOption(part(page, 1), "Método", "Pix");
    await part(page, 1).getByLabel("Valor").fill("100,00");
    await chooseSelectOption(part(page, 2), "Método", "Dinheiro");
    const other = edited === 1 ? 2 : 1;
    await chooseSelectOption(
      part(page, edited),
      "Perfil de pagamento",
      LAB_PROFILE
    );
    await chooseSelectOption(
      part(page, other),
      "Perfil de pagamento",
      "Sem perfil de pagamento"
    );
    version.current = 2;
    await page
      .getByRole("button", { name: "Atualizar estoque e perfis" })
      .click();
    const notice = part(page, edited)
      .getByRole("alert")
      .filter({ hasText: "mudou desde a última venda" });
    await expect(notice).toContainText(`da parte ${edited} mudou`);
    await expect(
      part(page, other)
        .getByRole("alert")
        .filter({ hasText: "mudou desde a última venda" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("alert").filter({ hasText: "Revise a prévia das duas" })
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: REVIEW_BUTTON })).toHaveCount(
      1
    );
    await notice
      .getByRole("button", {
        exact: true,
        name: `Revisei a prévia da parte ${edited}`,
      })
      .click();
    await expect(notice).toHaveCount(0);
    await expect(part(page, 1).getByLabel("Valor")).toHaveValue("100,00");
    await expect(part(page, 2).getByLabel("Valor")).toHaveValue("200,00");
  });
}

test("o leitor de tela ouve a linha de estado uma vez por mudança, ao sair do campo, e não a cada tecla", async ({
  page,
}) => {
  await openSaleLab(page);
  await splitTheExample(page);
  // a typed part 2 that is not the rest: every key in part 1 changes the difference
  await part(page, 2).getByLabel("Valor").fill("150,00");
  const status = page.locator("#sale-split-balance");
  const live = status.locator("[aria-live='polite']");
  const amount = part(page, 1).getByLabel("Valor");
  await amount.click();
  await expect(live).toContainText(FALTA_50);
  const before = (await live.textContent()) ?? "";
  await page.keyboard.press("ControlOrMeta+a");
  for (const key of ["1", "2", "0"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one key after the other, as a person types
    await page.keyboard.press(key);
    await expect(amount).toBeFocused();
    await expect(live).toHaveText(before);
  }
  // the line the eye reads has changed; the live region has not
  await expect(status.locator("p:not([aria-live])").first()).toContainText(
    "Falta R$ 30,00"
  );
  await expect(live).toHaveText(before);
  await page.keyboard.press("Tab");
  await expect(live).toContainText("Falta R$ 30,00");
  await expect(live).not.toHaveText(before);
});

test("a rede cai com a venda já dividida: Guardar neste aparelho guarda a venda com as partes, sem chamar o servidor", async ({
  page,
}) => {
  const calls = await openSaleLab(page);
  await splitTheExample(page);
  await page.getByLabel("Rede disponível").uncheck();
  await page
    .getByRole("button", { name: "Guardar venda neste aparelho" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();
  expect(calls.bodies).toHaveLength(0);
  await expect(page.getByText(OWN_DATE_REFUSAL)).toHaveCount(0);
  await expect(page.getByText("Dividir precisa de internet")).toHaveCount(0);
});

test("1 venda com 2 partes: travada sem resposta, guardada no aparelho com as partes enviadas e o mesmo ID, e o servidor a recebe uma vez", async ({
  page,
}) => {
  const calls = await openSaleLab(page, (route) =>
    route.abort("connectionreset")
  );
  await sellShirtFor300(page);
  await splitButton(page).click();
  await chooseSelectOption(part(page, 1), "Método", "Pix");
  await part(page, 1).getByLabel("Valor").fill("100,00");
  await chooseSelectOption(
    part(page, 1),
    "Perfil de pagamento",
    "Sem perfil de pagamento"
  );
  await chooseSelectOption(part(page, 2), "Método", "Débito");
  await chooseSelectOption(part(page, 2), "Perfil de pagamento", LAB_PROFILE);
  await page.getByRole("button", { name: "Confirmar venda" }).click();

  const keep = page.getByRole("button", {
    name: "Guardar esta venda neste aparelho",
  });
  await expect(
    page.getByRole("button", { name: "Tentar novamente (seguro)" })
  ).toBeVisible();
  await expect(keep).toBeVisible();
  expect(calls.bodies).toHaveLength(1);
  const [sent] = calls.bodies;
  // the queue is read before it is sent: the connection comes back only after
  await page.getByLabel("Rede disponível").uncheck();
  await keep.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Venda guardada neste aparelho" })
  ).toBeVisible();

  const queued = await queuedCommands(page);
  expect(queued).toHaveLength(1);
  const [command] = queued;
  expect(command?.commandId).toBe(sent?.commandId);
  expect(command?.payload.occurredAt).toBe(sent?.occurredAt);
  expect(command?.payload.recordedAt).toBe(sent?.recordedAt);
  expect(command?.payload).not.toHaveProperty("payment");
  expect(command?.payload.payments).toEqual(sent?.payments);
  expect(command?.payload.payments).toEqual([
    expect.objectContaining({
      amount: "100.00",
      method: "pix",
      paymentProfile: null,
    }),
    expect.objectContaining({
      amount: "200.00",
      method: "debit_card",
      paymentProfile: { expectedVersion: PROFILE.version, id: PROFILE.id },
    }),
  ]);

  await page.getByLabel("Rede disponível").check();
  await expect(page.getByTestId("server-records")).toHaveText("1", {
    timeout: 20_000,
  });
  await expect.poll(() => queuedCommands(page)).toEqual([]);
  expect(calls.bodies).toHaveLength(1);

  const recorded = await recordedSales(page);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.commandId).toBe(sent?.commandId);
  expect(recorded[0]?.payments).toEqual([
    expect.objectContaining({
      amount: "100.00",
      method: "pix",
      paymentProfile: null,
    }),
    expect.objectContaining({
      amount: "200.00",
      method: "debit_card",
      paymentProfile: { expectedVersion: PROFILE.version, id: PROFILE.id },
    }),
  ]);
});

interface RecordedSale {
  commandId: string;
  payments: unknown[];
}

/** The sales the simulated server of the lab recorded, with the command ID and the payments each carried. */
async function recordedSales(page: Page): Promise<RecordedSale[]> {
  const raw = await page
    .getByTestId("server-records")
    .getAttribute("data-sales");
  return JSON.parse(raw ?? "[]") as RecordedSale[];
}
