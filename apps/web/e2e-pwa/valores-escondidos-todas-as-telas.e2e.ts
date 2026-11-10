/// <reference lib="dom" />
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { skipOutsideChromium } from "../e2e/reflow";
import { screenKeys } from "../src/app-shell/navigation-model";
import { json, settle } from "./ui-entry-states";
import { SCREENS } from "./ui-screens";
import { serveHealth } from "./worker-mark";

/**
 * AC-3.2 of "Esconder valores": with the choice on, no screen of the shell writes an amount in reais, in any of the
 * places a person, a screen reader or a search can read it: the visible text (`innerText`), all the text of the page
 * (`textContent`, which holds the invisible tables of the charts), and the `aria-label`, `title` and `alt` of every
 * element. What stays out of the sweep is what the person types (the fields, and the options of a select) and the
 * prices and charges of the Polaris plan on the Assinatura (`PLAN_PRICES`): they are the Polaris's, not the store's.
 *
 * `COVERED` lists each screen of `screenKeys()` (each screen of the routes, each tab, and the list of Configurações on
 * a phone) with the states that are swept; a screen that is not there fails `a consistência`, so a new screen that
 * shows reais has to enter the sweep before it merges. The controls below plant an amount in each place and in each
 * exclusion, so a sweep that stops seeing one fails.
 */
skipOutsideChromium();

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const AMOUNT = /R\$\s?\d[\d.]*(?:,\d+)?/;
const PHONE_MAX = 760;
const VIEWPORTS = [
  { height: 740, name: "360", touch: true, width: 360 },
  { height: 800, name: "1280", touch: false, width: 1280 },
] as const;

/** The prices of the plan the Assinatura fixtures offer and charge (`ui-subscription-states.ts`), and the month of the year ("por ano · R$ 20,75 por mês"): the Polaris's, not the store's. */
const PLAN_PRICES = ["R$ 24,90", "R$ 249,00", "R$ 20,75"] as const;

/**
 * An amount that a screen still writes outside `Money`: the places it is read in, and the file that writes it. The sweep
 * fails on a place that is not here and on one that is here and no longer shows up, so a fix takes its line out.
 */
interface KnownLeak {
  places: readonly string[];
  source: string;
}

interface Case {
  /** The state waits for an amount to be written before it is ready: it opens with the values showing, and the choice is made after. */
  hideAfterOpen?: boolean;
  known?: KnownLeak;
  name: string;
  open: (page: Page) => Promise<void>;
  /** Only where the screen exists: the list of Configurações is a phone's. */
  phoneOnly?: boolean;
  planPrices?: boolean;
}

const stateOf = (
  name: string,
  {
    hideAfterOpen = false,
    known,
    planPrices = false,
  }: { hideAfterOpen?: boolean; known?: KnownLeak; planPrices?: boolean } = {}
): Case => {
  const screen = SCREENS.find((candidate) => candidate.name === name);
  if (screen === undefined) {
    throw new Error(`no state "${name}" in e2e-pwa/ui-screens.ts`);
  }
  return {
    hideAfterOpen,
    ...(known ? { known } : {}),
    name,
    open: (page) => screen.open(page, page.context()),
    planPrices,
  };
};
const states = (...names: string[]) => names.map((name) => stateOf(name));

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};

const rpc = (body: unknown) => json(200, { json: body, meta: [] });
const RPC_PREFIX = /^.*\/rpc\//;
const procedureOf = (route: Route) =>
  new URL(route.request().url()).pathname.replace(RPC_PREFIX, "");

/** A signed-in person with one store and a server that answers only what the page asks first: the shell around a screen with no data of its own. */
async function serveShell(page: Page, answers: Record<string, unknown> = {}) {
  await page.clock.setFixedTime(new Date("2026-10-30T15:00:00.000Z"));
  await serveHealth(page);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(
      json(200, {
        session: { id: "s" },
        user: { email: "ana@lojadaana.com.br", id: "u", name: "Ana" },
      })
    )
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = procedureOf(route);
    if (procedure === "organization/listMine") {
      return route.fulfill(
        rpc({ billingSelfService: false, organizations: [ORGANIZATION] })
      );
    }
    if (Object.hasOwn(answers, procedure)) {
      return route.fulfill(rpc(answers[procedure]));
    }
    return route.abort("internetdisconnected");
  });
}

const HELP: Case = {
  name: "ajuda",
  open: async (page) => {
    await serveShell(page);
    await page.goto("/ajuda");
    await expect(
      page.getByRole("heading", { level: 1, name: "Ajuda e contato" })
    ).toBeVisible();
  },
};

const SETTINGS_LIST: Case = {
  name: "configurações a lista do celular",
  open: async (page) => {
    await serveShell(page);
    await page.goto("/configuracoes");
    await expect(
      page.getByRole("heading", { exact: true, level: 2, name: "Da loja" })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { exact: true, name: "Seus dados" })
    ).toBeVisible();
  },
  phoneOnly: true,
};

