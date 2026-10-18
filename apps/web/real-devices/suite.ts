/// <reference lib="dom" />
import type { Browser } from "webdriverio";
import { restoreNetwork, setNetworkProfile } from "./browserstack-api";
import { labUrl, SELECTED_FLOWS, shellUrl } from "./config";

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

/** Aparelho "recém-instalado": apaga IndexedDB, OPFS e localStorage da origem do laboratório. */
async function clearSiteData(browser: Browser) {
  await browser.execute(async () => {
    const databases = (await indexedDB.databases?.()) ?? [];
    for (const database of databases) {
      if (database.name) {
        indexedDB.deleteDatabase(database.name);
      }
    }
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
    const card = [...document.querySelectorAll(".customer-card")].find(
      (candidate) => candidate.textContent?.includes(customer)
    );
    return card
      ? (card.querySelector(".customer-sync-state")?.textContent?.trim() ?? "")
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
    "Ficar offline: a rede do aparelho cai de verdade (no-network)",
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
      const enabled = await (
        await browser.$("button[aria-label='Editar cliente Bia Souza']")
      ).isEnabled();
      if (!enabled) {
        throw new Error("o botão de editar continua desabilitado");
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
    await openScreensLab(browser, "sale", `real-${crypto.randomUUID()}`);
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
      await waitForText(browser, "Vendas neste aparelho aguardando o servidor");
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
      await waitForText(
        browser,
        "Vendas neste aparelho aguardando o servidor",
        true
      );
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

/** Roda os fluxos escolhidos e sempre tenta devolver a rede do aparelho ao normal ao final. */
export async function runGate5Suite(browser: Browser, sessionId: string) {
  const recorder = new Recorder();
  const flows = [customersFlow, saleFlow, shellFlow].filter((_, index) =>
    SELECTED_FLOWS.includes(index + 1)
  );
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
