/// <reference lib="dom" />
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SCREENS, type UiScreen } from "../e2e-pwa/ui-screens";
import { screenKeys } from "../src/app-shell/navigation-model";
import {
  type ClippedElement,
  expectReflowFont,
  findClipped,
  openReflowViewport,
  skipOutsideChromium,
} from "./reflow";
import { ORGANIZATION_ID, serve } from "./shell-server";
import { WORKER_MARK } from "./worker-mark";

/**
 * The guard of the screens that have no reflow test of their own: each one is opened at 320 px with the browser font at
 * 20 px (`./reflow`) in the states the interface guardrails already build (`e2e-pwa/ui-screens.ts`, synthetic stores),
 * and nothing that holds text may be cut sideways, and the page may not scroll sideways. It runs once, on a phone with
 * touch (the fields of a touch screen are wider than the ones of a mouse), in the desktop project only.
 *
 * What fails the test is a finding that is not in `KNOWN_FINDINGS`, and a known finding that no longer shows up (a fix
 * has to take its line out). `SCROLLS_ON_PURPOSE` lists what scrolls by design: only a data table or the tab strip.
 * Fixing a finding is not this file's job: each line of `KNOWN_FINDINGS` is the work of a later change.
 *
 * `COVERED` lists the screens of `screenKeys()` (the screens of `ROUTES` and each tab) that are measured here, and
 * `EXCLUDED` the ones that a test of its own measures, with its file; a screen in neither fails `a consistência`
 * below. Customers is in both: the list is `clientes-reflow.e2e.ts`, only the dialog of the customer is here. The title
 * of the expenses list card and its button are `despesas-reflow.e2e.ts`; here are its three tabs and the form.
 * Not measured: the screens of the Admin (desktop), the font of 24 px and the dark theme.
 */
skipOutsideChromium();
test.use({ hasTouch: true, isMobile: true });
test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium-desktop",
    "one run on a phone with touch is enough: the other project would repeat it"
  );
});

type ScrollReason = "faixa de abas" | "tabela de dados";

interface ScrollOnPurpose {
  reason: ScrollReason;
  selector: string;
}

const SCROLLS_ON_PURPOSE: readonly ScrollOnPurpose[] = [
  { reason: "faixa de abas", selector: '[role="tablist"]' },
  { reason: "faixa de abas", selector: ':has(> [role="tablist"])' },
  { reason: "tabela de dados", selector: '[data-slot="table-container"]' },
];

interface KnownFinding {
  clientWidth: number;
  /** What a later change has to do about it, in the words of the screen. */
  reason: string;
  scrollWidth: number;
  /** The names of the cases below in which it shows up. */
  screens: readonly string[];
  /** `ClippedElement.selector`, or `html` for the page that scrolls sideways. */
  selector: string;
}

const KNOWN_FINDINGS: readonly KnownFinding[] = [
  {
    clientWidth: 280,
    reason:
      'o cartão "Como chegamos a este resultado" tem 22 px de conteúdo a mais que a caixa',
    screens: ["resultado mês incompleto e gráfico de vendas"],
    scrollWidth: 302,
    selector:
      'div[data-slot="tabs"] > div[data-slot="tabs-content"] > div[data-slot="card"]',
  },
  {
    clientWidth: 250,
    reason:
      'na tabela "Vendas e custos de cada dia" o texto "Depois de hoje: despesas R$ 135,10" passa 68 px da célula (a tabela rola, o texto sai da célula)',
    screens: ["resultado gráfico de vendas e custos e a tabela"],
    scrollWidth: 318,
    selector:
      'tfoot[data-slot="table-footer"] > tr[data-slot="table-row"] > td[data-slot="table-cell"]',
  },
  {
    clientWidth: 280,
    reason:
      "o cartão da venda (Confirmada, Data da venda…) tem 10 px de conteúdo a mais que a caixa",
    screens: [
      "detalhe da venda aberto",
      "detalhe da venda cancelamento revisado",
      "detalhe da venda cliente da venda",
      "detalhe da venda trocar o cliente",
    ],
    scrollWidth: 290,
    selector: 'main > section > div[data-slot="card"]',
  },
];

