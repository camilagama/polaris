/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { addDays, localDate, monthStart } from "../calendar";
import { expect, type Journey, openJourney, runT0, test } from "../fixtures";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
const AN_AMOUNT_DIGIT = /\d/;
const SALES_OF_PERIOD = /^Vendas /;
const SALES_OF_MONTH = /^Vendas em /;
/** The values of a card of the Início or of the Resultado: the figure of the KPI and the percent of its change. */
const FIGURES = "[data-kpi-value], [data-kpi-delta]";
const SAMPLE_MS = 3000;
/** The period switch is slower than the first paint on a loaded machine: it samples longer after it. */
const SWITCH_SAMPLE_MS = 8000;

interface Box {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface Figure {
  /** What a screen reader gets: the text outside any `aria-hidden` subtree. */
  accessible: string;
  /** The text of a chip beside its figure ("vs. setembro"), inside the card: the one that slides. */
  against: Box | null;
  /** Where the figure is inside its card, as the frame saw it: a reflow of the page around the card is not its move. */
  box: Box;
  card: { height: number; width: number };
  /** Whether the counter (the element that draws the digits) is in the tree. */
  counter: boolean;
  /** Whether its animations are running. */
  counting: boolean;
  /** The box of the counter's host, empty when it is not in the tree. */
  counterBox: Box;
  /** Whether some text of it is drawn transparent, itself or through an ancestor up to the card. */
  faded: boolean;
  id: string;
  /** Every text in the tree, the shadow roots of the counters included. */
  tree: string;
}

interface Frame {
  figures: Figure[];
  /** Whether a counter is inside each of those numbers: it must never be. */
  outsideCounters: Record<string, boolean>;
  outside: Record<string, string>;
  /** The counters whose animations are running. */
  running: number;
  t: number;
}

interface Outside {
  name: string;
  region: string;
  within?: string;
}

declare global {
  interface Window {
    cspViolations?: number;
    sampleDone?: boolean;
    sampled?: Frame[];
  }
}

/**
 * The sampler: from the moment it starts, once per frame (`requestAnimationFrame`, never a timer), it records what the
 * figures of the cards say to a screen reader and in the whole tree, the size of their cards, the numbers outside the
 * closed list and the animations running inside a counter. It lives in the page, so no frame is lost to the test.
 */
function startSampler(config: {
  limit: number;
  outside: Outside[];
  selector: string;
}) {
  const frames: Frame[] = [];
  const origin = performance.now();
  let settled: number | null = null;
  const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
  const collect = (node: Node, deep: boolean, sink: string[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      sink.push(node.textContent ?? "");
      return;
    }
    if (!(node instanceof Element)) {
      return;
    }
    if (!deep && node.getAttribute("aria-hidden") === "true") {
      return;
    }
    for (const child of node.childNodes) {
      collect(child, deep, sink);
    }
    if (deep && node.shadowRoot) {
      for (const child of node.shadowRoot.childNodes) {
        collect(child, deep, sink);
      }
    }
  };
  const textOf = (node: Element, deep: boolean) => {
    const sink: string[] = [];
    collect(node, deep, sink);
    return tidy(sink.join(""));
  };
  const regionNamed = (name: string) =>
    [...document.querySelectorAll("[role=region]")].find((region) => {
      const labelled = region.getAttribute("aria-labelledby");
      const title = labelled ? document.getElementById(labelled) : null;
      return (region.getAttribute("aria-label") ?? title?.textContent) === name;
    });
  const tick = () => {
    const t = performance.now() - origin;
    const figures = [...document.querySelectorAll(config.selector)].map(
      (element) => {
        const card = element.closest("[data-kpi]");
        const box = card?.getBoundingClientRect();
        const own = element.getBoundingClientRect();
        const aside = element
          .querySelector("[data-kpi-delta-against]")
          ?.getBoundingClientRect();
        const within = (rect: DOMRect) => ({
          height: rect.height,
          left: rect.left - (box?.left ?? 0),
          top: rect.top - (box?.top ?? 0),
          width: rect.width,
        });
        return {
          accessible: textOf(element, false),
          against: aside ? within(aside) : null,
          box: within(own),
          card: { height: box?.height ?? 0, width: box?.width ?? 0 },
          counter: element.querySelector("[data-animated-figure]") !== null,
          counterBox: within(
            element
              .querySelector("[data-animated-figure]")
              ?.getBoundingClientRect() ?? new DOMRect()
          ),
          counting: element.querySelector("[data-figure-counting]") !== null,
          faded: [element, ...element.querySelectorAll("*")].some((node) => {
            if ((node.textContent ?? "").trim() === "") {
              return false;
            }
            let opacity = 1;
            for (
              let up: Element | null = node;
              up && up !== card?.parentElement;
              up = up.parentElement
            ) {
              opacity *= Number(getComputedStyle(up).opacity);
            }
            return opacity < 0.05;
          }),
          id: `${card?.getAttribute("aria-labelledby") ?? "?"}/${element.hasAttribute("data-kpi-value") ? "valor" : "chip"}`,
          tree: textOf(element, true),
        };
      }
    );
    const outside: Record<string, string> = {};
    const outsideCounters: Record<string, boolean> = {};
    for (const { name, region, within } of config.outside) {
      const found = regionNamed(region);
      const target = within ? found?.querySelector(within) : found;
      outside[name] = target ? textOf(target, false) : "";
      outsideCounters[name] =
        (target?.querySelector("[data-animated-figure]") ?? null) !== null;
    }
    // the counter says when its animations run: its root is closed, so the test cannot look inside
    const running = document.querySelectorAll("[data-figure-counting]").length;
    frames.push({ figures, outside, outsideCounters, running, t });
    const hasDigit = (text: string) =>
      [...text].some((char) => char >= "0" && char <= "9");
    const ready =
      figures.some((figure) => hasDigit(figure.accessible)) &&
      config.outside.every(({ name }) => hasDigit(outside[name] ?? ""));
    if (ready && settled === null) {
      settled = t;
    }
    // it samples for `limit` ms after the figures (and the numbers asked for) are on the screen, 30 s at most
    if ((settled === null || t < settled + config.limit) && t < 30_000) {
      requestAnimationFrame(tick);
      return;
    }
    window.sampled = frames;
    window.sampleDone = true;
  };
  window.sampleDone = false;
  requestAnimationFrame(tick);
}

const COUNTER_CHUNK = /\/assets\/figure-counter-[\w-]+\.js/;

/** The requests of the page for the chunk of the counter: the package that draws the digits. */
function watchCounterChunk(page: Page): string[] {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (COUNTER_CHUNK.test(request.url())) {
      requested.push(request.url());
    }
  });
  return requested;
}

