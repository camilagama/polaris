import {
  type Browser,
  devices,
  type Locator,
  type Page,
} from "@playwright/test";
import { localDate } from "../calendar";
import {
  expect,
  type Journey,
  type JourneyDevice,
  openJourney,
  runT0,
  test,
} from "../fixtures";
import { journeyClientIp } from "../journey-names";
import { seedCashSale, seedProduct, seedStock } from "../seed";
import {
  type ClsScenario,
  clsProblem,
  sessionWindowCls,
} from "./layout-shift.list";

/**
 * Layout shift of the phone (360 × 800, touch) on the real stack: the four destinations of the bottom bar and the
 * Resultado, loaded in a new context (`frio`) and reached from inside the app (`quente`), the Início of an empty store,
 * the Início losing and getting back the network, and the sign-in page. Each measurement is the Cumulative Layout Shift
 * of Web Vitals (the largest burst of shifts, 1 s apart at most and 5 s long at most) from a `PerformanceObserver` of
 * `layout-shift` that the page has before any script of its own; every shift counts, with or without a recent input,
 * since the test makes none. The limit and the exact list of screens still over it are in `layout-shift.list.ts`.
 *
 * "Settled" is a signal and never a time: the final content of the screen visible, no "Carregando…", no
 * `aria-busy`, the fonts loaded, and two animation frames in a row with no change in the DOM and no new shift.
 *
 * Risk: the local stack answers in a few milliseconds, so this sees the shifts of the shell and of the skeletons, which
 * do not depend on the network, but may miss one that only happens when an answer arrives late (a slow 4G network,
 * the public catalog on a slow network); those stay with the manual measurement. The project runs with no retry: a
 * flaky measurement shows at once instead of passing on the second attempt.
 */

const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];
const PHONE: JourneyDevice = {
  ...pixel7,
  viewport: { height: 800, width: 360 },
};
const ZONE = "America/Sao_Paulo";
const SETTLE_MS = 20_000;
const LOADING = /Carregando|Preparando|Sincronizando|Verificando/;
const CLIENT_IP_HEADER = "cf-connecting-ip";

interface Rect {
  h: number;
  w: number;
  x: number;
  y: number;
}

interface Shift {
  sources: {
    cur: Rect | null;
    prev: Rect | null;
    selector: string;
    text: string;
  }[];
  t: number;
  value: number;
}

interface Recorder {
  /** A random number per document: a mark of another document means the page reloaded in between. */
  document: number;
  entries: Shift[];
  /** Hands the shifts the observer still holds to `entries` (its callback runs later). */
  flush: () => void;
  /** How many documents this tab has loaded (`sessionStorage`): a first load is 1. */
  loads: number;
  mutations: number;
  supported: boolean;
}

/** Where a measurement starts: the document and how many shifts it had recorded. */
interface Mark {
  count: number;
  document: number;
}