const MEASURE_TOLERANCE = 1;
const REFLOW_WIDTH = 320;

interface Case {
  name: string;
  open: (page: Page, context: BrowserContext) => Promise<void>;
}

const stateOf = (name: string): Case => {
  const screen = SCREENS.find((candidate: UiScreen) => candidate.name === name);
  if (screen === undefined) {
    throw new Error(`no state "${name}" in e2e-pwa/ui-screens.ts`);
  }
  return { name, open: screen.open };
};
const states = (...names: string[]) => names.map(stateOf);

const rpc = (json: unknown) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const HELP: Case = {
  name: "ajuda",
  open: async (page) => {
    await serve(page);
    await page.goto("/ajuda");
    await expect(
      page.getByRole("heading", { level: 1, name: "Ajuda e contato" })
    ).toBeVisible();
  },
};

const DATA_EXPORT: Case = {
  name: "seus dados com uma cópia pronta e um pedido em andamento",
  open: async (page) => {
    await page.clock.setFixedTime(new Date("2026-10-30T15:00:00.000Z"));
    await serve(page, [
      {
        id: ORGANIZATION_ID,
        name: "Loja do teste",
        role: "owner",
        timezone: "America/Sao_Paulo",
      },
    ]);
    await page.route("**/rpc/organization/listMine", (route) =>
      route.fulfill(
        rpc({
          billingSelfService: false,
          organizations: [
            {
              id: ORGANIZATION_ID,
              name: "Loja do teste",
              role: "owner",
              timezone: "America/Sao_Paulo",
            },
          ],
        })
      )
    );
    await page.route("**/rpc/dataExport/list", (route) =>
      route.fulfill(
        rpc({
          exports: [
            {
              errorCode: null,
              expiresAt: "2026-10-31T14:40:00.000Z",
              files: [{ name: "dados.json", ordinal: 1, sizeBytes: 820_400 }],
              formats: ["json", "csv"],
              id: "0199c2d0-0000-7000-8000-0000000000aa",
              readyAt: "2026-10-30T14:40:00.000Z",
              requestedAt: "2026-10-30T14:10:00.000Z",
              status: "ready",
              totalBytes: 820_400,
            },
            {
              errorCode: null,
              expiresAt: null,
              files: [],
              formats: ["json", "csv"],
              id: "0199c2d0-0000-7000-8000-0000000000ab",
              readyAt: null,
              requestedAt: "2026-10-30T14:50:00.000Z",
              status: "requested",
              totalBytes: null,
            },
          ],
        })
      )
    );
    await page.goto("/configuracoes?aba=seus-dados");
    await expect(
      page.getByRole("heading", { exact: true, level: 2, name: "Seus dados" })
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Suas cópias" })
    ).toContainText("dados.json");
  },
};

/** The cases of each screen of `screenKeys()` this file measures. */
const COVERED: Readonly<Record<string, readonly Case[]>> = {
  customers: states("clientes cliente parecido"),
  "dashboard:despesas": states(
    "despesas lista",
    "despesas grade de meses aberta",
    "despesas erros nos campos",
    "despesas recorrentes e o diálogo da regra",
    "despesas categorias e o diálogo da categoria"
  ),
  "dashboard:metas": states("resultado metas", "resultado nova meta com erro"),
  "dashboard:resultado": states(
    "resultado mês incompleto e gráfico de vendas",
    "resultado gráfico de vendas e custos e a tabela",
    "resultado sem dados",
    "resultado sem custo conhecido"
  ),
  help: [HELP],
  "products:categorias": states("categorias lista", "categorias remover"),
  "products:produtos": states(
    "produtos lista",
    "produtos novo produto num passo só",
    "produtos variantes, opções e combinação",
    "produtos imagens, remoção pedindo confirmação"
  ),
  "sale-detail": states(
    "detalhe da venda aberto",
    "detalhe da venda cancelamento revisado",
    "detalhe da venda cliente da venda",
    "detalhe da venda trocar o cliente"
  ),
  "settings:aparelhos": states(
    "aparelhos lista",
    "aparelhos confirmação aberta"
  ),
  "settings:assinatura": states(
    "assinatura oferta com Pix",
    "assinatura Pix aguardando o banco",
    "assinatura Pro ativo",
    "assinatura em teste, com o pé do menu",
    "assinatura cancelar a renovação",
    "assinatura carência com o aviso"
  ),
  "settings:catalogo-publico": states(
    "catálogo público no ar",
    "catálogo público endereço recusado"
  ),
  "settings:formas-de-receber": states(
    "perfis de pagamento lista",
    "perfis de pagamento edição",
    "perfis de pagamento erros nos campos"
  ),
  "settings:senha": states(
    "trocar senha",
    "trocar senha atual errada",
    "trocar senha conta do Google"
  ),
  "settings:seus-dados": [DATA_EXPORT],
};