const DATA_EXPORT: Case = {
  name: "seus dados com uma cópia pronta e um pedido em andamento",
  open: async (page) => {
    await serveShell(page, {
      "dataExport/list": {
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
        ],
      },
    });
    await page.goto("/configuracoes?aba=seus-dados");
    await expect(
      page.getByRole("heading", { exact: true, level: 2, name: "Seus dados" })
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Suas cópias" })
    ).toContainText("dados.json");
  },
};

/** The states swept for each screen of `screenKeys()`: the state of each screen that holds amounts, and the one with the most places for them. */
const COVERED: Readonly<Record<string, readonly Case[]>> = {
  attention: [stateOf("pendências com itens")],
  customers: states("clientes lista"),
  "dashboard:metas": states("resultado metas"),
  "dashboard:resultado": [
    stateOf("resultado mês incompleto e gráfico de vendas"),
    stateOf("resultado gráfico de vendas e custos e a tabela", {
      hideAfterOpen: true,
    }),
  ],
  expenses: [
    stateOf("despesas lista"),
    stateOf("despesas recorrentes e o diálogo da regra"),
  ],
  help: [HELP],
  home: states("início com vendas"),
  inventory: [stateOf("estoque lista"), stateOf("estoque custo informado")],
  "products:categorias": states("categorias lista"),
  "products:produtos": states(
    "produtos lista",
    "produtos variantes, opções e combinação"
  ),
  sale: [stateOf("venda com itens"), stateOf("venda confirmada")],
  "sale-detail": states(
    "detalhe da venda aberto",
    "detalhe da venda cancelamento revisado"
  ),
  "sale-history": states("histórico lista"),
  "settings:aparelhos": states("aparelhos lista"),
  "settings:assinatura": [
    stateOf("assinatura oferta com Pix", { planPrices: true }),
    stateOf("assinatura Pro ativo", { planPrices: true }),
  ],
  "settings:catalogo-publico": states("catálogo público no ar"),
  "settings:formas-de-receber": [stateOf("perfis de pagamento lista")],
  "settings:lista": [SETTINGS_LIST],
  "settings:senha": states("trocar senha"),
  "settings:seus-dados": [DATA_EXPORT],
};

interface Leak {
  place: string;
  text: string;
}

/**
 * Every place of the page that writes an amount in reais, outside the fields where a person types and outside
 * `allowed` (exact texts). `textContent` is read node by node, so the code and the styles of the page are not text.
 */
async function leaksOf(page: Page, allowed: readonly string[]) {
  return await page.evaluate(
    ({ pattern, skipped }) => {
      const amounts = new RegExp(pattern, "g");
      const found: { place: string; text: string }[] = [];
      const typed = "input, textarea, select, [contenteditable]";
      const notText = "script, style, noscript, template";
      const clean = (text: string) => {
        let rest = text;
        for (const price of skipped) {
          rest = rest.split(price).join("");
        }
        return rest;
      };
      const look = (place: string, text: string | null) => {
        if (text === null) {
          return;
        }
        for (const amount of clean(text).matchAll(amounts)) {
          found.push({ place, text: amount[0].replace(/\s+/g, " ") });
        }
      };
      // what is typed is not read: hidden while the visible text is taken, and then shown again
      const fields = [...document.querySelectorAll<HTMLElement>(typed)];
      const displays = fields.map((field) => field.style.display);
      for (const field of fields) {
        field.style.display = "none";
      }
      look("innerText", document.body.innerText);
      fields.forEach((field, index) => {
        field.style.display = displays[index] ?? "";
      });
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent && !parent.closest(`${typed}, ${notText}`)) {
          look("textContent", node.textContent);
        }
      }
      for (const element of document.querySelectorAll(
        "[aria-label], [title], [alt]"
      )) {
        if (element.closest(typed)) {
          continue;
        }
        for (const name of ["aria-label", "title", "alt"]) {
          look(name, element.getAttribute(name));
        }
      }
      return found;
    },
    { pattern: AMOUNT.source, skipped: [...allowed] }
  );
}

/** One line per place and amount, each once and in order, so the list a screen is known by does not depend on the width. */
const describeLeaks = (leaks: readonly Leak[]) =>
  [...new Set(leaks.map((leak) => `${leak.place}: ${leak.text}`))].sort();

/** The choice of the device, made before the page loads: the same key the button writes. */
const rememberTheChoice = (page: Page, hidden: boolean) =>
  page.addInitScript((escondidos) => {
    window.localStorage.setItem("polaris-tema", "claro");
    if (escondidos) {
      window.localStorage.setItem("polaris-valores", "escondidos");
    }
  }, hidden);

