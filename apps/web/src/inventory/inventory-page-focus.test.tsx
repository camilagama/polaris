// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { InventoryPage } from "./inventory-page";
import {
  initialStockListState,
  type StockListState,
  stockLoaded,
  stockLoadFailed,
  stockLoading,
} from "./stock-list-model";

const stock = vi.hoisted(() => ({
  reload: vi.fn(),
  state: undefined as unknown as StockListState,
}));

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));
vi.mock("../offline/runtime/use-local-workspace", () => ({
  useLocalWorkspace: () => null,
}));
vi.mock("./use-stock-attention", () => ({
  useStockAttention: () => ({ links: [], unavailable: false }),
}));
vi.mock("./use-stock-entry-link", () => ({
  useStockEntryLink: () => ({ status: "none" }),
}));
vi.mock("./use-stock-list", () => ({
  useStockList: (
    _organizationId: string,
    _local: unknown,
    initialFilters: Record<string, unknown>
  ) => ({
    applyBalance: () => undefined,
    filters: { archived: false, attention: "", query: "", ...initialFilters },
    listKey: "k",
    loadMore: () => undefined,
    reload: stock.reload,
    setFilters: () => undefined,
    state: stock.state,
  }),
}));

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "staff",
  timezone: "America/Sao_Paulo",
};

const RETRY = { name: "Tentar novamente" };
const TITLE = { name: "Estoque" };

const page = () => (
  <StaticOrganizationProvider organization={ORGANIZATION}>
    <InventoryPage />
  </StaticOrganizationProvider>
);

const ready = (nextCursor: string | null) =>
  stockLoaded(initialStockListState(), { entries: [], nextCursor }, "k");
const refreshFailed = () => stockLoadFailed(ready("c"), new Error("x"), "k");

beforeEach(() => {
  stock.reload.mockReset();
  stock.state = refreshFailed();
});

afterEach(cleanup);

describe("o foco do aviso de falha na releitura do Estoque", () => {
  it("vai ao título quando o aviso some com o foco em Tentar novamente", () => {
    const { rerender } = render(page());
    const retry = screen.getByRole("button", RETRY);
    retry.focus();
    fireEvent.focus(retry);
    stock.state = stockLoading(refreshFailed());
    rerender(page());
    expect(screen.queryByRole("button", RETRY)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", TITLE));
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
    stock.state = stockLoading(refreshFailed());
    rerender(page());
    expect(document.activeElement).toBe(other);
  });

  it("não puxa o foco ao título quando quem o largou não foi a outro campo", () => {
    const { rerender } = render(page());
    const retry = screen.getByRole("button", RETRY);
    retry.focus();
    fireEvent.focus(retry);
    retry.blur();
    stock.state = stockLoading(refreshFailed());
    rerender(page());
    expect(document.activeElement).toBe(document.body);
  });

  it("Carregar mais, falha na releitura e Tentar novamente: o foco volta ao título nas duas saídas", () => {
    stock.state = ready("c");
    const { rerender } = render(page());
    const more = screen.getByRole("button", { name: "Carregar mais" });
    more.focus();
    fireEvent.focus(more);
    stock.state = stockLoading(ready("c"));
    rerender(page());
    expect(document.activeElement).toBe(screen.getByRole("heading", TITLE));
    stock.state = refreshFailed();
    rerender(page());
    const retry = screen.getByRole("button", RETRY);
    retry.focus();
    fireEvent.focus(retry);
    stock.state = stockLoading(refreshFailed());
    rerender(page());
    expect(document.activeElement).toBe(screen.getByRole("heading", TITLE));
  });

  it("o Carregar mais segue indo ao título quando some com o foco nele", () => {
    stock.state = ready("c");
    const { rerender } = render(page());
    const more = screen.getByRole("button", { name: "Carregar mais" });
    more.focus();
    fireEvent.focus(more);
    stock.state = stockLoading(ready("c"));
    rerender(page());
    expect(document.activeElement).toBe(screen.getByRole("heading", TITLE));
  });
});

describe("o foco do erro de tela cheia do Estoque", () => {
  const fullError = () =>
    stockLoadFailed(initialStockListState(), new Error("x"), "k");

  it("vai ao título quando o erro some com o foco em Tentar novamente", () => {
    stock.state = fullError();
    const { rerender } = render(page());
    const retry = screen.getByRole("button", RETRY);
    retry.focus();
    fireEvent.focus(retry);
    stock.state = stockLoading(fullError());
    rerender(page());
    expect(screen.queryByRole("button", RETRY)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", TITLE));
  });

  it("não mexe no foco de quem já foi a outro campo", () => {
    stock.state = fullError();
    const { rerender } = render(page());
    const retry = screen.getByRole("button", RETRY);
    retry.focus();
    fireEvent.focus(retry);
    const other = screen
      .getAllByRole("button")
      .find((button) => button !== retry) as HTMLElement;
    other.focus();
    stock.state = stockLoading(fullError());
    rerender(page());
    expect(document.activeElement).toBe(other);
  });

  it("não puxa o foco ao título quando quem o largou não foi a outro campo", () => {
    stock.state = fullError();
    const { rerender } = render(page());
    const retry = screen.getByRole("button", RETRY);
    retry.focus();
    fireEvent.focus(retry);
    retry.blur();
    stock.state = stockLoading(fullError());
    rerender(page());
    expect(document.activeElement).toBe(document.body);
  });
});
