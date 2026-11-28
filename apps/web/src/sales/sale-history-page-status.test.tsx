// @vitest-environment happy-dom
import type { SaleListEntryReadModel } from "@polaris/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import {
  emptyHistoryFilters,
  type HistoryState,
  historyLoaded,
  historyLoading,
  initialHistoryState,
  loadMoreStarted,
} from "./sale-history-model";
import { SaleHistoryPage } from "./sale-history-page";

const history = vi.hoisted(() => ({
  filters: undefined as unknown,
  state: undefined as unknown as HistoryState,
}));

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));
vi.mock("../offline/runtime/use-local-workspace", () => ({
  useLocalWorkspace: () => null,
}));
vi.mock("./pending-sales", () => ({ usePendingSales: () => [] }));
vi.mock("./use-history-period-total", () => ({
  useHistoryPeriodTotal: () => ({ kind: "none" }),
}));
vi.mock("./use-sale-history", () => ({
  useSaleHistory: (
    _organizationId: string,
    _local: unknown,
    initial: unknown
  ) => ({
    filters: history.filters ?? initial,
    listKey: "k",
    loadMore: () => undefined,
    reload: () => undefined,
    reloadVersion: 0,
    setFilters: () => undefined,
    state: history.state,
  }),
}));

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "staff",
  timezone: "America/Sao_Paulo",
};

const SALE: SaleListEntryReadModel = {
  cancelledAt: null,
  confirmedAt: "2026-05-01T12:00:01.000Z",
  customerId: null,
  customerName: null,
  hasReturns: false,
  id: "00000000-0000-4000-8000-000000000001",
  itemCount: 2,
  occurredAt: "2026-05-01T12:00:00.000Z",
  occurredOn: "2026-05-01",
  paymentMethod: "pix",
  status: "confirmed",
  totalDue: "1234.5",
};

const ready = () =>
  historyLoaded(initialHistoryState(), { hasMore: true, sales: [SALE] }, "k");

const renderPage = () =>
  render(
    <StaticOrganizationProvider organization={ORGANIZATION}>
      <SaleHistoryPage />
    </StaticOrganizationProvider>
  );

const listCount = () =>
  document.querySelector("[data-list-count]") as HTMLElement;

beforeEach(() => {
  history.filters = undefined;
  history.state = ready();
});

afterEach(cleanup);

describe("o aviso de espera do Histórico", () => {
  it("Carregando mais vendas… fica só para o leitor de tela: sr-only dentro do role=status, e o botão diz Carregando… desligado", () => {
    history.state = loadMoreStarted(ready(), "k");
    renderPage();
    const phrase = screen.getByText("Carregando mais vendas…");
    expect(phrase.classList.contains("sr-only")).toBe(true);
    expect(phrase.closest('[role="status"]')).not.toBeNull();
    const button = screen.getByRole("button", { name: "Carregando…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("com a lista pronta a contagem diz quantas vendas há", () => {
    renderPage();
    expect(listCount().textContent).toBe("1 venda · há mais");
  });

  it("durante a releitura da 1ª página, Atualizando a lista… fica no lugar da contagem, à vista, e não sobra parágrafo solto", () => {
    history.state = historyLoading(ready());
    renderPage();
    const count = listCount();
    expect(count.textContent).toBe("Atualizando a lista…");
    expect(count.getAttribute("aria-live")).toBe("polite");
    expect(count.classList.contains("sr-only")).toBe(false);
    expect(screen.getAllByText("Atualizando a lista…")).toEqual([count]);
  });

  it("sem nenhuma venda e sem filtro não há contagem: a frase da releitura fica à vista, no role=status", () => {
    history.state = historyLoading(
      historyLoaded(initialHistoryState(), { hasMore: false, sales: [] }, "k")
    );
    renderPage();
    expect(document.querySelector("[data-list-count]")).toBeNull();
    const phrase = screen.getByText("Atualizando a lista…");
    expect(phrase.classList.contains("sr-only")).toBe(false);
    expect(phrase.closest('[role="status"]')).not.toBeNull();
  });

  it("busca sem resultado: a contagem da moldura diz Atualizando a lista… durante a releitura", () => {
    history.filters = { ...emptyHistoryFilters, status: "cancelled" };
    history.state = historyLoading(
      historyLoaded(initialHistoryState(), { hasMore: false, sales: [] }, "k")
    );
    renderPage();
    expect(listCount().textContent).toBe("Atualizando a lista…");
    expect(screen.getAllByText("Atualizando a lista…")).toEqual([listCount()]);
  });
});