/** The screens a test of its own measures at 320 px with 20 px: the file of that test. */
const EXCLUDED: Readonly<Record<string, string>> = {
  attention: "pendencias-reflow.e2e.ts",
  customers: "clientes-reflow.e2e.ts",
  home: "home.e2e.ts",
  inventory: "estoque-reflow.e2e.ts",
  sale: "sale-item-reflow.e2e.ts",
  "sale-history": "historico-reflow.e2e.ts",
};

const here = dirname(fileURLToPath(import.meta.url));

interface Finding {
  clientWidth: number;
  scrollWidth: number;
  selector: string;
  text: string;
}

const sameMeasure = (a: number, b: number) =>
  Math.abs(a - b) <= MEASURE_TOLERANCE;

const matches = (known: KnownFinding, finding: Finding) =>
  known.selector === finding.selector &&
  sameMeasure(known.scrollWidth, finding.scrollWidth) &&
  sameMeasure(known.clientWidth, finding.clientWidth);

/** Each known finding takes one finding that shows up: a second element with the same name and measure is new. */
function judge(seen: readonly Finding[], mine: readonly KnownFinding[]) {
  const unused = [...mine];
  const fresh: Finding[] = [];
  for (const finding of seen) {
    const at = unused.findIndex((entry) => matches(entry, finding));
    if (at === -1) {
      fresh.push(finding);
    } else {
      unused.splice(at, 1);
    }
  }
  return { fresh, gone: unused };
}

const describe = ({ clientWidth, scrollWidth, selector, text }: Finding) =>
  `${selector} "${text}": ${scrollWidth} px of content in ${clientWidth} px`;

const DIALOG = '[role="dialog"]';

interface Root {
  locator: Locator;
  skip?: string | undefined;
}

/**
 * The roots of a screen: the page (its `main` when there is one) and each dialog that is open over it. When the page
 * falls back to `body` the dialogs are inside it, so `body` leaves them out and each is measured once, as its own root.
 */
async function rootsOf(page: Page): Promise<Root[]> {
  const main = page.locator("main");
  const onMain = (await main.count()) === 1;
  const pageRoot: Root = onMain
    ? { locator: main }
    : { locator: page.locator("body"), skip: DIALOG };
  const dialogs = page.locator(DIALOG);
  const count = await dialogs.count();
  return [
    pageRoot,
    ...Array.from({ length: count }, (_, i) => ({ locator: dialogs.nth(i) })),
  ];
}

/**
 * Whether the page is wider than the window. On a phone the layout viewport grows to the widest content, so the window
 * reads as wide as the page and `scrollWidth` never passes `clientWidth`: the width of the window is read too, and the
 * element that reaches farthest to the right is named.
 */
async function pageScroll(page: Page): Promise<Finding | null> {
  const { farthest, scroll, windowWidth } = await page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    let reach = 0;
    let name = "";
    for (const item of document.body.querySelectorAll("*")) {
      const { right } = item.getBoundingClientRect();
      if (right > reach && getComputedStyle(item).position !== "fixed") {
        reach = right;
        name = `${item.tagName.toLowerCase()} "${(item.textContent ?? "").trim().slice(0, 30)}"`;
      }
    }
    return {
      farthest: name,
      scroll: Math.max(scroller.scrollWidth, window.innerWidth),
      windowWidth: scroller.clientWidth,
    };
  });
  return scroll > REFLOW_WIDTH
    ? {
        clientWidth: Math.min(windowWidth, REFLOW_WIDTH),
        scrollWidth: scroll,
        selector: "html",
        text: `a página rola para o lado, até ${farthest}`,
      }
    : null;
}

