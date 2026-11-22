/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { json, serveFoot, TRIAL_PLAN } from "./shell-server";

/**
 * O cartão do plano no pé do menu: sempre visível para o dono de uma loja Free, sem fechar, na
 * lateral, recolhido e na folha "Mais", sem nenhuma leitura a mais do plano.
 */

const FREE_PLAN = {
  ...TRIAL_PLAN,
  accessEndsAt: null,
  cycleMonths: null,
  limits: { goals: 1, images: 50, variants: 50 },
  method: null,
  nextCharge: null,
  state: "free",
  usage: { goals: 0, images: 3, variants: 12 },
};

const PLAN_READ_CEILING_MS = 3000;
const FREE_STATES = new Set(["free", "free_over_limit"]);
const USE_TEXT = "Você usa 12 de 50 variantes no plano Free.";
const PITCH =
  "Catálogo público no ar, vendas sem internet e mais variantes, imagens e metas.";
const FOLDED_NAME = "Plano Free, 12 de 50 variantes, conhecer o Pro";
const SUBSCRIPTION = "/configuracoes?aba=assinatura";

const card = (scope: Pick<Page, "locator">) =>
  scope.locator("[data-plan-card]");
const proLink = (scope: Pick<Page, "locator">) =>
  card(scope).getByRole("link", { exact: true, name: "Conhecer o Pro" });
const more = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Mais" });
const nav = (page: Page) =>
  page.getByRole("navigation", { exact: true, name: "Principal" });

async function box(locator: ReturnType<Page["locator"]>) {
  const found = await locator.boundingBox();
  if (found === null) {
    throw new Error("sem caixa");
  }
  return found;
}

async function holdRead(page: Page, plan: unknown) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/billing/readPlan", async (route) => {
    await held;
    await route.fulfill(json(plan));
  });
  return release;
}

/** Records, in the first frame where the line of the first steps exists, where it is and whether the card and the trial already are. */
async function watchFoot(page: Page) {
  await page.addInitScript(() => {
    const seen = () => {
      const steps = document.querySelector("[data-menu-first-steps]");
      if (steps === null || Reflect.has(window, "polarisFirstSighting")) {
        return;
      }
      Reflect.set(window, "polarisFirstSighting", {
        card: document.querySelector("[data-plan-card]") !== null,
        top: steps.getBoundingClientRect().top,
        trial: document.querySelector("[data-menu-trial]") !== null,
      });
    };
    Reflect.set(window, "polarisCls", 0);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        hadRecentInput: boolean;
        value: number;
      }[]) {
        if (!entry.hadRecentInput) {
          Reflect.set(
            window,
            "polarisCls",
            (Reflect.get(window, "polarisCls") as number) + entry.value
          );
        }
      }
    }).observe({ buffered: true, type: "layout-shift" });
    new MutationObserver(seen).observe(document, {
      childList: true,
      subtree: true,
    });
  });
}

interface FootFrame {
  steps: number | null;
  trial: number | null;
}

interface FootFrames {
  after: FootFrame[];
  before: FootFrame;
}

const FRAMES_AFTER_ENTRY = 30;

