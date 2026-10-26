/// <reference lib="dom" />
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "webdriverio";
import { restoreNetwork, setNetworkProfile } from "./browserstack-api";
import { labUrl, SELECTED_FLOWS, shellUrl } from "./config";
import { calendarChunkBlock } from "./static-server";

type StepStatus = "failed" | "passed" | "skipped";
export interface StepResult {
  detail: string;
  flow: string;
  ms: number;
  name: string;
  status: StepStatus;
}

const WAIT_MS = 30_000;
const SHIRT_WITH_THREE = /Camiseta do laboratório — Azul\s+Saldo 3/;

/** Um passo falho pula os seguintes do mesmo fluxo: eles dependem do estado deixado por ele. */
class Recorder {
  readonly results: StepResult[] = [];
  private broken = false as boolean;
  private flow = "";

  startFlow(flow: string) {
    this.flow = flow;
    this.broken = false;
  }

  async step(name: string, run: () => Promise<string | undefined>) {
    const base = { flow: this.flow, name };
    if (this.broken) {
      this.results.push({
        ...base,
        detail: "não executado: passo anterior do fluxo falhou",
        ms: 0,
        status: "skipped",
      });
      return;
    }
    const started = Date.now();
    try {
      const detail = (await run()) ?? "";
      this.results.push({
        ...base,
        detail,
        ms: Date.now() - started,
        status: "passed",
      });
    } catch (error: unknown) {
      this.broken = true;
      this.results.push({
        ...base,
        detail: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started,
        status: "failed",
      });
    }
  }
}

const bodyText = (browser: Browser) =>
  browser.execute(() => document.body.innerText);

async function waitForText(browser: Browser, text: string, gone = false) {
  await browser.waitUntil(
    async () => (await bodyText(browser)).includes(text) !== gone,
    {
      timeout: WAIT_MS,
      timeoutMsg: `${gone ? "ainda aparece" : "não apareceu"}: "${text}"`,
    }
  );
}

async function waitForTestId(browser: Browser, id: string, value: string) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (testId) =>
          document.querySelector(`[data-testid="${testId}"]`)?.textContent,
        id
      )) === value,
    { timeout: WAIT_MS, timeoutMsg: `${id} não chegou a "${value}"` }
  );
}

/** O controle associado a um rótulo, como o leitor de tela o anuncia. */
async function control(browser: Browser, label: string) {
  const element = await browser.execute((text) => {
    const found = [...document.querySelectorAll("label")].find((candidate) =>
      candidate.textContent?.trim().startsWith(text)
    );
    return found?.control ?? null;
  }, label);
  if (!element) {
    throw new Error(`rótulo não encontrado: "${label}"`);
  }
  return browser.$(element);
}

async function setChecked(browser: Browser, label: string, checked: boolean) {
  const box = await control(browser, label);
  if ((await box.isSelected()) !== checked) {
    await box.click();
  }
  await browser.waitUntil(async () => (await box.isSelected()) === checked, {
    timeout: 5000,
  });
}

