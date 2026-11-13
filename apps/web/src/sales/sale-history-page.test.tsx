import type { SaleListEntryReadModel } from "@polaris/contracts";
import type { EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import {
  emptyHistoryFilters,
  type HistoryFilters,
  historyListRequest,
  saleDetailHref,
} from "./sale-history-model";
import { SaleHistoryPage } from "./sale-history-page";

const mounted = vi.hoisted(() => ({ effects: [] as (() => unknown)[] }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: EffectCallback) => {
    mounted.effects.push(effect);
  },
}));

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));
vi.mock("../offline/runtime/use-local-workspace", () => ({
  useLocalWorkspace: () => null,
}));

/**
 * A server that answers `sale.list` from the request the page's hook is given: the page is rendered once, and the list
 * on screen is what that request asks for, so a filter the page lets in or leaves out shows in the rows.
 */
const server = vi.hoisted(() => ({
  requests: [] as unknown[],
  sales: [] as SaleListEntryReadModel[],
}));

vi.mock("./use-sale-history", async () => {
  const model = await import("./sale-history-model");
  return {
    useSaleHistory: (
      organizationId: string,
      _local: unknown,
      initial: HistoryFilters
    ) => {
      const request = model.historyListRequest(organizationId, initial, 0);
      server.requests.push(request);
      const sales = server.sales.filter(
        (entry) =>
          (request.occurredFrom === undefined ||
            entry.occurredOn >= request.occurredFrom) &&
          (request.occurredTo === undefined ||
            entry.occurredOn <= request.occurredTo) &&
          (request.status === undefined || entry.status === request.status)
      );
      return {
        filters: initial,
        loadMore: () => undefined,
        reload: () => undefined,
        setFilters: () => undefined,
        state: model.historyLoaded(model.initialHistoryState(), {
          hasMore: false,
          sales,
        }),
      };
    },
  };
});

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const PERIOD = { from: "2026-10-01", to: "2026-10-14" };
const NOW = new Date("2026-10-20T15:00:00.000Z");

const sale = (
  n: number,
  overrides: Partial<SaleListEntryReadModel>
): SaleListEntryReadModel => ({
  cancelledAt: null,
  confirmedAt: "2026-10-14T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: `0199c2d0-0000-7000-8000-000000002${String(n).padStart(3, "0")}`,
  itemCount: 1,
  occurredAt: "2026-10-14T12:00:00.000Z",
  occurredOn: "2026-10-14",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "10.00",
  ...overrides,
});

const CONFIRMED_IN = sale(1, { occurredOn: "2026-10-05" });
const CANCELLED_IN = sale(2, {
  cancelledAt: "2026-10-06T13:00:00.000Z",
  occurredOn: "2026-10-06",
  status: "cancelled",
});
const CONFIRMED_OUT = sale(3, { occurredOn: "2026-09-20" });
const CANCELLED_OUT = sale(4, {
  cancelledAt: "2026-09-21T13:00:00.000Z",
  occurredOn: "2026-09-21",
  status: "cancelled",
});