/** Runs in the page before its own scripts (`addInitScript`): every layout shift with what moved, and a DOM counter. */
function recordLayoutShifts() {
  const target = window as unknown as { __layoutShift?: Recorder };
  if (target.__layoutShift) {
    return;
  }
  const state: Recorder = {
    document: Math.random(),
    entries: [],
    flush: () => undefined,
    loads: Number(sessionStorage.getItem("__layoutShiftLoads") ?? 0) + 1,
    mutations: 0,
    supported: PerformanceObserver.supportedEntryTypes.includes("layout-shift"),
  };
  target.__layoutShift = state;
  sessionStorage.setItem("__layoutShiftLoads", String(state.loads));
  const short = (text: string | null | undefined) => {
    const flat = (text ?? "").replace(/\s+/g, " ").trim();
    return flat.length > 70 ? `${flat.slice(0, 70)}…` : flat;
  };
  const describe = (element: Element) => {
    const chain: string[] = [];
    let current: Element | null = element;
    for (
      let depth = 0;
      current && depth < 4 && current !== document.body;
      depth += 1
    ) {
      let name = current.tagName.toLowerCase();
      for (const attribute of ["id", "role", "aria-label", "data-slot"]) {
        const value = current.getAttribute(attribute);
        if (value) {
          name +=
            attribute === "id"
              ? `#${value}`
              : `[${attribute}="${short(value)}"]`;
        }
      }
      chain.unshift(name);
      current = current.parentElement;
    }
    return chain.join(" > ");
  };
  const rect = (r: DOMRectReadOnly | undefined) =>
    r
      ? {
          h: Math.round(r.height),
          w: Math.round(r.width),
          x: Math.round(r.x),
          y: Math.round(r.y),
        }
      : null;
  const keep = (list: PerformanceEntryList) => {
    for (const entry of list as unknown as {
      sources?: {
        currentRect: DOMRectReadOnly;
        node?: Node;
        previousRect: DOMRectReadOnly;
      }[];
      startTime: number;
      value: number;
    }[]) {
      state.entries.push({
        sources: (entry.sources ?? []).map((source) => {
          const { node } = source;
          const element =
            node &&
            (node.nodeType === 1 ? (node as Element) : node.parentElement);
          return {
            cur: rect(source.currentRect),
            prev: rect(source.previousRect),
            selector: element ? describe(element) : "(nó removido)",
            text: short(element?.textContent),
          };
        }),
        t: Math.round(entry.startTime),
        value: entry.value,
      });
    }
  };
  const observer = new PerformanceObserver((list) => keep(list.getEntries()));
  observer.observe({ buffered: true, type: "layout-shift" });
  state.flush = () => keep(observer.takeRecords());
  const watch = () =>
    new MutationObserver((records) => {
      state.mutations += records.length;
    }).observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  if (document.documentElement) {
    watch();
  } else {
    document.addEventListener("readystatechange", watch, { once: true });
  }
}

/**
 * True when nothing on the page is loading and two frames went by with no DOM change and no new shift. Runs in the
 * page (`evaluate`), so the pattern of the loading texts comes as an argument.
 */
function quietPage(loading: string): Promise<boolean> {
  const state = (window as unknown as { __layoutShift: Recorder })
    .__layoutShift;
  const busy =
    document.querySelector('[aria-busy="true"]') !== null ||
    new RegExp(loading).test(document.body?.innerText ?? "");
  if (busy || document.fonts.status !== "loaded") {
    return Promise.resolve(false);
  }
  const { mutations } = state;
  const shifts = state.entries.length;
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        resolve(
          state.mutations === mutations && state.entries.length === shifts
        )
      )
    )
  );
}

async function settle(page: Page, ready: Locator[]) {
  await Promise.all(
    ready.map((locator) => expect(locator).toBeVisible({ timeout: SETTLE_MS }))
  );
  await expect
    .poll(() => page.evaluate(quietPage, LOADING.source), {
      message:
        "the screen settles: nothing loading and two frames with no change",
      timeout: SETTLE_MS,
    })
    .toBe(true);
}

/**
 * The shifts recorded since `mark` (a count, not a time: the journey's clock is Playwright's, the entries' is not).
 * Without a mark, every shift of the document, which must be a first load and not a reload. A document other than the
 * mark's means the page reloaded and the shifts before it are gone: that fails instead of measuring nothing.
 */
async function since(page: Page, mark?: Mark): Promise<Shift[]> {
  const read = await page.evaluate(() => {
    const state = (window as unknown as { __layoutShift: Recorder })
      .__layoutShift;
    state.flush();
    return {
      document: state.document,
      entries: state.entries,
      loads: state.loads,
      supported: state.supported,
    };
  });
  expect(read.supported, "the browser reports layout-shift entries").toBe(true);
  if (!mark) {
    expect(read.loads, "the page was loaded once, not reloaded").toBe(1);
    return read.entries;
  }
  expect(read.document, "the page did not reload during the measurement").toBe(
    mark.document
  );
  return read.entries.slice(mark.count);
}

const markOf = (page: Page): Promise<Mark> =>
  page.evaluate(() => {
    const state = (window as unknown as { __layoutShift: Recorder })
      .__layoutShift;
    state.flush();
    return { count: state.entries.length, document: state.document };
  });