/** Selecionar por valor evita o seletor nativo do sistema, que o WebDriver não controla. */
async function choose(browser: Browser, label: string, option: string) {
  const select = await control(browser, label);
  const chosen = await browser.execute(
    (element, text) => {
      const field = element as HTMLSelectElement;
      const match = [...field.options].find(
        (candidate) => candidate.textContent?.trim() === text
      );
      if (!match) {
        return false;
      }
      field.value = match.value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    select,
    option
  );
  if (!chosen) {
    throw new Error(`opção não encontrada em "${label}": "${option}"`);
  }
}

/** Toca num elemento como a pessoa faria: com o teclado fechado e o elemento no centro da tela. */
async function tap(browser: Browser, element: WebdriverIO.Element) {
  await element.waitForExist({ timeout: WAIT_MS });
  // fechar o teclado antes: se ele fechar entre o apertar e o soltar, o layout se move e o toque se perde
  await browser.execute((target) => {
    (document.activeElement as HTMLElement | null)?.blur();
    target.scrollIntoView({ block: "center" });
  }, element);
  await browser.pause(1000);
  await element.waitForClickable({ timeout: WAIT_MS });
  await element.click();
}

const click = async (browser: Browser, selector: string) =>
  await tap(browser, await browser.$(selector));

/** Botão cujo texto (somando os filhos) contém `text`; o seletor de texto parcial só olha o primeiro nó. */
async function clickButtonContaining(browser: Browser, text: string) {
  const find = (wanted: string) =>
    browser.execute(
      (needle) =>
        [...document.querySelectorAll("button")].find((candidate) =>
          candidate.textContent?.includes(needle)
        ) ?? null,
      wanted
    );
  try {
    await browser.waitUntil(async () => (await find(text)) !== null, {
      timeout: WAIT_MS,
    });
  } catch (error: unknown) {
    const seen = await browser.execute(() =>
      [...document.querySelectorAll("button")].map((button) =>
        button.textContent?.trim()
      )
    );
    throw new Error(
      `botão não apareceu: "${text}"; botões: ${JSON.stringify(seen)}`,
      { cause: error }
    );
  }
  await tap(browser, await browser.$((await find(text)) as never));
}

async function deviceCanReach(browser: Browser, origin: string) {
  return await browser.execute(async (target) => {
    try {
      await fetch(`${target}/rpc/probe?t=${Date.now()}`, { cache: "no-store" });
      return true;
    } catch {
      return false;
    }
  }, origin);
}

/** Confere no aparelho, de dentro da página, que a rede está de fato fora (ou de volta). */
async function waitForNetwork(browser: Browser, reachable: boolean) {
  const origin = await browser.execute(() => location.origin);
  await browser.waitUntil(
    async () => (await deviceCanReach(browser, origin)) === reachable,
    {
      interval: 2000,
      timeout: 60_000,
      timeoutMsg: `o aparelho não ficou ${reachable ? "com" : "sem"} rede`,
    }
  );
}

async function goOffline(browser: Browser, sessionId: string) {
  await setNetworkProfile(sessionId, "no-network");
  await waitForNetwork(browser, false);
}

async function goOnline(browser: Browser, sessionId: string) {
  await restoreNetwork(sessionId);
  await waitForNetwork(browser, true);
}

/**
 * Aparelho "recém-instalado": apaga IndexedDB, OPFS e localStorage da origem do laboratório.
 * Só vale com a página recém-aberta, antes de "Iniciar" (nenhuma conexão com o banco aberta):
 * espera cada `deleteDatabase` terminar e falha se ele ficar bloqueado.
 */
async function clearSiteData(browser: Browser) {
  await browser.execute(async () => {
    const databases = (await indexedDB.databases?.()) ?? [];
    const names = databases.flatMap((database) =>
      database.name ? [database.name] : []
    );
    await Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () =>
              reject(new Error(`não apagou o banco ${name}: ${request.error}`));
            request.onblocked = () =>
              reject(
                new Error(
                  `o banco ${name} continua aberto e não pôde ser apagado`
                )
              );
          })
      )
    );
    const root = await navigator.storage.getDirectory();
    // biome-ignore lint/suspicious/noExplicitAny: a lib DOM do TypeScript não declara `entries()` do OPFS
    for await (const [name] of (root as any).entries()) {
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
    localStorage.clear();
  });
}

async function openScreensLab(
  browser: Browser,
  screen: "customers" | "sale",
  user: string,
  fresh = true
) {
  await browser.url(labUrl(`/offline-screens-lab?screen=${screen}`));
  await waitForText(browser, "Laboratório das telas offline");
  if (fresh) {
    await clearSiteData(browser);
  }
  await (await control(browser, "Usuário")).setValue(user);
}

async function startRuntime(browser: Browser, heading: string) {
  await click(browser, "button=Iniciar");
  await waitForText(browser, "Iniciar: ok (ready)");
  await waitForText(browser, heading);
}

async function registerCustomer(browser: Browser, name: string, phone: string) {
  await (await browser.$("#customer-name")).setValue(name);
  await (await browser.$("#customer-phone")).setValue(phone);
  await click(browser, "button=Cadastrar cliente");
}

const cardState = (browser: Browser, name: string) =>
  browser.execute((customer) => {
    const card = [...document.querySelectorAll("[data-customer-id]")].find(
      (candidate) => candidate.textContent?.includes(customer)
    );
    return card
      ? (card.querySelector("[data-sync-state]")?.textContent?.trim() ?? "")
      : null;
  }, name);

async function waitForCardState(
  browser: Browser,
  name: string,
  expected: string
) {
  await browser.waitUntil(
    async () => {
      const state = await cardState(browser, name);
      return state?.includes(expected) === true;
    },
    { timeout: WAIT_MS, timeoutMsg: `cartão de ${name} sem "${expected}"` }
  );
}

async function waitForCardSynced(browser: Browser, name: string) {
  await browser.waitUntil(async () => (await cardState(browser, name)) === "", {
    timeout: WAIT_MS,
    timeoutMsg: `cartão de ${name} continua aguardando envio`,
  });
}

/**
 * A busca lê as variantes da coleção local, que termina de carregar um instante depois de
 * "pronto": se a primeira busca vier vazia, digita de novo, como a pessoa faria.
 */