/**
 * The sweep of one screen already open: what is cut, and whether the page scrolls sideways, against the known findings
 * of `screen`. Returns the findings that are new, and the known ones that did not show up.
 */
async function sweep(
  page: Page,
  screen: string,
  known: readonly KnownFinding[] = KNOWN_FINDINGS
) {
  await expectReflowFont(page);
  expect(page.viewportSize()?.width, "the window is not 320 px wide").toBe(
    REFLOW_WIDTH
  );
  const seen: Finding[] = [];
  let measured = 0;
  for (const { locator, skip } of await rootsOf(page)) {
    // biome-ignore lint/performance/noAwaitInLoops: one root at a time, the page is shared
    const found = await findClipped(locator, {
      allowScroll: SCROLLS_ON_PURPOSE.map(({ selector }) => selector),
      skip,
    });
    measured += found.measured;
    seen.push(
      ...found.offenders.map(
        ({ clientWidth, scrollWidth, selector, text }: ClippedElement) => ({
          clientWidth,
          scrollWidth,
          selector,
          text,
        })
      )
    );
  }
  expect(measured, "no element with text was measured").toBeGreaterThan(0);
  const mine = known.filter((entry) => entry.screens.includes(screen));
  const scrolled = await pageScroll(page);
  if (scrolled !== null) {
    seen.push(scrolled);
  }
  return judge(seen, mine);
}

async function expectScreenWhole(page: Page, screen: string) {
  const { fresh, gone } = await sweep(page, screen);
  expect(
    fresh.map(describe),
    `cut at 320 px with 20 px in "${screen}"`
  ).toEqual([]);
  expect(
    gone.map(
      (known) =>
        `${known.selector} (${known.scrollWidth} px in ${known.clientWidth} px)`
    ),
    `known finding that no longer shows up in "${screen}": take it out of KNOWN_FINDINGS`
  ).toEqual([]);
}

