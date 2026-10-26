/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { watchCspViolations } from "../e2e/csp-fixture";
import { expectMotionLevel } from "./motion-expect";
import { axeViolations } from "./ui-guardrails";

/**
 * The charts and the Tabs of src/ui/ in the gallery (ADR 0103, amendment "Gráficos", t285): the charts open from
 * their own chunk and not before, are an image with a name and a keyboard control, draw in the width of their box,
 * take their colors from the tokens, fade in and stop when the page asks for no motion; the chunk that fails leaves
 * the text; the Tabs have the height, the touch area and the focus of the other controls. Each measure is the one
 * the browser makes, in both themes, and axe finds nothing with the charts on the page.
 */
const THEMES = [
  { colorScheme: "light", name: "claro", stored: "claro" },
  { colorScheme: "light", name: "escuro", stored: "escuro" },
] as const;

const CHARTS_CHUNK = "**/assets/charts-*.js";
const WEEK_LABEL =
  /^Vendas líquidas por dia, de 17\/10 a 23\/10, dados de exemplo$/;
const WITHOUT_DATA = /sem dados$/;
const TWO_SERIES = /^Vendas e custos por dia/;
const LOADING = /carregando$/;
const RANGE_OF_THE_WEEK = "Dia, série de 7 dias";

async function openGallery(page: Page, stored: string | null = null) {
  if (stored) {
    await page.addInitScript((theme) => {
      window.localStorage.setItem("polaris-tema", theme);
    }, stored);
  }
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("heading", { name: "Galeria da interface" })
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function openGalleryWithCharts(page: Page, stored: string | null = null) {
  await openGallery(page, stored);
  const areas = page.getByRole("region", { name: "Gráficos de área" });
  await expect(areas.getByRole("img")).toHaveCount(8);
  await expect(
    page.getByRole("region", { name: "Miniaturas" }).locator("svg")
  ).toHaveCount(5);
  return areas;
}

/** The box of a control grown by its touch pseudo-element, in pixels (as in ui-components.e2e.ts). */
const touchArea = (element: Element) => {
  const box = element.getBoundingClientRect();
  const sizes = (["::before", "::after"] as const).map((pseudo) => {
    const style = getComputedStyle(element, pseudo);
    if (style.content === "none" || style.position !== "absolute") {
      return { height: 0, width: 0 };
    }
    const px = (value: string) => Number.parseFloat(value) || 0;
    return {
      height: box.height - px(style.top) - px(style.bottom),
      width: box.width - px(style.left) - px(style.right),
    };
  });
  return {
    height: Math.max(box.height, ...sizes.map((size) => size.height)),
    width: Math.max(box.width, ...sizes.map((size) => size.width)),
  };
};

/**
 * The date the pill of the tooltip shows. The block's pill is a reel with every date in it and a window that shows
 * one (`overflow-hidden`): the visible one is the item whose center is inside the box of the pill.
 */
const visiblePillDate = (image: Element) => {
  const window = image.querySelector(
    ".rounded-full.bg-foreground .overflow-hidden .overflow-hidden"
  );
  if (!window) {
    return "";
  }
  const box = window.getBoundingClientRect();
  return [...window.querySelectorAll("[data-ticker-item]")]
    .filter((item) => {
      const rect = item.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      return (
        (item.textContent ?? "").length === 5 &&
        centerY >= box.top &&
        centerY <= box.bottom
      );
    })
    .map((item) => item.textContent)
    .join("");
};

/** A token as the browser resolves it for a stroke or a fill. */
const resolveToken = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);

