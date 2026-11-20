// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFirstSteps } from "../app-shell/first-steps";
import { clearPeriodSummaryCaches } from "../lib/period-summary-cache";
import { forgetLargeCatalog, LARGE_CATALOG_KEY } from "./home-inventory";
import { homePeriods } from "./home-model";
import { useHome } from "./use-home";

const ORG = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER = "0199c2d0-0000-7000-8000-00000000a002";
const ZONE = "America/Sao_Paulo";
const NOW = new Date("2026-10-23T15:00:00.000Z");
const TODAY = "2026-10-23";
const DAY = 86_400_000;

const calls = {
  balances: vi.fn(),
  dailySales: vi.fn(),
  goals: vi.fn(),
  periodSummary: vi.fn(),
  saleList: vi.fn(),
};

vi.mock("../lib/browser-connection", () => ({
  browserConnection: { isOnline: () => true, mayRetryRead: () => false },
  useConnectionReturn: () => true,
  workerAnswers: async () => true,
}));
vi.mock("../lib/orpc", () => ({
  orpcClient: {
    goal: { list: (input: unknown) => calls.goals(input) },
    inventory: { listBalances: (input: unknown) => calls.balances(input) },
    report: {
      dailySales: (input: unknown) => calls.dailySales(input),
      periodSummary: (input: unknown) => calls.periodSummary(input),
    },
    sale: { list: (input: unknown) => calls.saleList(input) },
  },
}));