async function searchShirt(browser: Browser) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: cada tentativa depende da anterior
    await (await control(browser, "Produto ou variante")).setValue(
      "camiseta azul"
    );
    try {
      await browser.waitUntil(
        async () => (await bodyText(browser)).includes("1 variante encontrada"),
        { timeout: 8000 }
      );
      return;
    } catch {
      // tenta de novo
    }
  }
  throw new Error(
    'a busca "camiseta azul" não encontrou a variante do laboratório'
  );
}

async function customersFlow(
  recorder: Recorder,
  browser: Browser,
  sessionId: string
) {
  recorder.startFlow(
    "1. Clientes: carregar, ficar offline, registrar, voltar e sincronizar"
  );
  const user = `real-${crypto.randomUUID()}`;

  await recorder.step(
    "Abrir o app em contexto seguro com OPFS, IndexedDB e service worker",
    async () => {
      await openScreensLab(browser, "customers", user);
      const environment = await browser.execute(async () => {
        const persist = navigator.storage?.persist
          ? await navigator.storage.persist().catch(() => false)
          : false;
        return {
          indexedDB: "indexedDB" in window,
          opfs: Boolean(navigator.storage?.getDirectory),
          persist,
          secure: window.isSecureContext,
          serviceWorker: "serviceWorker" in navigator,
          userAgent: navigator.userAgent,
        };
      });
      if (!(environment.secure && environment.opfs && environment.indexedDB)) {
        throw new Error(
          `ambiente sem os requisitos: ${JSON.stringify(environment)}`
        );
      }
      return `storage.persist()=${String(environment.persist)}; serviceWorker=${String(environment.serviceWorker)}; ${String(environment.userAgent)}`;
    }
  );

  await recorder.step(
    "Iniciar o runtime offline e carregar dados (cliente cadastrado com rede é confirmado)",
    async () => {
      await startRuntime(browser, "Clientes");
      await registerCustomer(browser, "Ana Lima", "11900000001");
      await waitForTestId(browser, "server-records", "1");
      await waitForCardSynced(browser, "Ana Lima");
      await waitForText(browser, "Tudo sincronizado");
    }
  );

  await recorder.step(
    'Ficar offline: rede do aparelho derrubada (no-network) e "Rede disponível" desmarcada (é esta caixa que o runtime lê)',
    async () => {
      await goOffline(browser, sessionId);
      await setChecked(browser, "Rede disponível", false);
      await waitForText(browser, "Sem conexão. Você pode cadastrar");
    }
  );

  await recorder.step(
    'Registrar um cliente sem rede: fica no aparelho como "Aguardando envio"',
    async () => {
      await registerCustomer(browser, "Bia Souza", "11900000002");
      await waitForText(browser, "Cliente salvo neste aparelho.");
      await waitForCardState(browser, "Bia Souza", "Aguardando envio");
      await waitForText(browser, "Sem conexão · 1 operação guardada");
      // o servidor simulado só tem a Ana, confirmada antes: a Bia não saiu do aparelho
      await waitForTestId(browser, "server-records", "1");
    }
  );

  await recorder.step(
    "Reiniciar a página: a fila sobrevive ao reinício",
    async () => {
      await goOnline(browser, sessionId);
      await openScreensLab(browser, "customers", user, false);
      await setChecked(browser, "Rede disponível", false);
      await startRuntime(browser, "Clientes");
      await waitForCardState(browser, "Bia Souza", "Aguardando envio");
    }
  );

  await recorder.step(
    "Voltar online e sincronizar: o servidor confirma e o selo some",
    async () => {
      await setChecked(browser, "Rede disponível", true);
      await waitForTestId(browser, "server-records", "1");
      await waitForCardSynced(browser, "Bia Souza");
    }
  );

  await recorder.step(
    "Conferir: tudo sincronizado e a edição liberada",
    async () => {
      await waitForText(browser, "Tudo sincronizado");
      // the actions of a customer are in the menu of its row
      await click(browser, "button[aria-label='Mais ações para Bia Souza']");
      const edit = await browser.$("[role='menuitem']*=Editar");
      if ((await edit.getAttribute("aria-disabled")) === "true") {
        throw new Error("o item de editar continua desabilitado");
      }
    }
  );
}