test("os gráficos têm nome, resumo e um controle de teclado que lê a data e o valor", async ({
  page,
}) => {
  const areas = await openGalleryWithCharts(page);

  // the image is named by its summary
  const week = areas.getByRole("img", { name: WEEK_LABEL });
  await expect(week).toBeVisible();

  // the day in focus is the last one, read in a line of text above the drawing (not live: the slider speaks it)
  const reading = areas.locator("p[data-chart-reading]").first();
  await expect(reading).toHaveText("23/10 R$ 520,00");

  // the range input walks through the points and speaks them
  const slider = areas.getByRole("slider", { name: RANGE_OF_THE_WEEK });
  await expect(slider).toHaveAttribute("aria-valuetext", "23/10: R$ 520,00");
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "22/10: R$ 0,00");
  await expect(reading).toHaveText("22/10 R$ 0,00");
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", "17/10: R$ 420,50");
  await page.keyboard.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "23/10: R$ 520,00");

  // the keyboard focus is drawn around the chart: the 3 px outline of the other controls
  await page.keyboard.press("ArrowLeft");
  const outline = await slider.evaluate((input) => {
    const style = getComputedStyle(input);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline).toEqual({ style: "solid", width: "3px" });

  // the series without data, with one point and all zero are named and have no keyboard control, or only one stop
  await expect(areas.getByRole("img", { name: WITHOUT_DATA })).toBeVisible();
  await expect(areas.getByRole("slider", { name: "Dia, vazio" })).toHaveCount(
    0
  );
  await expect(
    areas.getByRole("slider", { name: "Dia, um ponto" })
  ).toHaveAttribute("max", "0");
});

test("o teclado move o ponto em foco do gráfico: o tooltip do bloco mostra a data e o valor em pt-BR", async ({
  page,
}) => {
  const areas = await openGalleryWithCharts(page);
  const week = areas.getByRole("img", { name: WEEK_LABEL });
  const slider = areas.getByRole("slider", { name: RANGE_OF_THE_WEEK });
  const rows = week.locator("[data-chart-tooltip-row]");
  const pill = week.locator(".rounded-full.bg-foreground");
  const date = () => week.evaluate(visiblePillDate);
  // focused right away, before the reveal ends: the tooltip comes as soon as the chart can show it
  // no focus, no tooltip: the pointer and the arrows are what open it
  await expect(rows).toHaveCount(0);
  await slider.focus();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Vendas");
  await expect(rows.first()).toContainText("R$ 520,00");
  await expect(pill).toBeVisible();
  await expect.poll(date).toBe("23/10");
  await page.keyboard.press("ArrowLeft");
  await expect(rows.first()).toContainText("R$ 0,00");
  await expect.poll(date).toBe("22/10");
  await page.keyboard.press("Home");
  await expect(rows.first()).toContainText("R$ 420,50");
  await expect.poll(date).toBe("17/10");
  // leaving the control takes the tooltip away and the line of reading goes back to the last day
  await slider.blur();
  await expect(rows).toHaveCount(0);
  await expect(areas.locator("p[data-chart-reading]").first()).toHaveText(
    "23/10 R$ 520,00"
  );
});

const WEEK_VALUES: Record<string, string> = {
  "17/10": "R$ 420,50",
  "18/10": "R$ 1.180,00",
  "19/10": "R$ 90,00",
  "20/10": "R$ 1.840,90",
  "21/10": "R$ 760,00",
  "22/10": "R$ 0,00",
  "23/10": "R$ 520,00",
};

test("o ponteiro abre o tooltip no primeiro, no do meio e no último ponto, com o valor em pt-BR", async ({
  isMobile,
  page,
}) => {
  test.skip(
    isMobile,
    "a mouse moves over the drawing; with touch it is a hold"
  );
  const areas = await openGalleryWithCharts(page);
  const week = areas.getByRole("img", { name: WEEK_LABEL });
  await week.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  const box = await week.boundingBox();
  expect(box).not.toBeNull();
  if (!box) {
    return;
  }
  const rows = week.locator("[data-chart-tooltip-row]");
  const pill = week.locator(".rounded-full.bg-foreground");
  const y = box.y + box.height / 2;
  // the first point is at the left of the plot (past the labels of the y axis), the last at its right
  const stops = [
    { date: "17/10", x: box.x + 82 },
    { date: null, x: box.x + box.width / 2 },
    { date: "23/10", x: box.x + box.width - 24 },
  ];
  for (const stop of stops) {
    // biome-ignore lint/performance/noAwaitInLoops: one stop after the other, on the same chart
    await page.mouse.move(stop.x, y);
    await expect(rows).toHaveCount(1);
    await expect(pill).toBeVisible();
    // the pill rolls to its date and the panel follows the pointer: let both arrive
    await page.waitForTimeout(900);
    const date = await week.evaluate(visiblePillDate);
    if (stop.date) {
      expect(date).toBe(stop.date);
    }
    // the value in the panel is the value of the day in the pill, formatted in pt-BR
    await expect(rows.first()).toContainText(WEEK_VALUES[date] ?? "?");
  }
  // the pointer leaving takes it away
  await page.mouse.move(box.x + box.width / 2, box.y - 80);
  await expect(rows).toHaveCount(0);
});

