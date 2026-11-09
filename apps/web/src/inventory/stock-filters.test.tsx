import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type FilterRule,
  removeRule,
  setRule,
  visibleRules,
} from "@/ui/filter-bar-model";
import {
  StockFiltersBar,
  stockFields,
  stockFilters,
  stockRules,
} from "./stock-filters";
import { defaultStockFilters, type StockFilters } from "./stock-list-model";

const FIELDS = stockFields(false);
const noop = () => undefined;

const apply = (
  filters: StockFilters,
  fieldId: string,
  value: FilterRule["value"] | null
) => stockFilters(setRule(FIELDS, stockRules(filters), fieldId, value));

const render = (filters: StockFilters, offline = false) =>
  renderToStaticMarkup(
    <StockFiltersBar filters={filters} offline={offline} onChange={noop} />
  );

const everything: StockFilters = {
  includeArchived: true,
  query: "",
  stock: "without_stock",
  unknownCost: true,
};

describe("os filtros do Estoque na barra", () => {
  it("sem filtro: só o 'Filtrar', sem pílula e sem 'Limpar tudo'", () => {
    const html = render(defaultStockFilters);
    expect(html).toContain('aria-label="Filtrar estoque"');
    expect(html).toContain(">Filtrar</button>");
    expect(html).not.toContain("filter-pill");
    expect(html).not.toContain("Limpar tudo");
  });

  it("uma pílula por filtro em uso, na ordem dos campos, e 'Limpar tudo' a partir de duas", () => {
    const one = render({ ...defaultStockFilters, stock: "with_stock" });
    expect(one).toContain("Saldo: Com saldo, editar");
    expect(one).not.toContain("Limpar tudo");
    const three = render(everything);
    expect(three).toContain("Saldo: Sem saldo, editar");
    expect(three).toContain("Custo: Desconhecido, editar");
    expect(three).toContain("Arquivados: Incluir, editar");
    expect(three).toContain("Limpar tudo");
    expect(three.indexOf("Saldo:")).toBeLessThan(three.indexOf("Custo:"));
    expect(three.indexOf("Custo:")).toBeLessThan(three.indexOf("Arquivados:"));
  });

  it("a busca não é filtro da barra: ela fica fora das pílulas", () => {
    const searching = { ...defaultStockFilters, query: "camiseta" };
    expect(render(searching)).not.toContain("filter-pill");
    expect(stockRules(searching)).toEqual([]);
  });

  it("o saldo lista só o que estreita: 'Todas' não é filtro", () => {
    const balance = FIELDS.find((field) => field.id === "balance");
    expect(balance?.type === "select" && balance.options).toEqual([
      { label: "Com saldo", value: "with_stock" },
      { label: "Sem saldo", value: "without_stock" },
    ]);
  });

  it("cada campo escolhido vira o filtro certo e o resto fica como estava", () => {
    expect(apply(defaultStockFilters, "balance", "with_stock")).toEqual({
      includeArchived: false,
      stock: "with_stock",
      unknownCost: false,
    });
    expect(apply(defaultStockFilters, "unknown-cost", "only")).toEqual({
      includeArchived: false,
      stock: "all",
      unknownCost: true,
    });
    expect(apply(everything, "archived", "include")).toEqual({
      includeArchived: true,
      stock: "without_stock",
      unknownCost: true,
    });
  });

  it("tirar uma pílula desliga só aquele filtro; limpar tudo desliga os três", () => {
    const without = (fieldId: string) =>
      stockFilters(removeRule(stockRules(everything), fieldId));
    expect(without("balance")).toEqual({
      includeArchived: true,
      stock: "all",
      unknownCost: true,
    });
    expect(without("unknown-cost")).toEqual({
      includeArchived: true,
      stock: "without_stock",
      unknownCost: false,
    });
    expect(without("archived")).toEqual({
      includeArchived: false,
      stock: "without_stock",
      unknownCost: true,
    });
    expect(stockFilters([])).toEqual({
      includeArchived: false,
      stock: "all",
      unknownCost: false,
    });
  });

  it("um valor que nenhuma opção tem não vira filtro", () => {
    expect(apply(defaultStockFilters, "balance", "all")).toEqual({
      includeArchived: false,
      stock: "all",
      unknownCost: false,
    });
    expect(
      visibleRules(FIELDS, [{ fieldId: "balance", value: "qualquer" }])
    ).toEqual([]);
  });

  it("sem conexão o custo fica desligado com o motivo; o resto continua", () => {
    const offline = stockFields(true);
    expect(offline.map((field) => field.disabledReason)).toEqual([
      undefined,
      "Só com conexão",
      undefined,
    ]);
    expect(stockFields(false).map((field) => field.disabledReason)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("sem conexão com o custo já marcado: a pílula diz o motivo e não se edita", () => {
    const html = render({ ...defaultStockFilters, unknownCost: true }, true);
    expect(html).toContain("Custo: Desconhecido");
    expect(html).not.toContain("Custo: Desconhecido, editar");
    expect(html).toContain("Só com conexão");
  });
});