const sampler = (outside: Outside[], limit = SAMPLE_MS) => ({
  limit,
  outside,
  selector: FIGURES,
});

async function readFrames(page: Page): Promise<Frame[]> {
  await page.waitForFunction(() => window.sampleDone === true, undefined, {
    timeout: SWITCH_SAMPLE_MS + 40_000,
  });
  return await page.evaluate(() => window.sampled ?? []);
}

const INICIO_OUTSIDE: Outside[] = [
  { name: "mais vendidos", region: "Mais vendidos do mês" },
  { name: "total do gráfico", region: "Vendas por dia", within: "p" },
];
const RESULTADO_OUTSIDE: Outside[] = [
  { name: "cadeia", region: "Como chegamos a este resultado" },
];

/**
 * A shop with a sale of 2 candles today (R$ 90,00) and one of a candle on the last day of the previous month (R$ 45,00).
 * With `comparable`, one more 30 days ago, the oldest day a sale can be dated: it is in the 30 days before "Últimos 30
 * dias", the period those chips compare with, and the month's own comparison range has no sale in it on most days.
 */
async function seedStore(journey: Journey, comparable = false): Promise<void> {
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);
  const lastMonthDay = addDays(monthStart(today), -1);
  const oldest = addDays(today, -30);
  const candle = await seedProduct(
    rpc,
    organizationId,
    "Vela aromática",
    "45.00"
  );
  await seedStock(
    rpc,
    organizationId,
    candle.variantId,
    10,
    "12.00",
    comparable && oldest < lastMonthDay ? oldest : lastMonthDay
  );
  if (comparable) {
    await seedCashSale(
      rpc,
      organizationId,
      [{ price: "45.00", quantity: 1, variantId: candle.variantId }],
      `${oldest}T15:00:00.000Z`
    );
  }
  await seedCashSale(
    rpc,
    organizationId,
    [{ price: "45.00", quantity: 1, variantId: candle.variantId }],
    `${lastMonthDay}T15:00:00.000Z`
  );
  await seedCashSale(
    rpc,
    organizationId,
    [{ price: "45.00", quantity: 2, variantId: candle.variantId }],
    new Date(runT0()).toISOString()
  );
}