async function saleFlow(
  recorder: Recorder,
  browser: Browser,
  sessionId: string
) {
  recorder.startFlow(
    "2. Venda: guardar sem rede, descontar do estoque do aparelho, confirmar ao voltar"
  );
  const shirt = "Camiseta do laboratório — Azul";

  await recorder.step("Abrir a tela de venda e iniciar o runtime", async () => {
    // sem limpar os dados: o mesmo aparelho, outro usuário, na mesma origem
    await openScreensLab(browser, "sale", `real-${crypto.randomUUID()}`, false);
    await startRuntime(browser, "Nova venda");
    await waitForText(browser, "Confirmar venda");
    // carregar dados: o aparelho só vende sem rede o que já baixou (variantes e estoque)
    await waitForText(browser, "Tudo sincronizado");
    await browser.pause(3000);
  });

  await recorder.step(
    "Ficar offline e preencher a venda de 2 camisetas",
    async () => {
      await goOffline(browser, sessionId);
      await setChecked(browser, "Rede disponível", false);
      await waitForText(browser, "Sem conexão. A venda será guardada");
      await searchShirt(browser);
      await clickButtonContaining(browser, shirt);
      await (await control(browser, "Quantidade")).setValue("2");
      await choose(browser, "Método de pagamento", "Pix");
      await choose(
        browser,
        "Perfil de pagamento",
        "Sem perfil de pagamento (taxas e prazo desconhecidos)"
      );
    }
  );

  await recorder.step(
    "Guardar a venda no aparelho (comando offline na fila)",
    async () => {
      await click(browser, "button=Guardar venda neste aparelho");
      await waitForText(browser, "Venda guardada neste aparelho");
      await waitForText(browser, "Vendas guardadas neste aparelho");
      await waitForText(browser, "Sem conexão · 1 operação guardada");
      await waitForTestId(browser, "server-records", "0");
    }
  );

  await recorder.step(
    "O estoque do aparelho já desconta a venda da fila (5 − 2 = 3)",
    async () => {
      await searchShirt(browser);
      await browser.waitUntil(
        async () => SHIRT_WITH_THREE.test(await bodyText(browser)),
        {
          timeout: WAIT_MS,
          timeoutMsg: "o saldo do aparelho não desceu para 3",
        }
      );
    }
  );

  await recorder.step(
    "Voltar online e sincronizar: o servidor confirma a venda uma vez",
    async () => {
      await goOnline(browser, sessionId);
      await setChecked(browser, "Rede disponível", true);
      await waitForTestId(browser, "server-records", "1");
      await waitForText(browser, "Vendas guardadas neste aparelho", true);
    }
  );

  await recorder.step(
    'Conferir: com rede o botão volta a ser "Confirmar venda"',
    async () => {
      await waitForText(browser, "Confirmar venda");
      await waitForTestId(browser, "server-records", "1");
    }
  );
}

async function shellFlow(
  recorder: Recorder,
  browser: Browser,
  sessionId: string
) {
  recorder.startFlow("3. Shell do app (service worker): abrir sem rede");

  await recorder.step(
    "Instalar o service worker e deixar que ele controle a página",
    async () => {
      await browser.url(shellUrl("/"));
      await browser.execute(async () => {
        await navigator.serviceWorker.ready;
      });
      await browser.refresh();
      await browser.waitUntil(
        () =>
          browser.execute(() => navigator.serviceWorker.controller !== null),
        {
          timeout: WAIT_MS,
          timeoutMsg: "o service worker não controla a página",
        }
      );
    }
  );

  await recorder.step(
    "Sem rede, o app abre do shell em cache (recarregar)",
    async () => {
      await goOffline(browser, sessionId);
      await browser.refresh();
      const title = await browser.getTitle();
      const filled = await browser.execute(
        () => (document.querySelector("#root")?.childElementCount ?? 0) > 0
      );
      if (!(title.endsWith("Polaris") && filled)) {
        throw new Error(
          `shell não abriu offline (título "${title}", #root ${filled ? "cheio" : "vazio"})`
        );
      }
    }
  );

  await recorder.step(
    "Sem rede, uma rota interna também abre do shell",
    async () => {
      await browser.url(shellUrl("/vendas/historico"));
      const title = await browser.getTitle();
      const filled = await browser.execute(
        () => (document.querySelector("#root")?.childElementCount ?? 0) > 0
      );
      if (!(title.endsWith("Polaris") && filled)) {
        throw new Error(`rota interna não abriu offline (título "${title}")`);
      }
    }
  );

  await recorder.step("Voltar a rede do aparelho", async () => {
    await goOnline(browser, sessionId);
  });
}

const EXPENSES_LAB = "/offline-screens-lab?screen=expenses";
const COMPETENCE = "Data de competência";
const COMPETENCE_BUTTON = `button[aria-label^="${COMPETENCE},"]`;
const CALENDAR = '[role="dialog"] [role="grid"]';

/** Com `GATE5_SCREENSHOT_DIR`, grava a tela do aparelho (`<plataforma>-<nome>.png`); sem ela, nada. */
async function screenshot(browser: Browser, name: string) {
  const directory = process.env.GATE5_SCREENSHOT_DIR;
  if (!directory) {
    return;
  }
  mkdirSync(directory, { recursive: true });
  const platform = browser.isIOS ? "ios" : "android";
  writeFileSync(
    join(directory, `${platform}-${name}.png`),
    Buffer.from(await browser.takeScreenshot(), "base64")
  );
}