/** Samples the tops of the line of the first steps and of the trial in every frame: the last frame without either, and the frames from the first one that has one. */
async function watchFrames(page: Page, wanted: number) {
  await page.addInitScript((limit: number) => {
    const topOf = (selector: string) => {
      const found = document.querySelector(selector);
      return found === null ? null : found.getBoundingClientRect().top;
    };
    const frames = {
      after: [] as { steps: number | null; trial: number | null }[],
      before: { steps: null, trial: null } as {
        steps: number | null;
        trial: number | null;
      },
    };
    Reflect.set(window, "polarisFrames", frames);
    const sample = () => {
      const now = {
        steps: topOf("[data-menu-first-steps]"),
        trial: topOf("[data-menu-trial]"),
      };
      if (now.steps === null && now.trial === null) {
        frames.before = now;
      } else if (frames.after.length < limit) {
        frames.after.push(now);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, wanted);
}

async function footFrames(page: Page, wanted: number) {
  await expect
    .poll(() =>
      page.evaluate(
        () => (Reflect.get(window, "polarisFrames") as FootFrames).after.length
      )
    )
    .toBeGreaterThanOrEqual(wanted);
  return await page.evaluate(() => Reflect.get(window, "polarisFrames") as FootFrames);
}

function expectEnteredTogetherAndStill(frames: FootFrames) {
  expect(frames.before).toEqual({ steps: null, trial: null });
  const [entry, ...rest] = frames.after;
  expect(entry?.steps).not.toBeNull();
  expect(entry?.trial).not.toBeNull();
  for (const frame of rest) {
    expect(frame).toEqual(entry);
  }
}

async function firstSighting(page: Page) {
  return await page.evaluate(
    () =>
      Reflect.get(window, "polarisFirstSighting") as {
        card: boolean;
        top: number;
        trial: boolean;
      }
  );
}

async function tops(page: Page) {
  return await page.evaluate(() => {
    const top = (element: Element) => element.getBoundingClientRect().top;
    return {
      others: [
        ...document.querySelectorAll(
          'nav[aria-label="Principal"] a, [data-app-header], main h1'
        ),
      ].map(top),
      steps: top(
        document.querySelector("[data-menu-first-steps]") ?? document.body
      ),
    };
  });
}

test.describe("o cartão do plano Free", () => {
  test("1280 px: no pé da lateral, depois de Ajuda e contato, com o uso, o pitch e o botão de contorno", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 900, width: 1280 });
    const reads = await serveFoot(page, { plan: FREE_PLAN });
    await page.goto("/products");
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText(USE_TEXT);
    await expect(card(page)).toContainText(PITCH);
    await expect(proLink(page)).toHaveAttribute("href", SUBSCRIPTION);
    await expect(card(page).locator("[data-plan-card-art]")).toBeVisible();
    await expect(card(page).locator("[data-plan-card-bar]")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    await expect(card(page).getByRole("button")).toHaveCount(0);
    expect((await box(card(page).locator("[data-plan-card-art]"))).height).toBe(
      40
    );
    const help = await box(
      nav(page).getByRole("link", { exact: true, name: "Ajuda e contato" })
    );
    const cardBox = await box(card(page));
    expect(cardBox.y).toBeGreaterThanOrEqual(help.y + help.height);
    // o botão é de contorno: sem o fundo de tinta nem a esmeralda
    const background = await proLink(page).evaluate(
      (link) => getComputedStyle(link).backgroundColor
    );
    expect(background).not.toBe(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--primary")
      )
    );
    // "Primeiros passos" continua acima do cartão e o teste grátis não aparece
    await expect(page.locator("[data-menu-trial]")).toHaveCount(0);
    const steps = await box(page.locator("[data-menu-first-steps]"));
    expect(steps.y + steps.height).toBeLessThanOrEqual(cardBox.y);
    await expect.poll(() => reads.plan).toBe(1);
    // numa janela baixa a faixa de arte e o pitch saem para os destinos não perderem lugar; o uso e o botão ficam
    await page.setViewportSize({ height: 700, width: 1280 });
    await expect(card(page).locator("[data-plan-card-art]")).toBeHidden();
    await expect(card(page).getByText(PITCH)).toBeHidden();
    await expect(card(page)).toContainText(USE_TEXT);
    await expect(proLink(page)).toBeVisible();
  });

  for (const size of [
    { fits: true, height: 800, width: 1280 },
    { fits: true, height: 720, width: 1280 },
    { fits: false, height: 600, width: 760 },
  ]) {
    test(`a lateral não perde destino com o cartão a ${size.width} x ${size.height}: mesma altura, Ajuda e contato a 1 toque, cartão preso ao pé`, async ({
      browser,
    }) => {
      const heights = async (plan: unknown) => {
        const context = await browser.newContext({
          viewport: { height: size.height, width: size.width },
        });
        const page = await context.newPage();
        await serveFoot(page, { plan });
        await page.goto("/products");
        await expect(page.locator("[data-menu-first-steps]")).toBeVisible();
        await page.waitForLoadState("networkidle");
        if (FREE_STATES.has(String(Reflect.get(plan as object, "state")))) {
          await expect(card(page)).toBeVisible();
        }
        const found = await nav(page)
          .getByRole("link")
          .evaluateAll((all) =>
            all.map((link) => link.getBoundingClientRect().height)
          );
        return { context, found, page };
      };
      const without = await heights({ ...FREE_PLAN, state: "active" });
      await expect(card(without.page)).toHaveCount(0);
      await without.context.close();
      const withCard = await heights(FREE_PLAN);
      const { page } = withCard;
      await expect(card(page)).toBeVisible();
      expect(withCard.found).toEqual(without.found);
      const help = nav(page).getByRole("link", {
        exact: true,
        name: "Ajuda e contato",
      });
      // with a coarse pointer the destinations are 44 px rows and never fit these windows: they scroll, the card stays pinned
      const coarse = await page.evaluate(
        () => matchMedia("(pointer: coarse)").matches
      );
      if (size.fits && !coarse) {
        await expect(help).toBeInViewport({ ratio: 1 });
        expect(
          await page
            .locator('[data-sidebar="content"]')
            .evaluate((node) => node.scrollHeight - node.clientHeight)
        ).toBeLessThanOrEqual(0);
      }
      await help.scrollIntoViewIfNeeded();
      await expect(help).toBeInViewport({ ratio: 1 });
      await expect(card(page)).toBeInViewport({ ratio: 1 });
      const sidebarBox = await box(page.locator('[data-slot="sidebar"]'));
      const cardBox = await box(card(page));
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(
        sidebarBox.y + sidebarBox.height + 1
      );
      await withCard.context.close();
    });
  }

  test("só o dono em free e free_over_limit vê; teste, ativo, carência, funcionário e cobrança desligada não", async ({
    browser,
  }) => {
    const cases = [
      { name: "free", plan: FREE_PLAN, shown: true },
      {
        name: "acima do limite",
        plan: {
          ...FREE_PLAN,
          state: "free_over_limit",
          usage: { ...FREE_PLAN.usage, variants: 62 },
        },
        shown: true,
        text: "Você usa 62 de 50 variantes no plano Free.",
      },
      { name: "teste", plan: TRIAL_PLAN, shown: false },
      {
        name: "ativo",
        plan: { ...FREE_PLAN, state: "active" },
        shown: false,
      },
      {
        name: "carência",
        plan: {
          ...FREE_PLAN,
          accessEndsAt: TRIAL_PLAN.accessEndsAt,
          state: "grace",
        },
        shown: false,
      },
      {
        name: "funcionário",
        options: { role: "cashier" },
        plan: FREE_PLAN,
        shown: false,
      },
      {
        name: "cobrança desligada",
        options: { billingSelfService: false },
        plan: FREE_PLAN,
        shown: false,
      },
    ] as const;
    for (const item of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: one store at a time, each in a context of its own
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setViewportSize({ height: 800, width: 1280 });
      await serveFoot(page, {
        plan: item.plan,
        ...("options" in item ? item.options : {}),
      });
      await page.goto("/products");
      await expect(page.locator("[data-menu-first-steps]")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expect(card(page), item.name).toHaveCount(item.shown ? 1 : 0);
      if ("text" in item) {
        await expect(card(page)).toContainText(item.text);
      }
      await context.close();
    }
  });

  test("não aparece em Nova venda, na Assinatura nem no 404; aparece no Histórico", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { plan: FREE_PLAN });
    await page.goto("/sales/history");
    await expect(card(page)).toBeVisible();
    await page.goto("/sales");
    await expect(
      page.getByRole("heading", { level: 1, name: "Nova venda" })
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(card(page)).toHaveCount(0);
    await page.goto(SUBSCRIPTION);
    await expect(
      page.getByRole("heading", { level: 1, name: "Configurações" })
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(card(page)).toHaveCount(0);
    await page.goto("/uma-rota-que-nao-existe");
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("[data-menu-first-steps]")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(card(page)).toHaveCount(0);
  });

  test("o botão abre a Assinatura dentro do app, sem recarregar a página, e o voltar retorna", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { plan: FREE_PLAN });
    await page.goto("/products");
    await page.evaluate(() => {
      Reflect.set(window, "polarisMark", "mesma página");
    });
    await proLink(page).click();
    await page.waitForURL(`**${SUBSCRIPTION}`);
    expect(await page.evaluate(() => Reflect.get(window, "polarisMark"))).toBe(
      "mesma página"
    );
    await page.goBack();
    await page.waitForURL("**/products");
    await expect(card(page)).toBeVisible();
    // Ctrl+clique segue o caminho do navegador, sem o desvio do app
    await expect(proLink(page)).toHaveAttribute("href", SUBSCRIPTION);
  });

  test("recolhida: só o ícone, com o nome e o tooltip certos, dentro dos 3 rem", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { plan: FREE_PLAN });
    await page.goto("/products");
    await page
      .getByRole("button", { exact: true, name: "Recolher menu" })
      .click();
    await expect(card(page)).toHaveCount(0);
    const icon = page.getByRole("link", { exact: true, name: FOLDED_NAME });
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute("href", SUBSCRIPTION);
    expect((await box(icon)).width).toBeLessThanOrEqual(48);
    await icon.hover();
    await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(
      "Plano Free · 12 de 50 variantes"
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    const side = page.locator('[data-slot="sidebar"]');
    expect(
      await side.evaluate((node) => node.scrollWidth <= node.clientWidth)
    ).toBe(true);
  });

  test("360 px: no fim da folha Mais, compacto, antes dos links legais, com o botão inteiro à vista", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serveFoot(page, { plan: FREE_PLAN });
    await page.goto("/products");
    await more(page).click();
    const panel = page.getByRole("dialog", { name: "Mais" });
    await expect(card(panel)).toBeVisible();
    await expect(card(panel)).toContainText(USE_TEXT);
    await expect(card(panel).locator("[data-plan-card-art]")).toHaveCount(0);
    const cardBox = await box(card(panel));
    const legal = await box(panel.locator("[data-sheet-legal]"));
    const steps = await box(panel.locator("[data-menu-first-steps]"));
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(legal.y);
    expect(steps.y + steps.height).toBeLessThanOrEqual(cardBox.y);
    expect((await box(proLink(panel))).height).toBeGreaterThanOrEqual(32);
    await expect(proLink(panel)).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    await proLink(panel).click();
    await page.waitForURL(`**${SUBSCRIPTION}`);
    await expect(page.getByRole("dialog", { name: "Mais" })).toHaveCount(0);
  });

  test("sem conexão o cartão mostra a última leitura da aba, e a conexão de volta não lê de novo", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const reads = await serveFoot(page, { plan: FREE_PLAN });
    await page.goto("/products");
    await expect(card(page)).toContainText(USE_TEXT);
    await page.context().setOffline(true);
    await expect(card(page)).toContainText(USE_TEXT);
    await page.context().setOffline(false);
    await page.waitForLoadState("networkidle");
    await expect(card(page)).toContainText(USE_TEXT);
    expect(reads.plan).toBe(1);
  });

  test("o pé entra de uma vez: Primeiros passos espera a leitura do plano e nada acima se move", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { plan: FREE_PLAN });
    await watchFoot(page);
    const release = await holdRead(page, FREE_PLAN);
    await page.goto("/products");
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator("[data-menu-first-steps]")).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
    const before = await tops(page);
    release();
    await expect(card(page)).toBeVisible();
    await expect(page.locator("[data-menu-first-steps]")).toBeVisible();
    const first = await firstSighting(page);
    expect(first.card).toBe(true);
    const after = await tops(page);
    expect(after.steps).toBeCloseTo(first.top, 0);
    expect(after.others).toEqual(before.others);
    await page.waitForLoadState("networkidle");
    const cls = await page.evaluate(() => Reflect.get(window, "polarisCls"));
    expect(cls).toBeLessThanOrEqual(0.01);
    console.log(
      `t1565 1280: CLS ${cls}; Primeiros passos no 1º quadro ${first.top} px, depois ${after.steps} px`
    );
  });

  test("celular emulado: Primeiros passos e o cartão entram juntos na folha Mais, sem deslocamento", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await serveFoot(page, { plan: FREE_PLAN });
    await watchFoot(page);
    const release = await holdRead(page, FREE_PLAN);
    await page.goto("/products");
    await expect(page.locator("main h1")).toBeVisible();
    await more(page).click();
    const dialog = page.getByRole("dialog", { name: "Mais" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-menu-first-steps]")).toHaveCount(0);
    release();
    await expect(dialog.locator("[data-plan-card]")).toBeVisible();
    await expect(dialog.locator("[data-menu-first-steps]")).toBeVisible();
    const first = await firstSighting(page);
    expect(first.card).toBe(true);
    const after = await box(dialog.locator("[data-menu-first-steps]"));
    expect(after.y).toBeCloseTo(first.top, 0);
    console.log(
      `t1565 360: Primeiros passos no 1º quadro ${first.top} px, depois ${after.y} px`
    );
  });

  test("Primeiros passos e Teste grátis entram juntos, no mesmo quadro, e nada se move", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { plan: TRIAL_PLAN });
    await watchFoot(page);
    await watchFrames(page, FRAMES_AFTER_ENTRY);
    const release = await holdRead(page, TRIAL_PLAN);
    await page.goto("/products");
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator("[data-menu-first-steps]")).toHaveCount(0);
    await expect(page.locator("[data-menu-trial]")).toHaveCount(0);
    release();
    await expect(page.locator("[data-menu-trial]")).toBeVisible();
    await expect(page.locator("[data-menu-first-steps]")).toBeVisible();
    const first = await firstSighting(page);
    expect(first.trial).toBe(true);
    const after = await tops(page);
    expect(after.steps).toBeCloseTo(first.top, 0);
    expectEnteredTogetherAndStill(await footFrames(page, FRAMES_AFTER_ENTRY));
  });

  test("a conexão cai com a leitura do plano pendente: Primeiros passos aparece antes do teto e não se move", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { plan: FREE_PLAN });
    await watchFoot(page);
    await watchFrames(page, FRAMES_AFTER_ENTRY);
    await holdRead(page, FREE_PLAN);
    await page.goto("/products");
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator("[data-menu-first-steps]")).toHaveCount(0);
    await page.context().setOffline(true);
    await expect(page.locator("[data-menu-first-steps]")).toBeVisible({
      timeout: PLAN_READ_CEILING_MS - 1000,
    });
    const first = await firstSighting(page);
    const frames = await footFrames(page, FRAMES_AFTER_ENTRY);
    expect(frames.before.steps).toBeNull();
    for (const frame of frames.after) {
      expect(frame.steps).toBe(frames.after[0]?.steps);
    }
    expect(frames.after[0]?.steps).toBeCloseTo(first.top, 0);
    await expect(card(page)).toHaveCount(0);
    expect((await tops(page)).steps).toBeCloseTo(first.top, 0);
  });

  for (const item of [
    { name: "Pro", plan: { ...FREE_PLAN, state: "active" } },
    {
      name: "carência",
      plan: {
        ...FREE_PLAN,
        accessEndsAt: TRIAL_PLAN.accessEndsAt,
        state: "grace",
      },
    },
  ]) {
    test(`${item.name}: Primeiros passos aparece com a leitura e não se move depois`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width: 1280 });
      await serveFoot(page, { plan: item.plan });
      await watchFoot(page);
      await page.goto("/products");
      await expect(page.locator("[data-menu-first-steps]")).toBeVisible();
      const first = await firstSighting(page);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("[data-menu-first-steps]")).toBeVisible();
      expect((await tops(page)).steps).toBeCloseTo(first.top, 0);
    });
  }

  test("falha da leitura: Primeiros passos aparece e fica onde está", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { plan: FREE_PLAN });
    await watchFoot(page);
    await page.route("**/rpc/billing/readPlan", (route) =>
      route.fulfill({ body: "{}", status: 500 })
    );
    await page.goto("/products");
    await expect(page.locator("[data-menu-first-steps]")).toBeVisible();
    const first = await firstSighting(page);
    await page.waitForLoadState("networkidle");
    await expect(card(page)).toHaveCount(0);
    expect((await tops(page)).steps).toBeCloseTo(first.top, 0);
  });

  test("leitura sem resposta: no teto de 3 s Primeiros passos aparece", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { plan: FREE_PLAN });
    await holdRead(page, FREE_PLAN);
    await page.goto("/products");
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator("[data-menu-first-steps]")).toHaveCount(0);
    await expect(page.locator("[data-menu-first-steps]")).toBeVisible({
      timeout: 8000,
    });
  });

  test("funcionário não espera a leitura: Primeiros passos aparece com ela pendente", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await serveFoot(page, { plan: FREE_PLAN, role: "cashier" });
    await holdRead(page, FREE_PLAN);
    await page.goto("/products");
    await expect(page.locator("[data-menu-first-steps]")).toBeVisible({
      timeout: 1500,
    });
  });

  test("com a leitura guardada na aba, Primeiros passos e o cartão aparecem sem espera", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const reads = await serveFoot(page, { plan: FREE_PLAN });
    await page.goto("/products");
    await expect(card(page)).toBeVisible();
    const release = await holdRead(page, FREE_PLAN);
    await page.reload();
    await expect(page.locator("[data-menu-first-steps]")).toBeVisible({
      timeout: 1500,
    });
    await expect(card(page)).toBeVisible();
    release();
    expect(reads.plan).toBe(1);
  });

  test("aberto já sem conexão e sem leitura guardada: sem cartão e sem leitura; a conexão que chega lê uma vez e traz o cartão", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await page.addInitScript(() => {
      Object.defineProperty(window, "polarisOffline", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => !("polarisOffline" in window),
      });
    });
    const reads = await serveFoot(page, { plan: FREE_PLAN });
    await page.goto("/products");
    await expect(page.locator("[data-menu-first-steps]")).toBeVisible();
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await page.waitForLoadState("networkidle");
    await expect(card(page)).toHaveCount(0);
    expect(reads.plan).toBe(0);
    await page.evaluate(() => {
      Reflect.deleteProperty(window, "polarisOffline");
      window.dispatchEvent(new Event("online"));
    });
    await expect(card(page)).toContainText(USE_TEXT, { timeout: 15_000 });
    expect(reads.plan).toBe(1);
  });
});