/** The frames from the first one in which a figure of the cards is on the screen. */
function fromFigures(frames: Frame[]): Frame[] {
  const first = frames.findIndex((frame) =>
    frame.figures.some((figure) => AN_AMOUNT_DIGIT.test(figure.accessible))
  );
  expect(first, "a figure of a card reached the screen").toBeGreaterThanOrEqual(
    0
  );
  return frames.slice(first);
}

/** What each figure says to a screen reader in the last frame: the final text. */
function finalAccessible(frames: Frame[]): Map<string, string> {
  const last = frames.at(-1) as Frame;
  return new Map(last.figures.map((figure) => [figure.id, figure.accessible]));
}

function expectNoStepsAnnounced(frames: Frame[]) {
  const final = finalAccessible(frames);
  const seen = new Set<string>();
  for (const frame of frames) {
    for (const figure of frame.figures) {
      // a card that has not loaded yet says nothing: the figure counts from the first frame in which it has a number
      if (!(seen.has(figure.id) || AN_AMOUNT_DIGIT.test(figure.accessible))) {
        continue;
      }
      seen.add(figure.id);
      expect(
        figure.accessible,
        `${figure.id} at ${Math.round(frame.t)} ms`
      ).toBe(final.get(figure.id));
    }
  }
}

const PERIOD_BUTTON_NAME = /^Período: .+, editar$/;

/** The sampler starts after the panel is open, so it sees only the change. */
async function openPeriod(page: Page): Promise<void> {
  await page.getByRole("button", { name: PERIOD_BUTTON_NAME }).click();
  await expect(page.getByRole("dialog", { name: "Período" })).toBeVisible();
}

function nearest(frames: Frame[], t: number): Frame {
  return frames.reduce((best, frame) =>
    Math.abs(frame.t - t) < Math.abs(best.t - t) ? frame : best
  );
}

async function openWith(
  page: Page,
  address: string,
  outside: Outside[],
  ready: () => Promise<void>
): Promise<Frame[]> {
  await page.addInitScript(() => {
    window.cspViolations = 0;
    document.addEventListener("securitypolicyviolation", () => {
      window.cspViolations = (window.cspViolations ?? 0) + 1;
    });
  });
  await page.addInitScript(startSampler, sampler(outside));
  await page.goto(address);
  await ready();
  return await readFrames(page);
}