function describeShifts(entries: Shift[]): string {
  return [...entries]
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((entry, index) => {
      const sources = entry.sources
        .map(({ cur, prev, selector, text }) => {
          const box = (r: Rect | null) =>
            r ? `${r.x},${r.y} ${r.w}×${r.h}` : "fora";
          return `    ${selector} "${text}" ${box(prev)} → ${box(cur)}`;
        })
        .join("\n");
      return `  #${index + 1} ${entry.value.toFixed(4)} aos ${entry.t} ms\n${sources}`;
    })
    .join("\n");
}

/** Keeps what is wrong with each measurement; every value goes to the log, wrong or not. */
class Measurements {
  readonly problems: string[] = [];

  record(scenario: ClsScenario, entries: Shift[]) {
    const cls = sessionWindowCls(entries);
    console.log(
      `CLS ${scenario}: ${cls.toFixed(4)} (${entries.length} deslocamentos)`
    );
    test.info().annotations.push({
      description: `${scenario}: ${cls.toFixed(4)}`,
      type: "cls",
    });
    const problem = clsProblem(scenario, cls);
    if (problem) {
      this.problems.push(`${problem}\n${describeShifts(entries)}`);
    }
  }
}

/**
 * A phone context of its own, with the journey's session or none; `address` names its rate limit bucket. Not in the
 * fixture's list: the caller closes it (`withPhonePage`).
 */
async function phonePage(
  browser: Browser,
  address: string,
  journey: Journey | null
): Promise<Page> {
  const origin = String(test.info().project.use.baseURL);
  const context = await browser.newContext({
    ...PHONE,
    baseURL: origin,
    extraHTTPHeaders: { [CLIENT_IP_HEADER]: journeyClientIp(address) },
    ...(journey
      ? { storageState: await journey.page.context().storageState() }
      : {}),
  });
  await context.addInitScript(recordLayoutShifts);
  const page = await context.newPage();
  await page.clock.install({ time: runT0() });
  return page;
}

async function withPhonePage<T>(
  browser: Browser,
  address: string,
  journey: Journey | null,
  use: (page: Page) => Promise<T>
): Promise<T> {
  const page = await phonePage(browser, address, journey);
  try {
    return await use(page);
  } finally {
    await page.context().close();
  }
}

const home = (page: Page) => [
  page.getByRole("heading", { level: 1, name: "Início" }),
  page.getByRole("region", { name: "Vendas hoje" }),
];

type Path = "/" | "/dashboard" | "/inventory" | "/sales" | "/sales/history";

/** What each screen shows when its data has arrived. */
const SCREENS: Record<Path, (page: Page) => Locator[]> = {
  "/": (page) => [
    ...home(page),
    page.getByRole("region", { name: "Vendas hoje" }).getByText("R$").first(),
  ],
  "/dashboard": (page) => [
    page.getByRole("heading", { level: 1, name: "Resultado" }),
    page.getByRole("region", { name: "Qualidade dos dados" }),
  ],
  "/inventory": (page) => [
    page.getByRole("heading", { level: 1, name: "Estoque" }),
    page.getByRole("list", { name: "Saldos por variante" }),
  ],
  "/sales": (page) => [
    page.getByRole("heading", { level: 1, name: "Nova venda" }),
    page.getByRole("group", { exact: true, name: "Item 1" }),
  ],
  "/sales/history": (page) => [
    page.getByRole("heading", { level: 1, name: "Histórico de vendas" }),
    page.getByRole("list", { name: "Vendas" }),
  ],
};
const DESTINATIONS: Path[] = [
  "/sales",
  "/sales/history",
  "/inventory",
  "/dashboard",
];

/** A load of the page in a context of its own: no cache, no service worker, as the first visit of the day. */
function cold(browser: Browser, journey: Journey, path: Path) {
  return withPhonePage(browser, journey.name, journey, async (page) => {
    await page.goto(path);
    await settle(page, SCREENS[path](page));
    return since(page);
  });
}

