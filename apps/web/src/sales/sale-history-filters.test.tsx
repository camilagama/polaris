import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { presetRange } from "@/ui/date-values";
import {
  type FilterRule,
  removeRule,
  setRule,
  visibleRules,
} from "@/ui/filter-bar-model";
import {
  HistoryFiltersBar,
  historyFields,
  historyFilters,
  historyRules,
} from "./sale-history-filters";
import {
  emptyHistoryFilters,
  type HistoryFilters,
  historyListRequest,
} from "./sale-history-model";

/**
 * The history on the filter bar (t391). What the shopkeeper does on the bar (apply a filter, take a pill out, clear
 * all, pick a shortcut of the period) is the bar's own list of rules (`filter-bar-model.ts`, tested there) turned into
 * the filters the page keeps and the list request; that turn is checked here without a browser. The touches
 * themselves (menu, editors, targets, no `motion` on the phone) are in e2e/history-period.e2e.ts.
 */
const FIELDS = historyFields(false);
const TODAY = "2026-10-14";
const PERIOD = { from: "2026-10-01", to: "2026-10-14" };

const apply = (
  filters: HistoryFilters,
  fieldId: string,
  value: FilterRule["value"] | null
) => historyFilters(setRule(FIELDS, historyRules(filters), fieldId, value));

const PERIOD_PILL = /Período: [^"]*, editar/;
const noop = () => undefined;
const render = (filters: HistoryFilters, offline = false) =>
  renderToStaticMarkup(
    <HistoryFiltersBar filters={filters} offline={offline} onChange={noop} />
  );

describe("a barra de filtros do Histórico", () => {
  it("sem filtro: só o 'Filtrar', sem pílula e sem 'Limpar tudo'", () => {
    const html = render(emptyHistoryFilters);
    expect(html).toContain('aria-label="Filtrar vendas"');
    expect(html).toContain(">Filtrar</button>");
    expect(html).not.toContain("filter-pill");
    expect(html).not.toContain("Limpar tudo");
    expect(html).not.toContain("Limpar filtros");
    expect(html).not.toContain("collapsible");
  });

  it("com filtros: uma pílula por filtro, com o valor, e 'Limpar tudo' a partir de duas", () => {
    const one = render({ ...emptyHistoryFilters, status: "cancelled" });
    expect(one).toContain("Situação: Canceladas, editar");
    expect(one).not.toContain("Limpar tudo");
    const three = render({
      ...emptyHistoryFilters,
      customer: "Maria",
      from: PERIOD.from,
      status: "confirmed",
      to: PERIOD.to,
    });
    expect(three).toContain("Situação: Confirmadas, editar");
    expect(three).toContain("Cliente: Maria, editar");
    expect(three).toMatch(PERIOD_PILL);
    expect(three).toContain("Limpar tudo");
  });

  it('o campo da consulta por item se chama Produto vendido, com "Nome do produto" no editor', () => {
    const field = historyFields(false).find((entry) => entry.id === "query");
    expect(field).toMatchObject({
      label: "Produto vendido",
      placeholder: "Nome do produto",
    });
  });

  it("sem conexão o Produto vendido fica na lista com o motivo, e a pílula dela só sai", () => {
    const html = render({ ...emptyHistoryFilters, query: "camiseta" }, true);
    expect(html).toContain("Só com conexão");
    expect(html).toContain("Produto vendido: camiseta");
    expect(html).not.toContain("Produto vendido: camiseta, editar");
    expect(html).toContain("Tirar o filtro Produto vendido");
  });
});

describe("os filtros que a página guarda a partir da lista da barra", () => {
  it("aplicar: cada campo muda só o seu filtro, e a consulta leva só o que está em uso", () => {
    let filters = apply(emptyHistoryFilters, "status", "with_returns");
    filters = apply(filters, "customer", "  Maria ");
    filters = apply(filters, "query", "camiseta");
    filters = apply(filters, "period", PERIOD);
    expect(filters).toEqual({
      customer: "Maria",
      from: PERIOD.from,
      query: "camiseta",
      status: "with_returns",
      to: PERIOD.to,
    });
    expect(historyListRequest("org", filters, 0)).toMatchObject({
      customerQuery: "Maria",
      occurredFrom: PERIOD.from,
      occurredTo: PERIOD.to,
      query: "camiseta",
      status: "with_returns",
    });
  });

  it("um valor que a página não conhece ou um texto vazio não vira filtro", () => {
    expect(
      historyFilters([{ fieldId: "status", value: "nao-existe" }])
    ).toEqual(emptyHistoryFilters);
    expect(apply(emptyHistoryFilters, "status", "nao-existe")).toEqual(
      emptyHistoryFilters
    );
    expect(apply(emptyHistoryFilters, "customer", "   ")).toEqual(
      emptyHistoryFilters
    );
  });

  it("remover a pílula limpa só aquele filtro (o período, as duas pontas)", () => {
    const filters: HistoryFilters = {
      customer: "Maria",
      from: PERIOD.from,
      query: "",
      status: "cancelled",
      to: PERIOD.to,
    };
    const without = historyFilters(removeRule(historyRules(filters), "period"));
    expect(without).toEqual({ ...filters, from: "", to: "" });
    expect(historyListRequest("org", without, 0)).not.toHaveProperty(
      "occurredFrom"
    );
  });

  it("limpar tudo (a lista da barra vazia) volta ao estado vazio, e a consulta sai sem filtro", () => {
    expect(historyFilters([])).toEqual(emptyHistoryFilters);
    expect(historyListRequest("org", historyFilters([]), 0)).toEqual({
      limit: 50,
      offset: 0,
      organizationId: "org",
    });
  });

  it("a barra mostra uma pílula por filtro em uso e nenhuma para o que está vazio", () => {
    const filters: HistoryFilters = {
      ...emptyHistoryFilters,
      customer: "Maria",
      status: "cancelled",
    };
    const shown = visibleRules(FIELDS, historyRules(filters));
    expect(shown.map((entry) => entry.field.id)).toEqual([
      "status",
      "customer",
    ]);
    expect(historyRules(emptyHistoryFilters)).toEqual([]);
  });

  it("os atalhos do período chegam como as duas datas da consulta", () => {
    const sevenDays = presetRange("7-dias", TODAY);
    const filters = apply(emptyHistoryFilters, "period", sevenDays);
    expect(filters).toMatchObject({ from: "2026-10-08", to: TODAY });
    const lastMonth = presetRange("mes-passado", TODAY);
    expect(apply(filters, "period", lastMonth)).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("sem conexão o Produto vendido já aplicado continua nos filtros quando outro muda", () => {
    const filters = apply(
      { ...emptyHistoryFilters, query: "camiseta" },
      "status",
      "cancelled"
    );
    expect(filters).toMatchObject({ query: "camiseta", status: "cancelled" });
  });
});
