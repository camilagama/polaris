// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render as mount,
  screen,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FilterRule,
  removeRule,
  setRule,
  visibleRules,
} from "@/ui/filter-bar-model";
import {
  HistoryFiltersBar,
  HistoryPeriodPicker,
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
 * The history on the filter bar. What the shopkeeper does on the bar (apply a filter, take a pill out, clear
 * all) is the bar's own list of rules (`filter-bar-model.ts`, tested there) turned into
 * the filters the page keeps and the list request; that turn is checked here without a browser. The touches
 * themselves (menu, editors, targets, no `motion` on the phone) and the period of the title line are in
 * e2e/history-period.e2e.ts.
 */
const FIELDS = historyFields(false);
const PERIOD = { from: "2026-10-01", to: "2026-10-14" };

const apply = (
  filters: HistoryFilters,
  fieldId: string,
  value: FilterRule["value"] | null
) => ({
  ...filters,
  ...historyFilters(setRule(FIELDS, historyRules(filters), fieldId, value)),
});

const PERIOD_LABEL = /aria-label="Período: [^"]*, editar"/;
const PERIOD_BUTTON = /^Período/;
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
    const two = render({
      ...emptyHistoryFilters,
      customer: "Maria",
      status: "confirmed",
    });
    expect(two).toContain("Situação: Confirmadas, editar");
    expect(two).toContain("Cliente: Maria, editar");
    expect(two).toContain("Limpar tudo");
  });

  it("o período não é filtro da barra: está na linha do título", () => {
    const withPeriod = render({
      ...emptyHistoryFilters,
      from: PERIOD.from,
      to: PERIOD.to,
    });
    expect(withPeriod).not.toContain("Período");
    expect(withPeriod).not.toContain("filter-pill");
    expect(historyFields(false).map((field) => field.id)).toEqual([
      "status",
      "customer",
      "query",
    ]);
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
    filters = { ...filters, from: PERIOD.from, to: PERIOD.to };
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
    expect({
      ...emptyHistoryFilters,
      ...historyFilters([{ fieldId: "status", value: "nao-existe" }]),
    }).toEqual(emptyHistoryFilters);
    expect(apply(emptyHistoryFilters, "status", "nao-existe")).toEqual(
      emptyHistoryFilters
    );
    expect(apply(emptyHistoryFilters, "customer", "   ")).toEqual(
      emptyHistoryFilters
    );
  });

  it("remover a pílula limpa só aquele filtro, e o período fica como está", () => {
    const filters: HistoryFilters = {
      customer: "Maria",
      from: PERIOD.from,
      query: "",
      status: "cancelled",
      to: PERIOD.to,
    };
    const without = {
      ...filters,
      ...historyFilters(removeRule(historyRules(filters), "customer")),
    };
    expect(without).toEqual({ ...filters, customer: "" });
    expect(historyListRequest("org", without, 0)).toMatchObject({
      occurredFrom: PERIOD.from,
      occurredTo: PERIOD.to,
    });
  });

  it("limpar tudo (a lista da barra vazia) zera os três filtros da barra, e a consulta sai sem filtro", () => {
    expect(historyFilters([])).toEqual({
      customer: "",
      query: "",
      status: "",
    });
    expect(
      historyListRequest(
        "org",
        { ...emptyHistoryFilters, ...historyFilters([]) },
        0
      )
    ).toEqual({
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

  it("sem conexão o Produto vendido já aplicado continua nos filtros quando outro muda", () => {
    const filters = apply(
      { ...emptyHistoryFilters, query: "camiseta" },
      "status",
      "cancelled"
    );
    expect(filters).toMatchObject({ query: "camiseta", status: "cancelled" });
  });
});

describe("o período da linha do título", () => {
  const renderPeriod = (filters: HistoryFilters) =>
    renderToStaticMarkup(
      <HistoryPeriodPicker filters={filters} onChange={noop} />
    );

  it("sem período: 'Período, Escolher período'; com as duas pontas: o nome termina em editar", () => {
    expect(renderPeriod(emptyHistoryFilters)).toContain(
      'aria-label="Período, Escolher período"'
    );
    expect(
      renderPeriod({ ...emptyHistoryFilters, from: PERIOD.from, to: PERIOD.to })
    ).toMatch(PERIOD_LABEL);
  });

  it("uma ponta só (só um endereço a traria) vale como sem período", () => {
    expect(
      renderPeriod({ ...emptyHistoryFilters, from: PERIOD.from })
    ).toContain('aria-label="Período, Escolher período"');
  });
});

describe("os atalhos do período do Histórico chegam como as duas datas da consulta", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const pickShortcut = (now: Date, label: string) => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const onChange = vi.fn();
    mount(
      <HistoryPeriodPicker filters={emptyHistoryFilters} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("button", { name: PERIOD_BUTTON }));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onChange).toHaveBeenCalledTimes(1);
    return onChange.mock.calls[0]?.[0];
  };

  const atNoon = (year: number, month: number, day: number) =>
    new Date(year, month - 1, day, 12);

  it.each([
    {
      from: "2026-10-14",
      label: "Hoje",
      now: atNoon(2026, 10, 14),
      to: "2026-10-14",
    },
    {
      from: "2026-10-08",
      label: "7 dias",
      now: atNoon(2026, 10, 14),
      to: "2026-10-14",
    },
    {
      from: "2026-02-25",
      label: "7 dias",
      now: atNoon(2026, 3, 3),
      to: "2026-03-03",
    },
    {
      from: "2026-10-01",
      label: "Este mês",
      now: atNoon(2026, 10, 14),
      to: "2026-10-14",
    },
    {
      from: "2026-10-01",
      label: "Este mês",
      now: atNoon(2026, 10, 31),
      to: "2026-10-31",
    },
    {
      from: "2026-09-01",
      label: "Mês passado",
      now: atNoon(2026, 10, 14),
      to: "2026-09-30",
    },
    {
      from: "2025-12-01",
      label: "Mês passado",
      now: atNoon(2026, 1, 5),
      to: "2025-12-31",
    },
    {
      from: "2028-02-01",
      label: "Mês passado",
      now: atNoon(2028, 3, 10),
      to: "2028-02-29",
    },
  ])("$label: de $from a $to", ({ from, label, now, to }) => {
    expect(pickShortcut(now, label)).toEqual({ from, to });
  });

  it("perto da meia-noite o dia é o do relógio do aparelho (com TZ=America/Sao_Paulo, não o do UTC)", () => {
    const late = new Date(2026, 9, 31, 23, 50);
    expect(pickShortcut(late, "Hoje")).toEqual({
      from: "2026-10-31",
      to: "2026-10-31",
    });
    cleanup();
    expect(pickShortcut(late, "Este mês")).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    cleanup();
    expect(pickShortcut(late, "Mês passado")).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    cleanup();
    const justAfter = new Date(2026, 10, 1, 0, 10);
    expect(pickShortcut(justAfter, "Mês passado")).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    cleanup();
    expect(pickShortcut(justAfter, "7 dias")).toEqual({
      from: "2026-10-26",
      to: "2026-11-01",
    });
  });
});