/** The step of the menu (`navigateInApp`) from a settled screen, without a click: no input to discount. */
async function warm(page: Page, path: Path) {
  const mark = await markOf(page);
  await page.evaluate((next) => {
    window.history.pushState(null, "", next);
    window.dispatchEvent(new Event("polaris:address"));
    window.scrollTo({ top: 0 });
  }, path);
  await settle(page, SCREENS[path](page));
  return since(page, mark);
}

async function seedSales(journey: Journey) {
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;
  const today = localDate(runT0(), ZONE);
  const products = [
    { name: "Camiseta básica", price: "59.90" },
    { name: "Caneca esmaltada", price: "35.00" },
    { name: "Vela aromática", price: "45.00" },
  ];
  const variants = await Promise.all(
    products.map(async ({ name, price }) => {
      const { variantId } = await seedProduct(rpc, organizationId, name, price);
      await seedStock(rpc, organizationId, variantId, 20, "12.00", today);
      return { price, quantity: 1, variantId };
    })
  );
  await seedCashSale(
    rpc,
    organizationId,
    variants.slice(0, 2),
    new Date(runT0()).toISOString()
  );
}

test.describe.configure({ retries: 0 });

test("layout shift no celular: Início da loja vazia e a entrada", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const measurements = new Measurements();
  const journey = await openJourney(browser, testInfo, "layout-shift-vazia", {
    device: PHONE,
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  await page.context().addInitScript(recordLayoutShifts);
  await page.goto("/");
  await settle(page, [
    page.getByRole("heading", { level: 1, name: "Início" }),
    page.getByRole("region", { name: "Primeiros passos" }),
    page
      .getByRole("region", { name: "Meta" })
      .getByRole("link", { name: "Definir meta" }),
  ]);
  measurements.record("/ vazia frio", await since(page));

  const signIn = await withPhonePage(
    browser,
    `${journey.name}-entrar`,
    null,
    async (entry) => {
      await entry.goto("/entrar");
      await settle(entry, [
        entry.getByRole("heading", { level: 1, name: "Entrar no Polaris" }),
      ]);
      return since(entry);
    }
  );
  measurements.record("/entrar sem-sessao frio", signIn);

  expect(measurements.problems.join("\n\n")).toBe("");
});

test("layout shift no celular: os destinos da barra e o Resultado, numa loja com vendas", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const measurements = new Measurements();
  const journey = await openJourney(browser, testInfo, "layout-shift-vendas", {
    device: PHONE,
    organization: { timezone: ZONE },
  });
  await seedSales(journey);
  const { page } = journey;
  await page.context().addInitScript(recordLayoutShifts);
  await page.goto("/");
  await settle(page, SCREENS["/"](page));
  measurements.record("/ com-vendas frio", await since(page));

  // one after the other: one preview and one database, and a measurement must not share the CPU with another
  for (const path of DESTINATIONS) {
    // biome-ignore lint/performance/noAwaitInLoops: one measurement at a time (above)
    const entries = await cold(browser, journey, path);
    measurements.record(`${path} com-vendas frio`, entries);
  }
  for (const path of DESTINATIONS) {
    // biome-ignore lint/performance/noAwaitInLoops: one step of the menu after the other, from the screen before
    const entries = await warm(page, path);
    measurements.record(`${path} com-vendas quente`, entries);
  }
  measurements.record("/ com-vendas quente", await warm(page, "/"));

  let mark = await markOf(page);
  await page.context().setOffline(true);
  await settle(page, [
    ...home(page),
    page.getByRole("region", { name: "Vendas hoje" }).getByText("Sem conexão"),
  ]);
  measurements.record("/ com-vendas sem-conexao", await since(page, mark));
  mark = await markOf(page);
  await page.context().setOffline(false);
  await settle(page, SCREENS["/"](page));
  measurements.record("/ com-vendas volta-a-conexao", await since(page, mark));

  expect(measurements.problems.join("\n\n")).toBe("");
});