test("no toque, o tooltip aparece enquanto o dedo está no gráfico e some ao soltar; a linha de leitura fica", async ({
  isMobile,
  page,
}) => {
  test.skip(!isMobile, "a hold of the finger is a touch device's gesture");
  const areas = await openGalleryWithCharts(page);
  const week = areas.getByRole("img", { name: WEEK_LABEL });
  await week.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  const box = await week.boundingBox();
  expect(box).not.toBeNull();
  if (!box) {
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchEnd" | "touchStart", x: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      touchPoints:
        type === "touchEnd" ? [] : [{ x, y: box.y + box.height / 2 }],
      type,
    });
  const rows = week.locator("[data-chart-tooltip-row]");
  await touch("touchStart", box.x + box.width / 2);
  await expect(rows).toHaveCount(1);
  await touch("touchEnd", 0);
  await expect(rows).toHaveCount(0);
  await expect(areas.locator("p[data-chart-reading]").first()).toHaveText(
    "23/10 R$ 520,00"
  );
});

test("o painel do tooltip fica na margem de cima e não cobre o eixo das datas, no primeiro e no último ponto", async ({
  isMobile,
  page,
}) => {
  const areas = await openGalleryWithCharts(page);
  const week = areas.getByRole("img", { name: WEEK_LABEL });
  await week.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  const box = await week.boundingBox();
  expect(box).not.toBeNull();
  if (!box) {
    return;
  }
  const row = week.locator("[data-chart-tooltip-row]").first();
  const y = box.y + box.height / 2;
  // a mouse moves over the chart; a phone holds a finger on it
  const cdp = isMobile ? await page.context().newCDPSession(page) : null;
  for (const x of [box.x + 82, box.x + box.width - 24]) {
    // biome-ignore lint/performance/noAwaitInLoops: one end after the other, on the same chart
    await (cdp
      ? cdp.send("Input.dispatchTouchEvent", {
          touchPoints: [{ x, y }],
          type: "touchStart",
        })
      : page.mouse.move(x, y));
    await expect(row).toBeVisible();
    // the spring of the panel needs its time before it is where it stays
    await page.waitForTimeout(1200);
    const panel = await row.evaluate((element) => {
      const rect = (
        element.closest(".rounded-xl") as Element
      ).getBoundingClientRect();
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      };
    });
    // inside the box of the chart, in the 40 px of the top margin and under the line of the axis
    expect(panel.left).toBeGreaterThanOrEqual(box.x - 1);
    expect(panel.right).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(panel.top).toBeGreaterThanOrEqual(box.y - 1);
    expect(panel.bottom).toBeLessThan(box.y + box.height - 40);
    // one pill of date and one line for each series: at most 150 px wide (it fits twice in the card of a phone)
    expect(panel.right - panel.left).toBeLessThanOrEqual(150);
    if (cdp) {
      await cdp.send("Input.dispatchTouchEvent", {
        touchPoints: [],
        type: "touchEnd",
      });
    }
  }
});