/** A tela de despesas do laboratório no build do shell, com o runtime iniciado (o formulário traz a data). */
async function openExpensesLab(browser: Browser, network: boolean) {
  await browser.url(shellUrl(EXPENSES_LAB));
  await waitForText(browser, "Laboratório das telas offline");
  await (await control(browser, "Usuário")).setValue(
    `real-${crypto.randomUUID()}`
  );
  if (!network) {
    await setChecked(browser, "Rede disponível", false);
  }
  await startRuntime(browser, "Despesas");
  await (await browser.$(COMPETENCE_BUTTON)).waitForExist({
    timeout: WAIT_MS,
  });
}

const competenceLabel = async (browser: Browser) =>
  (await (await browser.$(COMPETENCE_BUTTON)).getAttribute("aria-label")) ?? "";

/** Toca no seletor da data de competência e espera o popover com o calendário ou com a caixa de falha. */
async function openCompetence(
  browser: Browser,
  expect: "calendar" | "failure"
) {
  await click(browser, COMPETENCE_BUTTON);
  const target =
    expect === "calendar" ? CALENDAR : '[role="dialog"] [role="alert"]';
  await (await browser.$(target)).waitForDisplayed({
    timeout: WAIT_MS,
    timeoutMsg:
      expect === "calendar"
        ? "o calendário não apareceu"
        : "a caixa de falha do calendário não apareceu",
  });
}

/**
 * Toca num elemento do popover sem o `blur` de `tap`: o foco está num dia do calendário, e tirá-lo de dentro do
 * popover poderia fechá-lo antes do toque.
 */
async function tapInPopover(browser: Browser, selector: string) {
  const element = await browser.$(selector);
  await element.waitForClickable({ timeout: WAIT_MS });
  await element.click();
}

/** O botão do popover cujo texto é `text`. */
const popoverButton = (text: string) =>
  `//*[@role="dialog"]//button[normalize-space()="${text}"]`;

const popoverText = (browser: Browser) =>
  browser.execute(
    () =>
      (document.querySelector('[role="dialog"]') as HTMLElement | null)
        ?.innerText ?? ""
  );

/** Marca a página: some só se ela for carregada de novo. */
const RELOAD_MARK = "__gate5NoReload";
const setReloadMark = (browser: Browser, value: string) =>
  browser.execute(
    (name, mark) => {
      (window as unknown as Record<string, string>)[name] = mark;
    },
    RELOAD_MARK,
    value
  );
const reloadMark = (browser: Browser) =>
  browser.execute(
    (name) =>
      (window as unknown as Record<string, string | undefined>)[name] ?? null,
    RELOAD_MARK
  );

/** Apaga service workers e caches da origem do shell: a página seguinte não é controlada e nada vem do precache. */
async function dropServiceWorker(browser: Browser) {
  await browser.execute(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations.map((registration) => registration.unregister())
    );
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  });
}

