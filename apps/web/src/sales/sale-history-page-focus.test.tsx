// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import {
  type HistoryState,
  historyLoaded,
  historyLoadFailed,
  historyLoading,
  initialHistoryState,
} from "./sale-history-model";
import { SaleHistoryPage } from "./sale-history-page";

const history = vi.hoisted(() => ({
  reload: vi.fn(),
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
    filters: initial,
    listKey: "k",
    loadMore: () => undefined,
    reload: history.reload,
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

const RETRY = { name: "Tentar novamente" };

const page = () => (
  <StaticOrganizationProvider organization={ORGANIZATION}>
    <SaleHistoryPage />
  </StaticOrganizationProvider>
);

const ready = (hasMore: boolean) =>
  historyLoaded(initialHistoryState(), { hasMore, sales: [] }, "k");
const refreshFailed = () => historyLoadFailed(ready(true), new Error("x"), "k");

beforeEach(() => {
  history.reload.mockReset();
  history.state = refreshFailed();
});

afterEach(cleanup);

describe("o foco do aviso de falha na releitura do Histórico", () => {
  it("vai ao título quando o aviso some com o foco em Tentar novamente", () => {
    const { rerender } = render(page());
    const retry = screen.getByRole("button", RETRY);
    retry.focus();
    fireEvent.focus(retry);
    history.state = historyLoading(refreshFailed());
    rerender(page());
    expect(screen.queryByRole("button", RETRY)).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Histórico de vendas" })
    );
  });

  it("não mexe no foco de quem já foi a outro campo", () => {
    const { rerender } = render(page());
    const retry = screen.getByRole("button", RETRY);
    retry.focus();
    fireEvent.focus(retry);
    const other = screen
      .getAllByRole("button")
      .find((button) => button !== retry) as HTMLElement;
    other.focus();
    history.state = historyLoading(refreshFailed());
    rerender(page());
    expect(document.activeElement).toBe(other);
  });

  it("não puxa o foco ao título quando quem o largou não foi a outro campo", () => {
    const { rerender } = render(page());
    const retry = screen.getByRole("button", RETRY);
    retry.focus();
    fireEvent.focus(retry);
    retry.blur();
    history.state = historyLoading(refreshFailed());
    rerender(page());
    expect(document.activeElement).toBe(document.body);
  });

  it("Carregar mais, falha na releitura e Tentar novamente: o foco volta ao título nas duas saídas", () => {
    history.state = ready(true);
    const { rerender } = render(page());
    const more = screen.getByRole("button", { name: "Carregar mais" });
    more.focus();
    fireEvent.focus(more);
    history.state = historyLoading(ready(true));
    rerender(page());
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Histórico de vendas" })
    );
    history.state = refreshFailed();
    rerender(page());
    const retry = screen.getByRole("button", RETRY);
    retry.focus();
    fireEvent.focus(retry);
    history.state = historyLoading(refreshFailed());
    rerender(page());
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Histórico de vendas" })
    );
  });

  it("o Carregar mais segue indo ao título quando some com o foco nele", () => {
    history.state = ready(true);
    const { rerender } = render(page());
    const more = screen.getByRole("button", { name: "Carregar mais" });
    more.focus();
    fireEvent.focus(more);
    history.state = historyLoading(ready(true));
    rerender(page());
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Histórico de vendas" })
    );
  });
});