test("início, no desktop: o valor final chega ao leitor de tela de uma vez, o cartão não muda de tamanho e nada conta do zero na entrada (AC-8.3, AC-8.4, AC-8.6)", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "contador", {
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  const counterChunk = watchCounterChunk(page);
  const frames = await openWith(page, "/", INICIO_OUTSIDE, async () => {
    await expect(
      page.getByRole("region", { name: "Vendas hoje" })
    ).toContainText("R$ 90,00");
  });
  const shown = fromFigures(frames);
  expect(counterChunk, "o desktop baixa o pedaço do contador").not.toEqual([]);

  // the page's policy refuses a style element: the counter is styled by a constructed sheet, so nothing is refused, its
  // root is closed (its digits are not text of the card) and it is the width of a figure, not of a stack of digits
  const policy = (await page.request.get("/")).headers()[
    "content-security-policy"
  ];
  expect(policy, "a política do app é a do _headers").toContain(
    "style-src 'self'"
  );
  expect(await page.evaluate(() => window.cspViolations)).toBe(0);
  const host = await page.evaluate(() => {
    const element = document.querySelector("[data-animated-figure]");
    const box = element?.getBoundingClientRect();
    return {
      closed: element !== null && element.shadowRoot === null,
      height: box?.height ?? 0,
      width: box?.width ?? 0,
    };
  });
  expect(host.closed, "a raiz do contador é fechada").toBe(true);
  expect(host.width, "os dígitos não ficam empilhados").toBeLessThan(400);
  expect(host.height, "uma linha de dígitos").toBeLessThan(120);

  // a screen reader gets the final text in every frame, with the counter running or not
  expectNoStepsAnnounced(shown);
  const first = shown[0] as Frame;
  for (const t of [100, 600]) {
    const frame = nearest(shown, first.t + t);
    expect(
      frame.figures.map((figure) => figure.accessible),
      `a leitura a ${t} ms`
    ).toEqual(shown.at(-1)?.figures.map((figure) => figure.accessible));
  }

  expect(
    shown.some((frame) => frame.figures.some((figure) => figure.counter)),
    "o contador está na árvore"
  ).toBe(true);
  expect(
    shown.every((frame) => frame.running === 0),
    "nada contou do zero na entrada"
  ).toBe(true);

  // the card has the same width and height in every frame, counting or not
  const last = shown.at(-1) as Frame;
  for (const frame of shown) {
    for (const figure of frame.figures) {
      const end = last.figures.find((other) => other.id === figure.id);
      expect(
        Math.abs(figure.card.width - (end?.card.width ?? 0)),
        `largura de ${figure.id}`
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(figure.card.height - (end?.card.height ?? 0)),
        `altura de ${figure.id}`
      ).toBeLessThanOrEqual(1);
    }
  }
});

test("início: os números fora da lista já estão prontos nos primeiros 300 ms (AC-8.7)", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "contador-fora", {
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  const frames = await openWith(page, "/", INICIO_OUTSIDE, async () => {
    await expect(
      page.getByRole("region", { name: "Mais vendidos do mês" })
    ).toContainText("Vela aromática");
  });
  const last = frames.at(-1) as Frame;
  for (const { name } of INICIO_OUTSIDE) {
    const final = last.outside[name] ?? "";
    expect(final, `${name} chegou`).toMatch(AN_AMOUNT_DIGIT);
    const appeared = frames.find((frame) => frame.outside[name] === final);
    expect(appeared, `${name} aparece`).toBeDefined();
    const from = (appeared as Frame).t;
    // from the first frame in which it is there until 300 ms later, it is the final text
    for (const frame of frames.filter(
      (other) => other.t >= from && other.t <= from + 300
    )) {
      expect(
        frame.outside[name],
        `${name} a ${Math.round(frame.t - from)} ms`
      ).toBe(final);
    }
    expect(
      frames.some((frame) => frame.outsideCounters[name]),
      `${name} sem contador`
    ).toBe(false);
    // and it never passes through a text that is not the final one, once it has digits
    for (const frame of frames.filter((other) => other.t >= from)) {
      expect(frame.outside[name]).toBe(final);
    }
  }
});

test("celular (< 760 px): o valor final no primeiro quadro, sem contador e sem baixar o pedaço dele (AC-8.2)", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "contador-toque", {
    device: {
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      viewport: { height: 740, width: 360 },
    },
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  const counterChunk = watchCounterChunk(page);
  const frames = await openWith(page, "/", INICIO_OUTSIDE, async () => {
    await expect(
      page.getByRole("region", { name: "Vendas hoje" })
    ).toContainText("R$ 90,00");
  });
  expectStill(fromFigures(frames));
  expect(counterChunk, "o celular não baixa o pedaço do contador").toEqual([]);
});

test("movimento reduzido: o valor final no primeiro quadro, sem contador e sem baixar o pedaço dele (AC-8.2)", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "contador-reduzido", {
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  await page.emulateMedia({ reducedMotion: "reduce" });
  const counterChunk = watchCounterChunk(page);
  const frames = await openWith(page, "/", INICIO_OUTSIDE, async () => {
    await expect(
      page.getByRole("region", { name: "Vendas hoje" })
    ).toContainText("R$ 90,00");
  });
  expectStill(fromFigures(frames));
  expect(counterChunk, "o movimento reduzido não baixa o pedaço").toEqual([]);
});

