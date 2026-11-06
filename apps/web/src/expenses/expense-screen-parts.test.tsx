import type { ExpenseReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpenseList, ExpenseSummary } from "./expense-list";
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
    expect(list(state({}))).toContain(
      "Nenhuma despesa neste período. Toque em Nova despesa para registrar a primeira."
    );
    expect(list(state({}), "voided")).toContain(
      "Nenhuma despesa anulada neste período."
    );
  });

  it("says category, date and payee on one line, with no group and no word Competência", () => {
    const html = list(
      state({
        count: 1,
        expenses: [expense({ payee: "Imobiliária Sol" })],
      })
    );
    expect(html).toContain("Aluguel · 01/10/2026 · Imobiliária Sol");
    expect(html).not.toContain("Competência");
    expect(html).not.toContain("Operacional");
  });

  it("Anular does not look like Editar, so the two are not the same press", () => {
    const html = list(state({ count: 1, expenses: [expense({})] }));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    const edit = buttons.find((tag) => tag.includes("Editar despesa")) ?? "";
    const cancel = buttons.find((tag) => tag.includes("Anular despesa")) ?? "";
    expect(edit).toContain("border-border");
    expect(cancel).not.toContain("border-border");
    expect(cancel).toContain("text-destructive");
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

describe("ExpenseSummary", () => {
  it("is the total with the count; the month is in the picker above and only said to a screen reader", () => {
    const html = renderToStaticMarkup(
      <ExpenseSummary
        filters={filters}
        state={state({ count: 3, total: "4562.00" })}
      />
    );
    expect(html).toContain("Total do período");
    expect(html).toContain("3 despesas");
    expect(html).toContain('<span class="sr-only"> em outubro de 2026</span>');
  });
});

describe("the total of the rows on the screen", () => {
  const foot = (html: string) => html.slice(html.indexOf("data-list-total"));

  it("sums the rows loaded in exact centavos, in tabular numerals, apart from the server total", () => {
    const html = list(
      state({
        count: 40,
        expenses: [
          expense({ amount: "0.10", id: "e1" }),
          expense({ amount: "0.20", id: "e2" }),
          expense({ amount: "1500.50", id: "e3" }),
        ],
        total: "99999.00",
      })
    );
    expect(foot(html)).toContain("Total na tela");
    expect(foot(html)).toContain("R$ 1.500,80");
    expect(foot(html)).toContain("3 despesas");
    expect(foot(html)).toContain("tabular-nums");
    expect(foot(html)).not.toContain("99.999");
  });

  it("is in the DOM with no rows, with the same lines (zero and no count text lost)", () => {
    const empty = list(state({}));
    expect(foot(empty)).toContain("R$ 0,00");
    expect(foot(empty)).toContain("0 despesas");
    expect(foot(empty)).toContain("min-h-5");
  });

  it("while the first page loads it is a dash, and after a failed read it is not a zero", () => {
    expect(foot(list(state({ isLoading: true })))).toContain("…");
    const failed = foot(list(state({ error: "Falhou." })));
    expect(failed).toContain("—");
    expect(failed).not.toContain("R$ 0,00");
  });
});