async function datePickerFlow(
  recorder: Recorder,
  browser: Browser,
  sessionId: string
) {
  recorder.startFlow("4a. Seletor de data: abre e escolhe um dia");

  await recorder.step(
    "Abrir a tela de despesas do laboratório (build do shell) e iniciar o runtime",
    async () => {
      await openExpensesLab(browser, true);
      return await competenceLabel(browser);
    }
  );

  await recorder.step(
    'Tocar em "Data de competência": o calendário aparece',
    async () => {
      await openCompetence(browser, "calendar");
      await screenshot(browser, "4a-calendario-aberto");
    }
  );

  await recorder.step("Tocar num dia: o campo mostra a data", async () => {
    // o mês aberto é o da data do campo (hoje): o dia 10 dele, ou o 11 se hoje já é 10
    const [day, month, year] =
      (await competenceLabel(browser)).split(", ")[1]?.split("/") ?? [];
    if (!(day && month && year)) {
      throw new Error("o campo não mostra uma data");
    }
    const chosen = day === "10" ? "11" : "10";
    await tapInPopover(
      browser,
      `[role="dialog"] button[data-day="${year}-${month}-${chosen}"]`
    );
    const expected = `${COMPETENCE}, ${chosen}/${month}/${year}`;
    await browser.waitUntil(
      async () => (await competenceLabel(browser)) === expected,
      { timeout: WAIT_MS, timeoutMsg: `o campo não chegou a "${expected}"` }
    );
    await (await browser.$('[role="dialog"]')).waitForExist({
      reverse: true,
      timeout: WAIT_MS,
      timeoutMsg: "o calendário não fechou depois do toque no dia",
    });
    await screenshot(browser, "4a-data-escolhida");
    return expected;
  });

  // o BrowserStack não instala o app na tela inicial: "service worker controlando + sem rede" é o substituto de
  // "instalado", como no fluxo 3
  recorder.startFlow(
    "4b. Seletor de data sem rede, com o service worker controlando: o calendário abre do precache"
  );

  await recorder.step(
    "Instalar o service worker (pelo shell) e deixar que ele controle a tela de despesas",
    async () => {
      await browser.url(shellUrl("/"));
      await browser.execute(async () => {
        await navigator.serviceWorker.ready;
      });
      await browser.url(shellUrl(EXPENSES_LAB));
      await browser.waitUntil(
        () =>
          browser.execute(() => navigator.serviceWorker.controller !== null),
        {
          timeout: WAIT_MS,
          timeoutMsg: "o service worker não controla a página",
        }
      );
    }
  );

  await recorder.step(
    "Sem rede, recarregar e abrir o seletor: o calendário abre",
    async () => {
      await goOffline(browser, sessionId);
      await openExpensesLab(browser, false);
      await openCompetence(browser, "calendar");
      await screenshot(browser, "4b-calendario-sem-rede");
    }
  );

  await recorder.step("Voltar a rede do aparelho", async () => {
    await goOnline(browser, sessionId);
  });

  // um passo falho do 4b pode ter deixado o aparelho sem rede
  await restoreNetwork(sessionId).catch(() => undefined);
  const mark = crypto.randomUUID();
  recorder.startFlow(
    "4c. Seletor de data com o chunk do calendário respondendo 503 (sem service worker)"
  );

  try {
    await recorder.step(
      "Ligar a chave do 503, apagar o service worker e os caches e abrir a tela sem controle",
      async () => {
        calendarChunkBlock.on = true;
        await browser.url(shellUrl(EXPENSES_LAB));
        await dropServiceWorker(browser);
        await openExpensesLab(browser, true);
        const controlled = await browser.execute(
          () => navigator.serviceWorker.controller !== null
        );
        if (controlled) {
          throw new Error("a página continua controlada pelo service worker");
        }
        await setReloadMark(browser, mark);
      }
    );

    if (browser.isIOS) {
      await recorder.step(
        'Safari: "O calendário não abriu." e "Recarregar a página", sem recarregar sozinha',
        async () => {
          await openCompetence(browser, "failure");
          const text = await popoverText(browser);
          if (
            !(
              text.includes("O calendário não abriu.") &&
              text.includes("Recarregar a página")
            )
          ) {
            throw new Error(`a caixa de falha diz: ${JSON.stringify(text)}`);
          }
          await screenshot(browser, "4c-falha-recarregar");
          // a página não recarrega por conta própria: a marca continua lá alguns segundos depois
          await browser.pause(5000);
          if ((await reloadMark(browser)) !== mark) {
            throw new Error("a página recarregou sozinha");
          }
          return text.replaceAll("\n", " · ");
        }
      );

      await recorder.step(
        '"Recarregar a página" recarrega só no toque',
        async () => {
          if ((await reloadMark(browser)) !== mark) {
            throw new Error("a página recarregou antes do toque");
          }
          await tapInPopover(browser, popoverButton("Recarregar a página"));
          await browser.waitUntil(
            async () => (await reloadMark(browser)) === null,
            {
              timeout: WAIT_MS,
              timeoutMsg: "o toque não recarregou a página",
            }
          );
          await waitForText(browser, "Laboratório das telas offline");
        }
      );
    } else {
      await recorder.step(
        'Chrome: "O calendário não abriu." e "Tentar novamente"',
        async () => {
          await openCompetence(browser, "failure");
          const text = await popoverText(browser);
          if (
            !(
              text.includes("O calendário não abriu.") &&
              text.includes("Tentar novamente")
            )
          ) {
            throw new Error(`a caixa de falha diz: ${JSON.stringify(text)}`);
          }
          await screenshot(browser, "4c-falha-tentar");
          return text.replaceAll("\n", " · ");
        }
      );

      await recorder.step(
        'Desligar a chave e tocar em "Tentar novamente": o calendário abre sem recarregar',
        async () => {
          calendarChunkBlock.on = false;
          await tapInPopover(browser, popoverButton("Tentar novamente"));
          await (await browser.$(CALENDAR)).waitForDisplayed({
            timeout: WAIT_MS,
            timeoutMsg: "o calendário não apareceu depois de Tentar novamente",
          });
          if ((await reloadMark(browser)) !== mark) {
            throw new Error("a página recarregou");
          }
          await screenshot(browser, "4c-calendario-depois-de-tentar");
        }
      );
    }
  } finally {
    calendarChunkBlock.on = false;
  }
}

/**
 * O celular de verdade é o nível de movimento `essential` (t386, ADR 0103 "Níveis de movimento"): a emulação do
 * Playwright prova o resto (`e2e-pwa/motion-level.e2e.ts`), mas não que um aparelho real dê `pointer: coarse`.
 */
