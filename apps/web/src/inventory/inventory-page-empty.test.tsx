// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { InventoryPage } from "./inventory-page";
import {
  initialStockListState,
  type StockListState,
  stockLoaded,
} from "./stock-list-model";

const stock = vi.hoisted(() => ({
  query: "",
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
  useStockList: () => ({
    applyBalance: () => undefined,
    filters: { archived: false, attention: "", query: stock.query },
    listKey: "k",
    loadMore: () => undefined,
    reload: () => undefined,
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

afterEach(cleanup);

describe("o Estoque com a busca sem resultado", () => {
  it("a frase de não achei, dita uma vez, é uma região de status", () => {
    stock.query = "zzz";
    stock.state = stockLoaded(
      initialStockListState(),
      { entries: [], nextCursor: null },
      "k",
      null
    );
    render(
      <StaticOrganizationProvider organization={ORGANIZATION}>
        <InventoryPage />
      </StaticOrganizationProvider>
    );
    const sentence = screen.getAllByText(
      "Nenhuma variante encontrada para “zzz”."
    );
    expect(sentence).toHaveLength(1);
    expect(sentence[0]?.getAttribute("role")).toBe("status");
  });
});
