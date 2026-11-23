// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import {
  emptyHistoryFilters,
  type HistoryFilters,
  historyLoaded,
  initialHistoryState,
} from "./sale-history-model";
import { SaleHistoryPage } from "./sale-history-page";

const opening = vi.hoisted(() => ({ filters: null as unknown }));
const seen = vi.hoisted(() => ({ filters: [] as unknown[] }));

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));
vi.mock("../lib/motion-level", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/motion-level")>()),
  useMotionLevel: () => "none",
}));
vi.mock("../offline/runtime/use-local-workspace", () => ({
  useLocalWorkspace: () => null,
}));
vi.mock("./pending-sales", () => ({ usePendingSales: () => [] }));
vi.mock("./use-history-period-total", () => ({
  useHistoryPeriodTotal: () => ({ kind: "none" }),
}));
vi.mock("./use-sale-history", async () => {
  const { useCallback, useState } = await import("react");
  return {
    useSaleHistory: () => {
      const [filters, setState] = useState(opening.filters as HistoryFilters);
      const setFilters = useCallback(
        (changes: Partial<HistoryFilters>) =>
          setState((previous) => ({ ...previous, ...changes })),
        []
      );
      seen.filters.push(filters);
      return {
        filters,
        listKey: "k",
        loadMore: () => undefined,
        reload: () => undefined,
        reloadVersion: 0,
        setFilters,
        state: historyLoaded(
          initialHistoryState(),
          { hasMore: false, sales: [] },
          "k"
        ),
      };
    },
  };
});

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "staff",
  timezone: "America/Sao_Paulo",
};
const ADD_FILTER = /^Filtrar/;
const PERIOD = { from: "2026-10-01", to: "2026-10-14" };

const page = () => (
  <StaticOrganizationProvider organization={ORGANIZATION}>
    <SaleHistoryPage />
  </StaticOrganizationProvider>
);

const current = () => seen.filters.at(-1) as HistoryFilters;
const clearAll = () => screen.queryByRole("button", { name: "Limpar tudo" });

beforeEach(() => {
  seen.filters = [];
});

afterEach(cleanup);

describe('"Limpar tudo" do Histórico', () => {
  it("com período e duas pílulas tira as pílulas e o período, e o foco vai a Filtrar", async () => {
    opening.filters = {
      ...emptyHistoryFilters,
      ...PERIOD,
      customer: "Maria",
      status: "cancelled",
    };
    render(page());
    expect(current()).toMatchObject(PERIOD);
    fireEvent.click(clearAll() as HTMLElement);
    expect(current()).toEqual(emptyHistoryFilters);
    expect(clearAll()).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: ADD_FILTER })
      )
    );
  });

  it("com uma pílula e período, o X da pílula não tira o período e Limpar tudo não aparece", () => {
    opening.filters = {
      ...emptyHistoryFilters,
      ...PERIOD,
      status: "cancelled",
    };
    render(page());
    expect(clearAll()).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Tirar o filtro Situação" })
    );
    expect(current()).toEqual({ ...emptyHistoryFilters, ...PERIOD });
  });

  it("tirar a penúltima pílula pelo X deixa o período, e uma pílula só fica sem Limpar tudo", () => {
    opening.filters = {
      ...emptyHistoryFilters,
      ...PERIOD,
      customer: "Maria",
      status: "cancelled",
    };
    render(page());
    fireEvent.click(
      screen.getByRole("button", { name: "Tirar o filtro Cliente" })
    );
    expect(current()).toMatchObject({ ...PERIOD, customer: "" });
    expect(clearAll()).toBeNull();
  });

  it("o período sozinho, sem pílula, não mostra Limpar tudo", () => {
    opening.filters = { ...emptyHistoryFilters, ...PERIOD };
    render(page());
    expect(clearAll()).toBeNull();
  });
});