async function motionFlow(recorder: Recorder, browser: Browser) {
  recorder.startFlow("5. Movimento no celular: só o essencial");

  await recorder.step(
    'Abrir a galeria: o aparelho tem ponteiro grosso e a página está em data-motion="essential"',
    async () => {
      await browser.url(shellUrl("/ui-galeria"));
      await waitForText(browser, "Galeria da interface");
      const found = await browser.execute(() => ({
        coarse: matchMedia("(pointer: coarse)").matches,
        level: document.documentElement.dataset.motion ?? "",
        size: `${window.innerWidth}×${window.innerHeight}`,
      }));
      if (!(found.coarse && found.level === "essential")) {
        throw new Error(`nível de movimento errado: ${JSON.stringify(found)}`);
      }
      return `pointer: coarse; data-motion=${found.level}; janela ${found.size}`;
    }
  );

  await recorder.step(
    "O gráfico aparece pronto: sem o clip da revelação e o mesmo desenho 1,5 s depois",
    async () => {
      const drawing = () =>
        browser.execute(() => {
          const charts = [...document.querySelectorAll("[data-chart-area]")];
          return {
            clips: charts.filter((chart) =>
              chart.querySelector("svg g[clip-path]")
            ).length,
            count: charts.length,
            path:
              charts[0]?.querySelector("svg path[stroke]")?.getAttribute("d") ??
              "",
          };
        });
      await browser.waitUntil(async () => (await drawing()).path !== "", {
        timeout: WAIT_MS,
        timeoutMsg: "o gráfico da galeria não foi desenhado",
      });
      const first = await drawing();
      await browser.pause(1500);
      const later = await drawing();
      if (first.clips > 0 || later.clips > 0 || later.path !== first.path) {
        throw new Error(
          `o gráfico animou: ${first.clips} e ${later.clips} clips, desenho ${later.path === first.path ? "igual" : "mudou"}`
        );
      }
      return `${first.count} gráficos de área, nenhum com o clip da revelação`;
    }
  );

  await recorder.step(
    "A barra de filtros não pediu a camada animada (filter-bar-motion)",
    async () => {
      const layer = await browser.execute(
        () =>
          performance
            .getEntriesByType("resource")
            .filter((entry) =>
              entry.name.includes("/assets/filter-bar-motion-")
            ).length
      );
      if (layer > 0) {
        throw new Error("o celular pediu a camada animada da barra");
      }
    }
  );
}

const dialogOpen = (browser: Browser) =>
  browser.execute(() => document.querySelector("[role=dialog]") !== null);
const dialogEntry = (browser: Browser) =>
  browser.execute(() => history.state?.polarisDialog ?? null);

/**
 * O "voltar" do celular fecha o Dialog de tela inteira (t408, DESIGN.md "Diálogo de formulário"): a entrada do Dialog
 * no histórico é a que o voltar tira, o rascunho fica e o foco volta ao botão; fechado pelo ×, ele retira a entrada e o
 * voltar seguinte sai da tela. O WebDriver volta como o gesto e o botão do sistema (`history.back`); a emulação prova o
 * resto (dois Dialogs, recarga, aba nova, endereço: `e2e-pwa/dialog-voltar.e2e.ts` e `e2e/goals.e2e.ts`).
 */