test.describe("a consistência da lista de telas", () => {
  test("toda tela de screenKeys() está na varredura, e toda tela da varredura existe", () => {
    const keys = screenKeys();
    const listed = Object.keys(COVERED);
    expect(
      keys.filter((key) => !listed.includes(key)),
      "tela da casca que a varredura de Esconder valores não percorre"
    ).toEqual([]);
    expect(
      listed.filter((key) => !keys.includes(key)),
      "chave da varredura que não é tela da casca"
    ).toEqual([]);
    for (const [key, cases] of Object.entries(COVERED)) {
      expect(cases.length, `${key} sem nenhum estado`).toBeGreaterThan(0);
      for (const { known, name } of cases) {
        if (known) {
          expect(
            existsSync(join(webRoot, known.source)),
            `${name}: ${known.source} não existe`
          ).toBe(true);
        }
      }
    }
  });
});

test.describe("os controles da varredura: um valor plantado em cada lugar é achado, e cada exceção só vale onde diz", () => {
  const plant = (body: string) => async (page: Page) => {
    await page.setContent(`<body>${body}</body>`);
    return describeLeaks(await leaksOf(page, []));
  };

  test("o texto visível, o texto invisível, o aria-label, o title e o alt são lidos", async ({
    page,
  }) => {
    expect(await plant("<p>Total R$ 1,00</p>")(page)).toContain(
      "innerText: R$ 1,00"
    );
    const hidden = await plant(
      '<p style="position:absolute;clip:rect(0,0,0,0)">Total R$ 1,00</p>'
    )(page);
    expect(hidden.some((line) => line.startsWith("textContent"))).toBe(true);
    for (const attribute of ["aria-label", "title", "alt"]) {
      // biome-ignore lint/performance/noAwaitInLoops: one page content at a time
      const found = await plant(
        `<button ${attribute}="Pagar R$ 12,00">ok</button>`
      )(page);
      expect(found.some((line) => line.startsWith(attribute))).toBe(true);
    }
    expect(await plant("<p>R$ ••••</p>")(page)).toEqual([]);
    expect(await plant("<p>R$ e mais nada</p>")(page)).toEqual([]);
  });

  test("os campos de digitação ficam fora, o resto do mesmo texto não", async ({
    page,
  }) => {
    expect(
      await plant(
        '<input aria-label="Preço R$ 10,00" title="R$ 10,00"><textarea>R$ 10,00</textarea><select><option>R$ 10,00</option></select>'
      )(page)
    ).toEqual([]);
    expect(
      (
        await plant('<label>Preço R$ 10,00 <input aria-label="Preço"></label>')(
          page
        )
      ).length
    ).toBeGreaterThan(0);
  });

  test("script, style e noscript ficam fora, o texto ao lado deles não", async ({
    page,
  }) => {
    expect(
      await plant(
        "<script>var a = 'R$ 3,00'</script><style>/* R$ 3,00 */</style><noscript>R$ 3,00</noscript>"
      )(page)
    ).toEqual([]);
    expect(
      (
        await plant(
          "<noscript>R$ 3,00</noscript><div><span>R$ 3,00</span></div>"
        )(page)
      ).length
    ).toBeGreaterThan(0);
  });

  test("o preço do plano só some do texto onde a lista o permite", async ({
    page,
  }) => {
    await page.setContent(
      "<body><p>Pro por R$ 24,90 ao mês</p><p>Venda de R$ 24,91</p></body>"
    );
    expect(describeLeaks(await leaksOf(page, []))).not.toEqual([]);
    const allowed = await leaksOf(page, PLAN_PRICES);
    expect(allowed.map((leak) => leak.text)).toEqual(
      expect.arrayContaining([expect.stringContaining("R$ 24,91")])
    );
    expect(allowed.filter((leak) => leak.text.includes("R$ 24,90"))).toEqual(
      []
    );
  });
});

for (const viewport of VIEWPORTS) {
  test.describe(`varredura a ${viewport.name} px`, () => {
    test.use({
      hasTouch: viewport.touch,
      isMobile: viewport.touch,
      viewport: { height: viewport.height, width: viewport.width },
    });
    for (const [key, cases] of Object.entries(COVERED)) {
      for (const screen of cases) {
        if (screen.phoneOnly && viewport.width > PHONE_MAX) {
          continue;
        }
        test(`${key} · ${screen.name}: escondidos, nenhum R$ com dígitos no texto, no texto invisível, no aria-label, no title nem no alt`, async ({
          page,
        }) => {
          await rememberTheChoice(page, !screen.hideAfterOpen);
          await screen.open(page);
          if (screen.hideAfterOpen) {
            // the lab of a state has no header: the choice comes as it does from another tab of the device
            await page.evaluate(() => {
              window.localStorage.setItem("polaris-valores", "escondidos");
              window.dispatchEvent(
                new StorageEvent("storage", { key: "polaris-valores" })
              );
            });
            await expect(
              page.locator("[data-masked-money]").first()
            ).toBeAttached();
          }
          await settle(page);
          await expect(page.locator("main").first()).toBeAttached();
          expect(
            describeLeaks(
              await leaksOf(page, screen.planPrices ? PLAN_PRICES : [])
            ),
            "valor em reais fora do Money com Esconder valores ligado (o que está na lista de vazamentos conhecidos da tela sai dela quando é corrigido)"
          ).toEqual([...(screen.known?.places ?? [])].sort());
        });
      }
    }
  });
}