const PERIOD_PILL = /Período: [^"]*, editar/;
const STATUS_PILL = /Situação: [^"]*, editar/;

const browserHistory = { state: null as unknown };

function openWith(navigationState: unknown) {
  browserHistory.state = navigationState;
  vi.stubGlobal("window", {
    history: {
      replaceState: (state: unknown) => {
        browserHistory.state = state;
      },
      get state() {
        return browserHistory.state;
      },
    },
  });
  mounted.effects = [];
  return renderToStaticMarkup(
    <StaticOrganizationProvider organization={ORGANIZATION}>
      <SaleHistoryPage />
    </StaticOrganizationProvider>
  );
}

const shows = (html: string, entry: SaleListEntryReadModel) =>
  html.includes(`href="${saleDetailHref(entry.id)}"`);

const runMountEffects = () => {
  for (const effect of mounted.effects) {
    effect();
  }
};

const INVALID_PERIODS: [string, unknown][] = [
  ["data inicial depois da final", { from: "2026-10-14", to: "2026-10-01" }],
  ["data que não existe", { from: "2026-02-30", to: "2026-10-14" }],
  ["texto no lugar da data", { from: "ontem", to: "hoje" }],
  ["só uma ponta", { from: "2026-10-01" }],
  ["mais de um ano", { from: "2024-01-01", to: "2026-10-14" }],
  ["datas que não são texto", { from: 20_261_001, to: 20_261_014 }],
  ["texto no lugar do objeto", "2026-10-01"],
  ["nulo", null],
];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  server.requests = [];
  server.sales = [CONFIRMED_IN, CANCELLED_IN, CONFIRMED_OUT, CANCELLED_OUT];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("o Histórico aberto com o estado de navegação do Resultado", () => {
  it.each([
    ["texto que não é uma Situação", "ninguem"],
    ["a Situação com outra caixa", "Confirmed"],
    ["texto vazio", ""],
    ["número", 1],
    ["nulo", null],
    ["objeto", { status: "confirmed" }],
  ])(
    "Situação inválida (%s) com período válido: a Situação fica no padrão e o período vale",
    (_name, status) => {
      const html = openWith({ historyPeriod: PERIOD, historyStatus: status });

      expect(server.requests).toEqual([
        historyListRequest(
          ORGANIZATION.id,
          {
            customer: "",
            from: PERIOD.from,
            query: "",
            status: "",
            to: PERIOD.to,
          },
          0
        ),
      ]);
      expect(html).toMatch(PERIOD_PILL);
      expect(html).not.toMatch(STATUS_PILL);
      expect(shows(html, CONFIRMED_IN)).toBe(true);
      expect(shows(html, CANCELLED_IN)).toBe(true);
      expect(shows(html, CONFIRMED_OUT)).toBe(false);
      expect(shows(html, CANCELLED_OUT)).toBe(false);
    }
  );

  it("Situação ausente com período válido: o mesmo, só o período", () => {
    const html = openWith({ historyPeriod: PERIOD });

    expect(html).toMatch(PERIOD_PILL);
    expect(html).not.toMatch(STATUS_PILL);
    expect(shows(html, CONFIRMED_IN)).toBe(true);
    expect(shows(html, CANCELLED_IN)).toBe(true);
    expect(shows(html, CONFIRMED_OUT)).toBe(false);
  });

  it("controle: Situação válida com o mesmo período aplica as duas", () => {
    const html = openWith({
      historyPeriod: PERIOD,
      historyStatus: "confirmed",
    });

    expect(html).toMatch(PERIOD_PILL);
    expect(html).toContain("Situação: Confirmadas, editar");
    expect(shows(html, CONFIRMED_IN)).toBe(true);
    expect(shows(html, CANCELLED_IN)).toBe(false);
    expect(shows(html, CONFIRMED_OUT)).toBe(false);
  });

  it("sem estado nenhum: nenhuma pílula e a lista inteira", () => {
    const html = openWith(null);

    expect(html).not.toMatch(PERIOD_PILL);
    expect(html).not.toMatch(STATUS_PILL);
    for (const entry of server.sales) {
      expect(shows(html, entry)).toBe(true);
    }
  });

  it.each(INVALID_PERIODS)(
    "período inválido (%s) com Situação válida: o período fica no padrão e a Situação vale",
    (_name, period) => {
      const html = openWith({
        historyPeriod: period,
        historyStatus: "confirmed",
      });

      expect(server.requests).toEqual([
        historyListRequest(
          ORGANIZATION.id,
          {
            customer: "",
            from: "",
            query: "",
            status: "confirmed",
            to: "",
          },
          0
        ),
      ]);
      expect(html).not.toMatch(PERIOD_PILL);
      expect(html).toContain("Situação: Confirmadas, editar");
      expect(shows(html, CONFIRMED_IN)).toBe(true);
      expect(shows(html, CONFIRMED_OUT)).toBe(true);
      expect(shows(html, CANCELLED_IN)).toBe(false);
      expect(shows(html, CANCELLED_OUT)).toBe(false);
    }
  );
});

describe("depois de montar, o Histórico descarta o estado de navegação", () => {
  it("o estado sai da entrada do histórico e uma nova abertura não reaplica os filtros", () => {
    const html = openWith({
      historyPeriod: PERIOD,
      historyStatus: "confirmed",
    });
    expect(html).toMatch(PERIOD_PILL);
    expect(html).toMatch(STATUS_PILL);
    expect(browserHistory.state).toEqual({
      historyPeriod: PERIOD,
      historyStatus: "confirmed",
    });

    runMountEffects();

    expect(browserHistory.state).toEqual({});

    server.requests = [];
    const reopened = renderToStaticMarkup(
      <StaticOrganizationProvider organization={ORGANIZATION}>
        <SaleHistoryPage />
      </StaticOrganizationProvider>
    );

    expect(server.requests).toEqual([
      historyListRequest(ORGANIZATION.id, emptyHistoryFilters, 0),
    ]);
    expect(reopened).not.toMatch(PERIOD_PILL);
    expect(reopened).not.toMatch(STATUS_PILL);
    for (const entry of server.sales) {
      expect(shows(reopened, entry)).toBe(true);
    }
  });

  it("o descarte tira só as chaves do Histórico e deixa o resto do estado", () => {
    openWith({
      historyPeriod: PERIOD,
      historyStatus: "confirmed",
      outraChave: 1,
    });

    runMountEffects();

    expect(browserHistory.state).toEqual({ outraChave: 1 });
  });
});