test.describe("a consistência da lista de telas", () => {
  test("toda tela de ROUTES e toda aba está coberta ou excluída com o arquivo do teste dela", () => {
    const keys = screenKeys();
    const listed = new Set([...Object.keys(COVERED), ...Object.keys(EXCLUDED)]);
    expect(
      keys.filter((key) => !listed.has(key)),
      "screen of ROUTES that is neither covered nor excluded"
    ).toEqual([]);
    expect(
      [...listed].filter((key) => !keys.includes(key)),
      "key of the lists that is no screen of ROUTES"
    ).toEqual([]);
    for (const [key, file] of Object.entries(EXCLUDED)) {
      expect(
        existsSync(join(here, file)),
        `${key}: the test ${file} does not exist`
      ).toBe(true);
    }
  });

  test("cada achado conhecido nomeia um caso, a medida e o motivo, e cada rolagem de propósito é tabela de dados ou faixa de abas", () => {
    const names = new Set(
      Object.values(COVERED).flatMap((cases) => cases.map(({ name }) => name))
    );
    for (const known of KNOWN_FINDINGS) {
      for (const screen of known.screens) {
        expect(names.has(screen), `no case "${screen}"`).toBe(true);
      }
      expect(known.screens.length, known.selector).toBeGreaterThan(0);
      expect(known.selector, known.reason).not.toBe("");
      expect(known.scrollWidth, known.selector).toBeGreaterThan(
        known.clientWidth
      );
      expect(known.reason.trim(), known.selector).not.toBe("");
    }
    for (const purpose of SCROLLS_ON_PURPOSE) {
      expect(["faixa de abas", "tabela de dados"]).toContain(purpose.reason);
    }
  });

  test("a lista de rolagem de propósito é exatamente a faixa de abas e a tabela de dados", () => {
    expect(SCROLLS_ON_PURPOSE).toEqual([
      { reason: "faixa de abas", selector: '[role="tablist"]' },
      { reason: "faixa de abas", selector: ':has(> [role="tablist"])' },
      { reason: "tabela de dados", selector: '[data-slot="table-container"]' },
    ]);
  });

  test("os casos têm nome único", () => {
    const names = Object.values(COVERED).flatMap((cases) =>
      cases.map(({ name }) => name)
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(0);
  });
});

const plant = async (page: Page, body: string) => {
  await openReflowViewport(page);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><main>${body}</main></body></html>`
  );
};

test.describe("a guarda pega o que diz pegar", () => {
  test("um elemento cortado reprova e o mesmo texto que cabe passa", async ({
    page,
  }) => {
    await plant(
      page,
      '<span id="cut" style="display:block;width:60px;overflow:hidden;white-space:nowrap">Cartão de crédito parcelado em doze vezes</span>'
    );
    const { fresh } = await sweep(page, "controle");
    expect(fresh.map(describe).join("\n")).toContain("Cartão de crédito");
    await page.locator("#cut").evaluate((element) => {
      element.style.whiteSpace = "normal";
      element.style.overflowWrap = "anywhere";
    });
    expect((await sweep(page, "controle")).fresh).toEqual([]);
  });

  test("a rolagem lateral da página reprova e a página que cabe passa", async ({
    page,
  }) => {
    await plant(
      page,
      '<div id="wide" style="width:400px;height:20px">largura</div>'
    );
    const { fresh } = await sweep(page, "controle", []);
    expect(fresh.map(describe).join("\n")).toContain("html");
    expect(fresh[0]?.scrollWidth).toBe(400);
    await page.locator("#wide").evaluate((element) => {
      element.style.width = "100%";
    });
    expect((await sweep(page, "controle")).fresh).toEqual([]);
  });

  test("a rolagem de propósito da faixa de abas passa, e o corte dentro dela reprova", async ({
    page,
  }) => {
    await plant(
      page,
      '<div role="tablist" style="width:200px;overflow-x:auto;white-space:nowrap">Formas de receber · Catálogo público · Aparelhos<span id="tab" style="display:inline-block;width:40px;overflow:hidden;white-space:nowrap">Assinatura</span></div>'
    );
    const { fresh } = await sweep(page, "controle");
    expect(fresh.map(describe).join("\n")).toContain("Assinatura");
    await page.locator("#tab").evaluate((element) => {
      element.style.width = "auto";
    });
    expect((await sweep(page, "controle")).fresh).toEqual([]);
  });

  test("um achado conhecido passa enquanto existe, e reprova quando some ou quando muda de medida", async ({
    page,
  }) => {
    await plant(
      page,
      '<span id="cut" style="display:block;width:60px;overflow:hidden;white-space:nowrap">Cartão de crédito parcelado em doze vezes</span>'
    );
    const { fresh: [first] = [] } = await sweep(page, "controle", []);
    expect(first?.selector).toBe("main > span#cut");
    const known: KnownFinding = {
      clientWidth: first?.clientWidth ?? 0,
      reason: "controle",
      screens: ["controle"],
      scrollWidth: first?.scrollWidth ?? 0,
      selector: first?.selector ?? "",
    };
    expect(await sweep(page, "controle", [known])).toEqual({
      fresh: [],
      gone: [],
    });
    await page.locator("#cut").evaluate((element) => {
      element.style.width = "40px";
    });
    const worse = await sweep(page, "controle", [known]);
    expect(worse.fresh).toHaveLength(1);
    expect(worse.gone).toEqual([known]);
    await page.locator("#cut").evaluate((element) => {
      element.style.whiteSpace = "normal";
      element.style.overflowWrap = "anywhere";
    });
    const fixed = await sweep(page, "controle", [known]);
    expect(fixed.fresh).toEqual([]);
    expect(fixed.gone).toEqual([known]);
  });
});

test.describe("a guarda pega o que diz pegar, nas isenções e nos diálogos", () => {
  test("a tabela de dados que rola passa, e o corte dentro dela reprova", async ({
    page,
  }) => {
    await plant(
      page,
      '<div data-slot="table-container" style="width:200px;overflow-x:auto"><table style="width:500px"><tbody><tr><td><span id="cell" style="display:block;width:100px;overflow:hidden;white-space:nowrap">Depois de hoje: despesas R$ 135,10</span></td></tr></tbody></table></div>'
    );
    const { fresh } = await sweep(page, "controle", []);
    expect(fresh.map(describe).join("\n")).toContain("Depois de hoje");
    expect(fresh).toHaveLength(1);
    await page.locator("#cell").evaluate((element) => {
      element.style.whiteSpace = "normal";
    });
    expect((await sweep(page, "controle", [])).fresh).toEqual([]);
  });

  test("o corte dentro de um diálogo aberto reprova, fora de main também", async ({
    page,
  }) => {
    await plant(page, "<p>página</p>");
    await page.evaluate(() => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.innerHTML =
        '<span id="cut" style="display:block;width:60px;overflow:hidden;white-space:nowrap">Cartão de crédito parcelado em doze vezes</span>';
      document.body.append(dialog);
    });
    const { fresh } = await sweep(page, "controle", []);
    expect(fresh.map(describe).join("\n")).toContain("Cartão de crédito");
    await page.locator("#cut").evaluate((element) => {
      element.style.whiteSpace = "normal";
      element.style.overflowWrap = "anywhere";
    });
    expect((await sweep(page, "controle", [])).fresh).toEqual([]);
  });

  test("sem main, o diálogo aberto é medido uma vez, e o corte da página fora dele também reprova", async ({
    page,
  }) => {
    await openReflowViewport(page);
    const cut = (id: string) =>
      `<span id="${id}" style="display:block;width:60px;overflow:hidden;white-space:nowrap">Cartão de crédito parcelado em doze vezes</span>`;
    await page.setContent(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div role="dialog">${cut("in-dialog")}</div></body></html>`
    );
    await expect(page.locator("main")).toHaveCount(0);
    const once = await sweep(page, "controle", []);
    expect(once.fresh.map(describe)).toEqual([
      expect.stringContaining("Cartão de crédito"),
    ]);
    await page.evaluate((html) => {
      document.body.insertAdjacentHTML("afterbegin", html);
    }, cut("in-page"));
    const both = await sweep(page, "controle", []);
    expect(both.fresh.map(({ selector }) => selector).sort()).toEqual([
      'div[role="dialog"] > span#in-dialog',
      "span#in-page",
    ]);
  });

  test("a página que rola para o lado é um achado conhecido enquanto rola, e reprova quando deixa de rolar", async ({
    page,
  }) => {
    await plant(
      page,
      '<div id="wide" style="width:400px;height:20px">largura</div>'
    );
    const { fresh: [wide] = [] } = await sweep(page, "controle", []);
    const known: KnownFinding = {
      clientWidth: wide?.clientWidth ?? 0,
      reason: "controle",
      screens: ["controle"],
      scrollWidth: wide?.scrollWidth ?? 0,
      selector: "html",
    };
    expect(await sweep(page, "controle", [known])).toEqual({
      fresh: [],
      gone: [],
    });
    await page.locator("#wide").evaluate((element) => {
      element.style.width = "100%";
    });
    expect((await sweep(page, "controle", [known])).gone).toEqual([known]);
  });

  test("um segundo elemento com o mesmo nome e a mesma medida de um achado conhecido é um achado novo", async ({
    page,
  }) => {
    const cut =
      '<p data-slot="card" style="width:60px;overflow:hidden;white-space:nowrap;margin:0">Cartão de crédito parcelado</p>';
    await plant(page, cut);
    const { fresh: [first] = [] } = await sweep(page, "controle", []);
    const known: KnownFinding = {
      clientWidth: first?.clientWidth ?? 0,
      reason: "controle",
      screens: ["controle"],
      scrollWidth: first?.scrollWidth ?? 0,
      selector: first?.selector ?? "",
    };
    await plant(page, cut + cut);
    const both = await sweep(page, "controle", [known]);
    expect(both.fresh).toHaveLength(1);
    expect(both.gone).toEqual([]);
  });
});

test.describe("a 320 px com letra de 20 px", () => {
  for (const [key, cases] of Object.entries(COVERED)) {
    for (const item of cases) {
      test(`${key}: ${item.name} lê inteira, sem corte e sem rolagem para o lado`, async ({
        context,
        page,
      }) => {
        await openReflowViewport(page);
        await item.open(page, context);
        await expectScreenWhole(page, item.name);
      });
    }
  }
});
