import type { ExpenseReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpenseList } from "./expense-list";
import { MonthPicker } from "./month-picker";
import type { ExpenseFilters, ExpenseListState } from "./use-expense-list";

/**
 * The parts of the expenses screen drawn without a browser: the month picker says the month in words in one button
 * that opens the grid; the list says loading, empty and a failed read apart. The grid, its keys, the select popups and
 * the closed sections are proved in the browser (e2e/expenses.e2e.ts).
 */
const noop = () => undefined;
const MONTH_BUTTON =
  /<button[^>]*aria-label="Mês de competência, Outubro de 2026"[^>]*aria-haspopup="dialog"[^>]*>Outubro de 2026<\/button>/;
const AMOUNT = /R\$\s1\.500,50/;

describe("MonthPicker", () => {
  it("says the month in words in a button that opens the grid, between the two arrows, with no native month field", () => {
    const html = renderToStaticMarkup(
      <MonthPicker
        currentMonth="2026-10"
        id="m"
        label="Mês de competência"
        month="2026-10"
        onChange={noop}
      />
    );
    expect(html).toMatch(MONTH_BUTTON);
    expect(html).toContain('aria-label="Mês anterior"');
    expect(html).toContain('aria-label="Próximo mês"');
    expect(html).not.toContain('type="month"');
    // the group is named by the label of the field
    expect(html).toContain('aria-labelledby="m-label"');
  });

  it("turns off the arrow past the first month there is", () => {
    const html = renderToStaticMarkup(
      <MonthPicker
        currentMonth="2026-10"
        id="m"
        label="Mês"
        month="0000-01"
        onChange={noop}
      />
    );
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    const previous = buttons.find((tag) => tag.includes("Mês anterior"));
    const next = buttons.find((tag) => tag.includes("Próximo mês"));
    expect(previous).toContain('disabled=""');
    expect(next).toBeDefined();
    expect(next).not.toContain('disabled=""');
  });
});

const filters: ExpenseFilters = {
  categoryId: "",
  month: "2026-10",
  status: "active",
};
const state = (overrides: Partial<ExpenseListState>): ExpenseListState => ({
  count: 0,
  error: null,
  expenses: [],
  isLoading: false,
  isLoadingMore: false,
  nextCursor: null,
  total: "0.00",
  ...overrides,
});
const list = (listState: ExpenseListState, status = filters.status) =>
  renderToStaticMarkup(
    <ExpenseList
      busyKey={null}
      filters={{ ...filters, status }}
      onEdit={noop}
      onLoadMore={noop}
      onRestore={noop}
      onRetry={noop}
      onVoid={noop}
      state={listState}
    />
  );

const expense = (overrides: Partial<ExpenseReadModel>): ExpenseReadModel => ({
  amount: "1500.50",
  categoryGroup: "operational",
  categoryId: "c1",
  categoryName: "Aluguel",
  competenceOn: "2026-10-01",
  createdAt: "2026-10-14T12:00:00.000Z",
  description: "Aluguel de outubro",
  id: "e1",
  organizationId: "org",
  payee: null,
  recurringRuleId: null,
  saleId: null,
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
  voidedAt: null,
  ...overrides,
});

describe("ExpenseList", () => {
  it("says it is loading on the first read, as a status", () => {
    const html = list(state({ isLoading: true }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Carregando despesas…");
  });

  it("a failed read says why and offers to read again, never the empty list", () => {
    const html = list(state({ error: "Sem conexão com o servidor." }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Tentar novamente");
    expect(html).not.toContain("Nenhuma despesa");
  });

  it("the empty month and the empty voided tab say different things", () => {
    expect(list(state({}))).toContain("Nenhuma despesa neste período.");
    expect(list(state({}), "voided")).toContain(
      "Nenhuma despesa anulada neste período."
    );
  });

  it("a voided expense is read only, with Reativar; an active one has Editar and Anular", () => {
    const active = list(state({ count: 1, expenses: [expense({})] }));
    expect(active).toContain('aria-label="Editar despesa Aluguel de outubro"');
    expect(active).toContain('aria-label="Anular despesa Aluguel de outubro"');
    expect(active).toMatch(AMOUNT);

    const voided = list(
      state({ count: 1, expenses: [expense({ status: "voided" })] }),
      "voided"
    );
    expect(voided).toContain("Anulada");
    expect(voided).toContain(
      'aria-label="Reativar despesa Aluguel de outubro"'
    );
    expect(voided).not.toContain("Editar despesa");
  });

  it("a generated occurrence carries the Recorrente badge", () => {
    const html = list(
      state({ count: 1, expenses: [expense({ recurringRuleId: "r1" })] })
    );
    expect(html).toContain("Recorrente");
  });
});