test("tablet com toque de 1024 px: usa o layout de computador e tem o contador (AC-8.2)", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "contador-tablet", {
    device: {
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      viewport: { height: 768, width: 1024 },
    },
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  const frames = await openWith(page, "/", INICIO_OUTSIDE, async () => {
    await expect(
      page.getByRole("region", { name: "Vendas hoje" })
    ).toContainText("R$ 90,00");
  });
  const shown = fromFigures(frames);
  expect(
    shown.some((frame) => frame.figures.some((figure) => figure.counter)),
    "o contador está na árvore no tablet"
  ).toBe(true);
});

const SIDES = ["left", "top", "width", "height"] as const;

/** What the figures that end with `kind` ("valor" or "chip") measure in the frames that already say their final text. */
function finalBoxes(
  frames: Frame[],
  kind: string,
  part: (figure: Figure) => Box | null
): Map<string, Box[]> {
  const final = finalAccessible(frames);
  const boxes = new Map<string, Box[]>();
  for (const frame of frames) {
    for (const figure of frame.figures) {
      const box = part(figure);
      if (
        box &&
        figure.id.endsWith(`/${kind}`) &&
        AN_AMOUNT_DIGIT.test(figure.accessible) &&
        figure.accessible === final.get(figure.id)
      ) {
        boxes.set(figure.id, [...(boxes.get(figure.id) ?? []), box]);
      }
    }
  }
  return boxes;
}

function expectStayedPut(boxes: Map<string, Box[]>, what: string) {
  expect(boxes.size, `há ${what}`).toBeGreaterThan(0);
  for (const [id, list] of boxes) {
    const end = list.at(-1) as Box;
    for (const [index, box] of list.entries()) {
      for (const side of SIDES) {
        expect(
          Math.abs(box[side] - end[side]),
          `${what} de ${id}: ${side} no quadro ${index} de ${list.length}`
        ).toBeLessThanOrEqual(1);
      }
    }
  }
}

// 900 px: the narrowest strip; 1280 px: the cards of the Resultado at the desktop of the e2e; 1600 px: wide enough for the
// chip to lay its comparison beside the figure (the card is 14 rem or more)
for (const width of [900, 1280, 1600]) {
  test(`resultado a ${width} px, com comparação: o valor e o chip, com o que vem ao lado dele, não se movem em nenhum quadro da contagem (≤ 1 px)`, async ({
    browser,
  }, testInfo) => {
    const journey = await openJourney(
      browser,
      testInfo,
      `contador-geometria-${width}`,
      {
        device: { viewport: { height: 800, width } },
        organization: { timezone: ZONE },
      }
    );
    await seedStore(journey, true);
    const { page } = journey;
    await page.goto("/dashboard");
    await expect(
      page.getByRole("region", { name: SALES_OF_MONTH })
    ).toContainText("R$ 90,00");
    await openPeriod(page);
    await page.evaluate(
      startSampler,
      sampler(RESULTADO_OUTSIDE, SWITCH_SAMPLE_MS)
    );
    await page
      .getByRole("group", { name: "Atalhos do período" })
      .getByRole("button", { exact: true, name: "Últimos 30 dias" })
      .click();
    await expect(page.locator("[data-kpi-delta]").first()).toContainText("%");
    const frames = await readFrames(page);
    expect(
      frames.some((frame) => frame.running > 0),
      "o contador animou"
    ).toBe(true);
    expectStayedPut(
      finalBoxes(frames, "valor", (figure) => figure.box),
      "o valor"
    );
    expectStayedPut(
      finalBoxes(frames, "chip", (figure) => figure.box),
      "o chip"
    );
    if (width >= 1600) {
      expectStayedPut(
        finalBoxes(frames, "chip", (figure) => figure.against),
        "o texto ao lado do chip"
      );
    }
  });
}

/**
 * A figure with digits is always painted: the static text is drawn (no transparency in it or above it up to the card) or
 * the counter is in the tree and has a box. The frame in which the counter takes over is checked like any other.
 */
