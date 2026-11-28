// @vitest-environment happy-dom
import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { InventoryPage } from "./inventory-page";
import {
  initialStockListState,
  type StockListState,
  stockLoaded,
} from "./stock-list-model";

const stock = vi.hoisted(() => ({
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
    filters: { archived: true, attention: "", query: "" },
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

const entry = (
  overrides: Partial<InventoryBalanceEntryReadModel>
): InventoryBalanceEntryReadModel => ({
  isDefaultVariant: false,
  listPrice: null,
  movingAverageCost: "10.000000",
  productId: "11111111-1111-4111-8111-111111111111",
  productName: "Camiseta Polaris",
  productStatus: "active",
  quantity: 5,
  sku: null,
  updatedAt: "2026-10-09T12:00:00.000Z",
  values: [
    { optionName: "color", optionValueName: "Azul" },
    { optionName: "size", optionValueName: "M" },
  ],
  variantId: "variant-1",
  version: 3,
  ...overrides,
});

const pageWith = (entries: InventoryBalanceEntryReadModel[]) => {
  stock.state = stockLoaded(
    initialStockListState(),
    { entries, nextCursor: null },
    "k",
    null
  );
  return render(
    <StaticOrganizationProvider organization={ORGANIZATION}>
      <InventoryPage />
    </StaticOrganizationProvider>
  );
};

beforeEach(() => {
  stock.state = initialStockListState();
});

afterEach(cleanup);

describe("o selo Arquivado de uma linha do Estoque", () => {
  it("usa o tom warning, o mesmo de Clientes, Perfis e Categorias", () => {
    pageWith([entry({ productStatus: "archived" })]);
    const badge = screen.getByText("Arquivado");
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(badge.getAttribute("data-variant")).toBe("warning");
  });

  it("não aparece numa variante de produto ativo", () => {
    pageWith([entry({ productStatus: "active" })]);
    expect(screen.queryByText("Arquivado")).toBeNull();
  });
});