async function dialogBackFlow(recorder: Recorder, browser: Browser) {
  recorder.startFlow("6. Voltar fecha o Dialog de tela inteira");

  await recorder.step(
    "Abrir a galeria depois de outra página, abrir o formulário e digitar no Campo 1",
    async () => {
      await browser.url(shellUrl("/termos"));
      await waitForText(browser, "Termos de Uso");
      await browser.url(shellUrl("/ui-galeria"));
      await waitForText(browser, "Galeria da interface");
      const before = await browser.execute(() => history.length);
      await clickButtonContaining(browser, "Abrir formulário");
      await waitForText(browser, "Novo cadastro");
      const after = await browser.execute(() => history.length);
      if (after !== before + 1) {
        throw new Error(
          `o formulário não empurrou uma entrada: ${before} → ${after}`
        );
      }
      const field = await control(browser, "Campo 1");
      await field.setValue("Camiseta azul");
      return `janela ${await browser.execute(() => `${innerWidth}×${innerHeight}`)}; histórico ${before} → ${after}`;
    }
  );

  await recorder.step(
    "Voltar: o formulário fecha, a tela continua a galeria e o foco volta ao botão",
    async () => {
      await browser.back();
      await browser.waitUntil(async () => !(await dialogOpen(browser)), {
        timeout: WAIT_MS,
        timeoutMsg: "o voltar não fechou o formulário",
      });
      const where = await browser.execute(() => ({
        focus: document.activeElement?.textContent?.trim() ?? "",
        path: location.pathname,
      }));
      if (where.path !== "/ui-galeria") {
        throw new Error(`o voltar saiu da galeria: ${where.path}`);
      }
      if (where.focus !== "Abrir formulário") {
        throw new Error(`o foco não voltou ao botão: "${where.focus}"`);
      }
      return `foco em "${where.focus}"`;
    }
  );

  await recorder.step(
    "Reabrir traz o rascunho; o × fecha e retira a entrada; o voltar seguinte sai da galeria",
    async () => {
      await clickButtonContaining(browser, "Abrir formulário");
      await waitForText(browser, "Novo cadastro");
      // o Safari do WebDriver não lê `value` de um elemento: a página lê
      const kept = await browser.execute(
        () =>
          (document.getElementById("galeria-form-1") as HTMLInputElement | null)
            ?.value ?? ""
      );
      if (kept !== "Camiseta azul") {
        throw new Error(`o rascunho não voltou: "${kept}"`);
      }
      // o × do canto: o "Fechar" do leitor de tela (o "Cancelar" do rodapé também fecha, mas é outro botão)
      const closeButton = await browser.execute(
        () =>
          [...document.querySelectorAll("[role=dialog] button")].find(
            (button) => button.textContent?.trim() === "Fechar"
          ) ?? null
      );
      if (!closeButton) {
        throw new Error("o × do formulário não foi encontrado");
      }
      await tap(browser, await browser.$(closeButton as never));
      await browser.waitUntil(
        async () =>
          !(await dialogOpen(browser)) && (await dialogEntry(browser)) === null,
        { timeout: WAIT_MS, timeoutMsg: "o × não retirou a entrada do Dialog" }
      );
      await browser.back();
      await browser.waitUntil(
        async () =>
          (await browser.execute(() => location.pathname)) === "/termos",
        {
          timeout: WAIT_MS,
          timeoutMsg: "o voltar seguinte não saiu da galeria",
        }
      );
      return "rascunho mantido; o voltar seguinte foi para /termos";
    }
  );

  await recorder.step(
    "Recarregar com o formulário aberto: a galeria volta sem ele e o primeiro voltar sai (o detalhe diz o tipo da carga)",
    async () => {
      await browser.url(shellUrl("/ui-galeria"));
      await waitForText(browser, "Galeria da interface");
      await clickButtonContaining(browser, "Abrir formulário");
      await waitForText(browser, "Novo cadastro");
      await browser.refresh();
      await waitForText(browser, "Galeria da interface");
      // a entrada que sobrou é pulada na carga; uma segunda carga apareceria como "back_forward"
      await browser.waitUntil(
        async () => (await dialogEntry(browser)) === null,
        { timeout: WAIT_MS, timeoutMsg: "a entrada que sobrou não foi pulada" }
      );
      await browser.pause(1000);
      const loaded = await browser.execute(() => ({
        dialog: document.querySelector("[role=dialog]") !== null,
        navigation:
          (
            performance.getEntriesByType("navigation")[0] as
              | PerformanceNavigationTiming
              | undefined
          )?.type ?? "",
        path: location.pathname,
      }));
      if (loaded.dialog || loaded.path !== "/ui-galeria") {
        throw new Error(
          `a recarga não voltou à galeria sem o formulário: ${JSON.stringify(loaded)}`
        );
      }
      await browser.back();
      await browser.waitUntil(
        async () =>
          (await browser.execute(() => location.pathname)) === "/termos",
        {
          timeout: WAIT_MS,
          timeoutMsg: "o primeiro voltar depois da recarga não saiu da galeria",
        }
      );
      return `navegação da carga: ${loaded.navigation}`;
    }
  );
}

/** Roda os fluxos escolhidos e sempre tenta devolver a rede do aparelho ao normal ao final. */
export async function runGate5Suite(browser: Browser, sessionId: string) {
  const recorder = new Recorder();
  const flows = [
    customersFlow,
    saleFlow,
    shellFlow,
    datePickerFlow,
    motionFlow,
    dialogBackFlow,
  ].filter((_, index) => SELECTED_FLOWS.includes(index + 1));
  try {
    for (const flow of flows) {
      // um fluxo que falhou pode ter deixado o aparelho sem rede
      // biome-ignore lint/performance/noAwaitInLoops: um fluxo por vez, no mesmo aparelho
      await restoreNetwork(sessionId).catch(() => undefined);
      await flow(recorder, browser, sessionId);
    }
  } finally {
    recorder.startFlow("Encerramento");
    await recorder.step("Devolver a rede do aparelho ao normal", async () => {
      await restoreNetwork(sessionId);
      return "";
    });
  }
  return recorder.results;
}