test("o desenho usa a largura da caixa, sem encolher o texto dos eixos", async ({
  isMobile,
  page,
}) => {
  const areas = await openGalleryWithCharts(page);
  const week = areas.getByRole("img", { name: WEEK_LABEL });
  const measures = await week.evaluate((image) => {
    const svg = image.querySelector("svg") as SVGSVGElement;
    const box = image.getBoundingClientRect();
    const sizes = [...image.querySelectorAll("span")]
      .filter((span) => span.textContent?.trim())
      .map((span) => Number.parseFloat(getComputedStyle(span).fontSize));
    return {
      boxWidth: Math.round(box.width),
      sizes: [...new Set(sizes)].sort(),
      svgWidth: Math.round(svg.getBoundingClientRect().width),
      viewBox: svg.getAttribute("viewBox"),
    };
  });
  // drawn in its own width: no viewBox of a larger drawing shrunk into the box
  expect(measures.viewBox).toBeNull();
  expect(measures.svgWidth).toBe(measures.boxWidth);
  // the labels of both axes are 12 px
  expect(measures.sizes).toEqual([12]);
  // a week has three or four dates on a phone and five to seven on a wide chart, none touching the next
  const dates = await week.evaluate((image) =>
    [...image.querySelectorAll("span")]
      .filter(
        (span) =>
          (span.textContent ?? "").split("/").length === 2 &&
          (span.textContent ?? "").length === 5
      )
      .map((span) => {
        const rect = span.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      })
      .sort((first, second) => first.left - second.left)
  );
  if (isMobile) {
    expect(dates).toHaveLength(4);
  } else {
    expect(dates.length).toBeGreaterThanOrEqual(5);
    expect(dates.length).toBeLessThanOrEqual(7);
  }
  for (const [index, date] of dates.entries()) {
    const next = dates[index + 1];
    if (next) {
      expect(next.left - date.right).toBeGreaterThanOrEqual(6);
    }
  }
});

test("o gráfico de duas séries: a segunda tracejada, a legenda e a leitura dos dois valores", async ({
  page,
}) => {
  const areas = await openGalleryWithCharts(page);
  const two = page.getByRole("img", { name: TWO_SERIES });
  const section = areas.locator("[data-chart]").filter({ has: two });
  await expect(section.locator("[data-chart-legend]")).toContainText(
    "Custos (CMV, taxas e despesas)"
  );
  await expect(section.locator("p[data-chart-reading]")).toHaveText(
    "23/10 · Vendas R$ 520,00 · Custos R$ 312,00"
  );
  // the second line of the drawing is dashed
  const dashed = await two.evaluate(
    (image) =>
      [...image.querySelectorAll("path")].filter(
        (path) =>
          path.getAttribute("fill") === "none" &&
          (path.getAttribute("stroke-dasharray") ?? "") !== ""
      ).length
  );
  expect(dashed).toBeGreaterThan(0);
});

test("carregando: o estado do bloco mostra o texto que cintila e nenhum controle; pronto, o gráfico se revela", async ({
  page,
}) => {
  const areas = await openGalleryWithCharts(page);
  const loading = page.getByRole("img", { name: LOADING });
  const section = areas.locator("[data-chart]").filter({ has: loading });
  // the text shimmers letter by letter: the words are read from the whole
  await expect(section).toContainText("Carregando");
  await expect(section.getByRole("slider")).toHaveCount(0);
  await expect(section.locator("p[data-chart-reading]")).toHaveCount(0);
});

test("a miniatura sai da leitura: escondida, sem texto e sem controle", async ({
  page,
}) => {
  await openGalleryWithCharts(page);
  const sparks = page.getByRole("region", { name: "Miniaturas" });
  await expect(sparks.getByRole("img")).toHaveCount(0);
  await expect(sparks.getByRole("slider")).toHaveCount(0);
  const hidden = await sparks.locator("svg").evaluateAll((svgs) =>
    svgs.map((svg) => ({
      hidden: svg.closest("[aria-hidden=true]") !== null,
      texts: svg.querySelectorAll("text").length,
    }))
  );
  expect(hidden).toHaveLength(5);
  expect(hidden.every((item) => item.hidden && item.texts === 0)).toBe(true);
});