function datesOf(from: string, to: string): string[] {
  const dates: string[] = [];
  for (
    let time = Date.parse(`${from}T00:00:00.000Z`);
    time <= Date.parse(`${to}T00:00:00.000Z`);
    time += DAY
  ) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

function summary(
  period: { from: string; to: string },
  { sold, unknownCostLines }: { sold: boolean; unknownCostLines: number }
) {
  return {
    cards: {
      items: sold ? 3 : 0,
      marginPercent: null,
      netSales: sold ? "130.00" : "0.00",
      operatingResult: "0.00",
      salesCount: sold ? 2 : 0,
      ticket: sold ? "65.00" : "0.00",
    },
    chain: {
      anticipationFees: "0.00",
      cogs: "0.00",
      commercialSurcharges: "0.00",
      contributionMargin: "0.00",
      discounts: "0.00",
      estimatedOperatingResult: "0.00",
      grossProfit: "0.00",
      grossSales: "0.00",
      linkedExpenses: "0.00",
      netSales: "0.00",
      operatingExpenses: "0.00",
      processingFees: "0.00",
      returns: "0.00",
    },
    daily: datesOf(period.from, period.to).map((date) => ({
      date,
      netSales: "0.00",
      salesCount: 0,
    })),
    generatedAt: NOW.toISOString(),
    period,
    quality: {
      anticipationFeesUnknown: 0,
      itemLines: sold ? 2 : 0,
      itemLinesWithUnknownCost: unknownCostLines,
      level: "complete",
      linkedExpenses: 0,
      missing: [],
      operatingExpenses: 0,
      processingFeesUnknown: 0,
      salesCount: sold ? 2 : 0,
    },
  };
}

interface Variant {
  cost: string | null;
  product: string;
  quantity: number;
  status?: "active" | "archived";
}

const entryOf = (variant: Variant, index: number) => ({
  isDefaultVariant: true,
  listPrice: "10.00",
  movingAverageCost: variant.cost,
  productId: variant.product,
  productName: `Produto ${index}`,
  productStatus: variant.status ?? "active",
  quantity: variant.quantity,
  sku: null,
  updatedAt: null,
  values: [],
  variantId: `variant-${index}`,
  version: 0,
});

/** The server's list: the variants in order, the filters of the Início applied as the repository does. */
function listOf(
  catalog: Variant[],
  input: {
    cost?: string;
    limit: number;
    productStatus?: string;
    stock?: string;
  }
) {
  const rows = catalog.filter((variant) => {
    if (input.productStatus !== "all" && variant.status === "archived") {
      return false;
    }
    if (input.stock === "with_stock" && variant.quantity <= 0) {
      return false;
    }
    if (input.stock === "without_stock" && variant.quantity !== 0) {
      return false;
    }
    return input.cost !== "unknown" || variant.cost === null;
  });
  return {
    entries: rows.slice(0, input.limit).map(entryOf),
    nextCursor: rows.length > input.limit ? "mais" : null,
  };
}

const item = (over: Partial<Variant> = {}): Variant => ({
  cost: "5.00",
  product: "product-1",
  quantity: 0,
  ...over,
});

function serve({
  catalog,
  sold = false,
  unknownCostLines = 0,
}: {
  catalog: Variant[];
  sold?: boolean;
  unknownCostLines?: number;
}) {
  calls.periodSummary.mockImplementation(
    (input: { from: string; to: string }) =>
      Promise.resolve(summary(input, { sold, unknownCostLines }))
  );
  calls.goals.mockResolvedValue({ goals: [] });
  calls.dailySales.mockRejectedValue(new Error("series not under test"));
  calls.saleList.mockResolvedValue({ hasMore: false, sales: [] });
  calls.balances.mockImplementation((input) =>
    Promise.resolve(listOf(catalog, input))
  );
}

const serverFault = () =>
  Object.assign(new Error("fault"), {
    code: "INTERNAL_SERVER_ERROR",
    status: 500,
  });

const isWide = (input: { limit: number; productStatus?: string }) =>
  input.productStatus === "all" && input.limit === 100;
const balanceInputs = () =>
  calls.balances.mock.calls.map(([input]) => input as Record<string, unknown>);
const wideReads = () =>
  balanceInputs().filter((input) =>
    isWide(input as { limit: number; productStatus?: string })
  );

let mounted: ReturnType<typeof mount> | null = null;

function mount(organizationId = ORG, role = "owner") {
  return renderHook(() => useHome(organizationId, role, ZONE));
}

async function opened(organizationId = ORG, role = "owner") {
  mounted = mount(organizationId, role);
  const { result } = mounted;
  await waitFor(() => {
    expect(result.current.state.stock.status).not.toBe("loading");
    expect(result.current.state.checklist.status).not.toBe("loading");
    expect(result.current.state.figures.status).not.toBe("loading");
  });
  return result.current.state;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  for (const call of Object.values(calls)) {
    call.mockReset();
  }
  forgetLargeCatalog();
  window.sessionStorage.clear();
  clearPeriodSummaryCaches(window.localStorage);
  clearFirstSteps();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

describe("o Início lê o estoque numa chamada só", () => {
  it("loja nova com até 100 variantes: 1 leitura larga e nenhuma filtrada; checklist e avisos saem dela", async () => {
    serve({
      catalog: [
        item({ product: "first", quantity: 0 }),
        item({ product: "second", quantity: 4 }),
        item({ cost: null, product: "third", quantity: 0 }),
        item({ product: "gone", quantity: 9, status: "archived" }),
      ],
      unknownCostLines: 1,
    });

    const state = await opened();

    expect(balanceInputs()).toEqual([
      { limit: 100, organizationId: ORG, productStatus: "all" },
    ]);
    expect(state.checklist).toEqual({
      data: { firstProductId: "first", hasStock: true },
      status: "ready",
    });
    expect(state.stock).toEqual({
      data: {
        unknownCost: { count: 1, more: false },
        withoutStock: { count: 2, more: false },
      },
      status: "ready",
    });
  });

  it("loja com venda: a mesma leitura serve ao S e ao C, sem ler o checklist", async () => {
    serve({
      catalog: [item({ cost: null, quantity: 0 }), item({ quantity: 2 })],
      sold: true,
      unknownCostLines: 3,
    });

    const state = await opened();

    expect(balanceInputs()).toHaveLength(1);
    expect(calls.saleList).not.toHaveBeenCalled();
    expect(state.checklist).toEqual({
      data: null,
      status: "ready",
    });
    expect(state.stock).toMatchObject({
      data: {
        unknownCost: { count: 1, more: false },
        withoutStock: { count: 1, more: false },
      },
    });
  });

  it("o mês sem linha sem custo não liga o aviso de custo que hoje não apareceria", async () => {
    serve({
      catalog: [item({ cost: null, quantity: 0 })],
      sold: true,
      unknownCostLines: 0,
    });

    const state = await opened();

    expect(state.stock).toMatchObject({ data: { unknownCost: null } });
  });

  it("catálogo vazio: sem produto, sem passo marcado a mais", async () => {
    serve({ catalog: [] });

    const state = await opened();

    expect(state.checklist).toEqual({
      data: { firstProductId: null, hasStock: false },
      status: "ready",
    });
  });

  it("papel sem leitura de estoque: nenhuma leitura de estoque e o bloco some", async () => {
    serve({ catalog: [item()] });

    mounted = mount(ORG, "cashier");
    await waitFor(() =>
      expect(mounted?.result.current.state.stock.status).toBe("hidden")
    );

    expect(calls.balances).not.toHaveBeenCalled();
  });
});

describe("catálogo com mais de 100 variantes", () => {
  const large = () =>
    Array.from({ length: 102 }, (_, index) =>
      item({
        product: `product-${index}`,
        quantity: index === 0 ? 5 : 0,
      })
    );

  it("a 1ª abertura lê a larga e as filtradas de hoje; a 2ª, da mesma aba, só as filtradas; a tela é a de hoje nas duas", async () => {
    serve({ catalog: large() });

    const first = await opened();
    const firstReads = balanceInputs();
    mounted?.unmount();
    calls.balances.mockClear();
    const second = await opened();

    expect(wideReads()).toHaveLength(0);
    expect(firstReads.filter((input) => isWide(input as never))).toHaveLength(
      1
    );
    expect(firstReads).toHaveLength(4);
    expect(balanceInputs()).toHaveLength(3);
    expect(balanceInputs()).toContainEqual({
      limit: 100,
      organizationId: ORG,
      productStatus: "active",
      stock: "without_stock",
    });
    expect(second.stock).toEqual(first.stock);
    expect(second.checklist).toEqual(first.checklist);
    expect(second.stock).toEqual({
      data: {
        unknownCost: null,
        withoutStock: { count: 100, more: true },
      },
      status: "ready",
    });
    expect(second.checklist).toEqual({
      data: { firstProductId: "product-0", hasStock: true },
      status: "ready",
    });
  });

  it("com 100 variantes exatas a lista larga basta", async () => {
    serve({
      catalog: Array.from({ length: 100 }, (_, index) =>
        item({ product: `product-${index}` })
      ),
      sold: true,
    });

    await opened();

    expect(balanceInputs()).toHaveLength(1);
  });

  it("a pista cai com a sessão encerrada ou o Sair: a próxima abertura lê a larga de novo", async () => {
    serve({ catalog: large(), sold: true });
    await opened();
    mounted?.unmount();
    forgetLargeCatalog();
    calls.balances.mockClear();

    await opened();

    expect(wideReads()).toHaveLength(1);
  });

  it("a pista cai na troca de loja", async () => {
    serve({ catalog: large(), sold: true });
    await opened(ORG);
    mounted?.unmount();
    await opened(OTHER);
    mounted?.unmount();
    calls.balances.mockClear();

    await opened(ORG);

    expect(wideReads()).toHaveLength(1);
  });

  it("a pista fica no sessionStorage da aba, nunca no localStorage", async () => {
    serve({ catalog: large(), sold: true });

    await opened();

    expect(window.sessionStorage.getItem(LARGE_CATALOG_KEY)).toBe(ORG);
    expect(window.localStorage.length).toBe(0);
  });
});

describe("a leitura larga falha", () => {
  it("derruba só os blocos dela: estoque com erro, checklist sem 'sem produto' nem passo desmarcado, números de pé", async () => {
    serve({ catalog: [item()] });
    calls.balances.mockRejectedValue(serverFault());

    const state = await opened();

    expect(state.stock).toEqual({ retryable: true, status: "error" });
    expect(state.checklist).toEqual({ data: null, status: "ready" });
    expect(state.figures.status).toBe("ready");
    expect(balanceInputs()).toHaveLength(1);
  });

  it("não deixa a pista nem lê as filtradas no lugar", async () => {
    serve({ catalog: [item()], sold: true });
    calls.balances.mockRejectedValueOnce(serverFault());
    await opened();
    mounted?.unmount();
    calls.balances.mockClear();

    await opened();

    expect(wideReads()).toHaveLength(1);
  });
});

describe("os números não esperam o estoque", () => {
  it("com a leitura larga parada, os quatro cartões já estão prontos", async () => {
    serve({ catalog: [item()], sold: true });
    calls.balances.mockReturnValue(new Promise(() => undefined));

    mounted = mount();
    const { result } = mounted;
    await waitFor(() =>
      expect(result.current.state.figures.status).toBe("ready")
    );
    await act(() => Promise.resolve());

    expect(result.current.state.stock.status).toBe("loading");
    expect(homePeriods(TODAY).month.from).toBe("2026-10-01");
  });
});