function expectNeverInvisible(frames: Frame[]) {
  let staticFrames = 0;
  for (const frame of frames) {
    for (const figure of frame.figures) {
      if (!AN_AMOUNT_DIGIT.test(figure.accessible)) {
        continue;
      }
      if (!figure.counter) {
        staticFrames += 1;
      }
      expect(
        !figure.faded || (figure.counter && figure.counterBox.width > 0),
        `${figure.id} a ${Math.round(frame.t)} ms`
      ).toBe(true);
    }
  }
  expect(staticFrames, "o valor estático esteve na tela").toBeGreaterThan(0);
}

function expectFiguresStayedPut(frames: Frame[]) {
  expectStayedPut(
    finalBoxes(frames, "valor", (figure) => figure.box),
    "o valor"
  );
  const chips = finalBoxes(frames, "chip", (figure) => figure.box);
  if (chips.size > 0) {
    expectStayedPut(chips, "o chip");
  }
}

async function openResultado(
  page: Page,
  outside: Outside[] = RESULTADO_OUTSIDE
): Promise<Frame[]> {
  await page.addInitScript(startSampler, sampler(outside));
  await page.goto("/dashboard");
  await expect(
    page.getByRole("region", { name: SALES_OF_MONTH })
  ).toContainText("R$ 90,00");
  return await readFrames(page);
}

test("pedaço do contador bloqueado: o valor final está no primeiro quadro, sem contador, e a geometria não muda (≤ 1 px)", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "contador-bloqueado", {
    device: { viewport: { height: 800, width: 1280 } },
    organization: { timezone: ZONE },
  });
  await seedStore(journey, true);
  const { page } = journey;
  const attempts = watchCounterChunk(page);
  await page.route(COUNTER_CHUNK, (route) => route.abort("failed"));
  const frames = fromFigures(await openResultado(page));
  expect(attempts, "o desktop pediu o pedaço").not.toEqual([]);
  expectStill(frames);
  expectNeverInvisible(frames);
  expectNoStepsAnnounced(frames);
  expectFiguresStayedPut(frames);
});

test("pedaço do contador lento: o valor final está no primeiro quadro, o pedaço que chega depois não apaga nem conta o número, e a troca seguinte conta (≤ 1 px)", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "contador-lento", {
    device: { viewport: { height: 800, width: 1280 } },
    organization: { timezone: ZONE },
  });
  await seedStore(journey, true);
  const { page } = journey;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(COUNTER_CHUNK, async (route) => {
    await held;
    await route.continue();
  });
  await page.addInitScript(
    startSampler,
    sampler(RESULTADO_OUTSIDE, SWITCH_SAMPLE_MS)
  );
  await page.goto("/dashboard");
  await expect(
    page.getByRole("region", { name: SALES_OF_MONTH })
  ).toContainText("R$ 90,00");
  await expect(page.locator("[data-kpi-value]").first()).toBeVisible();
  await expect(page.locator("[data-animated-figure]")).toHaveCount(0);
  release();
  await expect(page.locator("[data-animated-figure]").first()).toBeAttached();
  const arrival = await readFrames(page);
  const frames = fromFigures(arrival);
  expect(
    frames.some((frame) => frame.figures.some((figure) => figure.counter)),
    "o contador entrou depois"
  ).toBe(true);
  expect(
    frames.every((frame) => frame.running === 0),
    "o número que já estava na tela não contou"
  ).toBe(true);
  expectNeverInvisible(frames);
  expectNoStepsAnnounced(frames);
  expectFiguresStayedPut(frames);

  await openPeriod(page);
  await page.evaluate(
    startSampler,
    sampler(RESULTADO_OUTSIDE, SWITCH_SAMPLE_MS)
  );
  await page
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: "Últimos 30 dias" })
    .click();
  await expect(page.locator("[data-kpi-delta]").first()).toContainText("%");
  const next = await readFrames(page);
  expect(
    next.some((frame) => frame.running > 0),
    "a troca seguinte contou"
  ).toBe(true);
  expectFiguresStayedPut(next);
});