for (const theme of THEMES) {
  test(`tema ${theme.name}: as cores vêm dos tokens: a tinta na série e no anel do melhor dia, nunca o esmeralda (v7)`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      colorScheme: theme.colorScheme,
    });
    const page = await context.newPage();
    const areas = await openGalleryWithCharts(page, theme.stored);
    const ink = await resolveToken(page, "--chart-5");
    const emerald = await resolveToken(page, "--chart-1");
    const week = areas.getByRole("img", { name: WEEK_LABEL });
    // the ring of the best day and the line come in with the reveal
    await expect(week.locator("circle")).toHaveCount(1);
    const colors = await week.evaluate((image) => {
      const read = (element: Element, property: "fill" | "stroke") =>
        getComputedStyle(element)[property];
      const strokes = [...image.querySelectorAll("path")].map((path) =>
        read(path, "stroke")
      );
      return {
        best: [...image.querySelectorAll("circle")].map((dot) =>
          read(dot, "fill")
        ),
        strokes,
      };
    });
    // the line of the series is the ink; the grid and the tooltip are the border and the card, never the emerald
    expect(colors.strokes).toContain(ink);
    expect(colors.strokes).not.toContain(emerald);
    // since v7 the best day is marked by its shape (a larger ring in the color of the series), not by the emerald
    expect(colors.best).toContain(ink);
    expect(colors.best).not.toContain(emerald);
    // the ink and the emerald are never the same color, in either theme
    expect(ink).not.toBe(emerald);
    // a sparkline is the ink too
    const spark = page
      .getByRole("region", { name: "Miniaturas" })
      .locator("svg")
      .first();
    // the dot of the last value comes in with the entrance of the miniature
    await expect(spark.locator("circle")).toHaveCount(1);
    expect(
      await spark.evaluate(
        (svg) => getComputedStyle(svg.querySelector("circle") as Element).fill
      )
    ).toBe(ink);
    await context.close();
  });

  test(`tema ${theme.name}: axe não acha violação com os gráficos e as abas na página`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      colorScheme: theme.colorScheme,
    });
    const page = await context.newPage();
    const csp = await watchCspViolations(page);
    await openGalleryWithCharts(page, theme.stored);
    expect(await axeViolations(page)).toEqual([]);
    // the charts and their gradients need no inline style element: the CSP watch stays empty
    expect(csp.violations()).toEqual([]);
    await context.close();
  });
}

test("o gráfico entra com a animação do bloco no nível full e para quando a página pede sem movimento", async ({
  page,
}) => {
  // without a preference, at the full level, the block reveals the series behind a moving clip: the group that holds
  // the clip is there; on a phone (the Pixel 5 project, `essential`) the chart is drawn finished (motion-level.e2e.ts)
  const areas = await openGalleryWithCharts(page);
  const week = areas.getByRole("img", { name: WEEK_LABEL });
  const full = (await expectMotionLevel(page)) === "full";
  await expect(week.locator("svg g[clip-path]")).toHaveCount(full ? 1 : 0);

  // with `reduce` the chart appears finished: no reveal, the y axis does not tween, the tooltip jumps
  const quiet = await page.context().browser()?.newContext({
    reducedMotion: "reduce",
  });
  expect(quiet).toBeDefined();
  if (!quiet) {
    return;
  }
  const still = await quiet.newPage();
  await openGalleryWithCharts(still);
  const stillWeek = still
    .getByRole("region", { name: "Gráficos de área" })
    .getByRole("img", { name: WEEK_LABEL });
  await expect(stillWeek.locator("svg g[clip-path]")).toHaveCount(0);
  await expect(stillWeek.locator("svg path[stroke]").first()).toBeVisible();
  // the tooltip is there at once and stays where it was put: no spring from another place
  const slider = still
    .getByRole("region", { name: "Gráficos de área" })
    .getByRole("slider", { name: RANGE_OF_THE_WEEK });
  await slider.focus();
  const row = stillWeek.locator("[data-chart-tooltip-row]").first();
  await expect(row).toContainText("R$ 520,00");
  const position = () =>
    row.evaluate((element) => {
      const rect = (
        element.closest(".rounded-xl") as Element
      ).getBoundingClientRect();
      return { left: Math.round(rect.left), top: Math.round(rect.top) };
    });
  await still.keyboard.press("Home");
  await expect(row).toContainText("R$ 420,50");
  const first = await position();
  await still.waitForTimeout(150);
  expect(await position()).toEqual(first);
  // and the miniatures draw with no entrance
  await quiet.close();
});

test("o pedaço dos gráficos só é pedido por quem tem um gráfico", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/assets/charts-")) {
      requested.push(request.url());
    }
  });
  // a page of the build with no chart never asks for it
  await page.goto("/ui-pecas-do-shell");
  await page.waitForLoadState("networkidle");
  expect(requested).toEqual([]);
  // the gallery has charts and asks once
  await openGalleryWithCharts(page);
  expect(requested).toHaveLength(1);
});

test("sem o pedaço, o gráfico some e deixa o texto de quem o usa", async ({
  page,
}) => {
  await page.route(CHARTS_CHUNK, (route) => route.abort());
  await openGallery(page);
  const areas = page.getByRole("region", { name: "Gráficos de área" });
  await expect(areas.getByText("O gráfico não abriu.")).toHaveCount(8);
  await expect(areas.locator("[data-chart-area]")).toHaveCount(0);
  await expect(areas.getByRole("slider")).toHaveCount(0);
  // the miniatures go without a word, and the rest of the page is still there
  await expect(
    page.getByRole("region", { name: "Miniaturas" }).locator("svg")
  ).toHaveCount(0);
  await expect(page.locator("[data-chart-loading]")).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Período" })).toBeVisible();
});

test("enquanto o pedaço vem, uma caixa da altura do gráfico guarda o lugar", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(CHARTS_CHUNK, async (route) => {
    await held;
    await route.continue();
  });
  await openGallery(page);
  const boxes = page.locator("[data-chart-loading]");
  await expect(boxes).toHaveCount(15);
  const heights = await boxes.evaluateAll((items) =>
    items.map((item) => Math.round(item.getBoundingClientRect().height))
  );
  // the eight area charts: the plot, the margins of the blocks (40 px) and the line of reading above it (26 px), and
  // 44 px more for the legend of two series; the six miniatures: 32 px; the sparkline of the KPI card: 64 px
  expect(heights.filter((height) => height === 32)).toHaveLength(6);
  expect(heights.filter((height) => height === 64)).toHaveLength(1);
  expect(
    heights.filter((height) => [246, 286, 330].includes(height))
  ).toHaveLength(8);
  // the box of an area chart has its floor, faint, where the drawing will put it; a miniature has none
  await expect(page.locator("[data-chart-floor]")).toHaveCount(8);
  release();
  await expect(boxes).toHaveCount(0);
});

test("as abas: papel, teclado, altura da lista, área de toque e foco de 3 px", async ({
  isMobile,
  page,
}) => {
  await openGallery(page);
  const section = page.getByRole("region", { name: "Abas" });
  const list = section.getByRole("tablist", { name: "Período" });
  const sevenDays = section.getByRole("tab", { name: "7 dias" });
  const thirtyDays = section.getByRole("tab", { name: "30 dias" });
  await expect(sevenDays).toHaveAttribute("aria-selected", "true");
  await expect(section.getByRole("tabpanel")).toHaveText(
    "Os últimos 7 dias, dados de exemplo."
  );

  // the height of the list is the control height of the base: 32 px with a mouse, 36 px with touch
  const height = await list.evaluate(
    (element) => element.getBoundingClientRect().height
  );
  expect(height).toBe(isMobile ? 36 : 32);

  // with touch, each tab has a touch area of at least 48 px
  if (isMobile) {
    const areas = await Promise.all(
      [sevenDays, thirtyDays].map((tab) => tab.evaluate(touchArea))
    );
    for (const area of areas) {
      expect(area.height).toBeGreaterThanOrEqual(48);
      expect(area.width).toBeGreaterThanOrEqual(48);
    }
  }

  // the keyboard: the arrow moves the focus, and Enter chooses; the focus is the 3 px outline
  await sevenDays.focus();
  await page.keyboard.press("ArrowRight");
  await expect(thirtyDays).toBeFocused();
  expect(
    await thirtyDays.evaluate((tab) => {
      const style = getComputedStyle(tab);
      return {
        offset: style.outlineOffset,
        style: style.outlineStyle,
        width: style.outlineWidth,
      };
    })
  ).toEqual({ offset: "2px", style: "solid", width: "3px" });
  await page.keyboard.press("Enter");
  await expect(thirtyDays).toHaveAttribute("aria-selected", "true");
  await expect(section.getByRole("tabpanel")).toHaveText(
    "Os últimos 30 dias, dados de exemplo."
  );
  // the open panel is a stop of the keyboard and draws the same outline
  await page.keyboard.press("Tab");
  await expect(section.getByRole("tabpanel")).toBeFocused();
  expect(
    await section
      .getByRole("tabpanel")
      .evaluate((panel) => getComputedStyle(panel).outlineWidth)
  ).toBe("3px");
});