/** Every frame has the final text in the whole tree (no digit of a step), and no counter was ever drawn. */
function expectStill(frames: Frame[]) {
  const last = frames.at(-1) as Frame;
  for (const frame of frames) {
    expect(frame.running).toBe(0);
    for (const figure of frame.figures) {
      expect(figure.counter, `${figure.id} sem contador`).toBe(false);
      const end = last.figures.find((other) => other.id === figure.id);
      expect(figure.tree, `${figure.id} a ${Math.round(frame.t)} ms`).toBe(
        end?.tree
      );
    }
  }
}

test("resultado: ao trocar de período o contador sai do valor anterior para o novo, sem passos para o leitor de tela, e os números fora da lista não contam (AC-8.3, AC-8.7)", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "contador-periodo", {
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  await page.goto("/dashboard");
  const sales = page.getByRole("region", { name: SALES_OF_MONTH });
  await expect(sales).toContainText("R$ 90,00");
  await openPeriod(page);
  await page.evaluate(
    startSampler,
    sampler(RESULTADO_OUTSIDE, SWITCH_SAMPLE_MS)
  );
  await page
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: "Mês passado" })
    .click();
  await expect(
    page.getByRole("region", { name: SALES_OF_PERIOD }).first()
  ).toContainText("R$ 45,00");
  const frames = await readFrames(page);
  const changed = frames.findIndex((frame) =>
    frame.figures.some((figure) => figure.accessible === "R$ 45,00")
  );
  expect(changed, "o período novo chegou").toBeGreaterThanOrEqual(0);
  const after = frames.slice(changed);
  // the value goes to its final text in one frame: no frame between R$ 90,00 and R$ 45,00 says another amount
  const amounts = new Set(
    frames.flatMap((frame) =>
      frame.figures
        .filter((figure) => figure.id === "result-kpi-sales/valor")
        .map((figure) => figure.accessible)
    )
  );
  expect([...amounts].filter((text) => text.startsWith("R$")).sort()).toEqual(
    ["R$ 45,00", "R$ 90,00"].sort()
  );
  expect(
    after.some((frame) => frame.running > 0),
    "o contador animou na troca"
  ).toBe(true);
  expect(
    frames.some((frame) => frame.outsideCounters.cadeia),
    "a cadeia sem contador"
  ).toBe(false);
  const chain = after.map((frame) => frame.outside.cadeia);
  expect(
    new Set(chain.slice(1)).size,
    "a cadeia aparece pronta"
  ).toBeLessThanOrEqual(1);
});

test("valores escondidos: nenhum dígito de valor passa pelo DOM na troca de período, nem o contador existe (AC-8.5)", async ({
  browser,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "contador-escondido", {
    organization: { timezone: ZONE },
  });
  await seedStore(journey);
  const { page } = journey;
  await page.addInitScript(() => {
    window.localStorage.setItem("polaris-valores", "escondidos");
  });
  await page.goto("/dashboard");
  await expect(
    page.getByRole("button", { name: "Esconder valores" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-kpi-value]").first()).toContainText("R$");
  await openPeriod(page);
  await page.evaluate(startSampler, sampler([], SWITCH_SAMPLE_MS));
  await page
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { exact: true, name: "Mês passado" })
    .click();
  const frames = await readFrames(page);
  let moneyFrames = 0;
  for (const frame of frames) {
    for (const figure of frame.figures.filter((item) =>
      item.id.endsWith("/valor")
    )) {
      // the margin is a percent and is never hidden: only the amounts are scanned
      if (figure.id.startsWith("result-kpi-margin")) {
        continue;
      }
      moneyFrames += 1;
      expect(
        figure.tree,
        `${figure.id} a ${Math.round(frame.t)} ms`
      ).not.toMatch(AN_AMOUNT_DIGIT);
      expect(figure.counter).toBe(false);
    }
  }
  expect(moneyFrames, "os quadros mostraram valores").toBeGreaterThan(0);
  // the amounts come back finished when they are shown again, with no counting
  await page.getByRole("button", { name: "Esconder valores" }).click();
  await expect(
    page.getByRole("region", { name: SALES_OF_PERIOD }).first()
  ).toContainText("R$ 45,00");
  await expect(page.locator("[data-animated-figure]").first()).toBeAttached();
  await expect(page.locator("[data-figure-counting]")).toHaveCount(0);
});
