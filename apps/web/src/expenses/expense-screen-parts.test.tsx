import type { ExpenseReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EMPTY_TITLE_MAX } from "@/ui/empty-state";
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
  /<button[^>]*aria-label="Mês de competência, Outubro de 2026"[^>]*aria-haspopup="dialog"[^>]*><svg.*<\/svg>Outubro de 2026<\/button>/;
const AMOUNT = /R\$\s1\.500,50/;

describe("MonthPicker", () => {
  it("says the month in words in a button that opens the grid, with no arrows beside it and no native month field", () => {
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
    expect(html).not.toContain('aria-label="Mês anterior"');
    expect(html).not.toContain('aria-label="Próximo mês"');
    expect(html).not.toContain('type="month"');
    expect(html).toContain('for="m"');
  });

  it.each([
    ["0000-01", "Janeiro de 0"],
    ["2026-03", "Março de 2026"],
    ["2026-12", "Dezembro de 2026"],
    ["9999-12", "Dezembro de 9999"],
  ])(
    "writes the month %s in words as %s, the first and the last one the list can read included",
    (month, words) => {
      const html = renderToStaticMarkup(
        <MonthPicker
          currentMonth="2026-10"
          id="m"
          label="Mês"
          month={month}
          onChange={noop}
        />
      );
      expect(html).toContain(`${words}</button>`);
      expect(html).toContain(`aria-label="Mês, ${words}"`);
    }
  );
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
const list = (
  listState: ExpenseListState,
  status = filters.status,
  categoryId = filters.categoryId
) =>
  renderToStaticMarkup(
    <ExpenseList
      busyKey={null}
      filters={{ ...filters, categoryId, status }}
      onClearFilters={noop}
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

const EMPTY_TITLE = /data-empty-title="" id="[^"]*">([^<]*)</;

describe("ExpenseList", () => {
  it("says it is loading on the first read, as a status", () => {
    const html = list(state({ isLoading: true }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Carregando despesas…");
  });

  it("the loading line is for the screen reader only, three skeleton lines are drawn, and the empty list stays drawn", () => {
    expect(list(state({ isLoading: true }))).toContain(
      '<span class="sr-only">Carregando despesas…</span>'
    );
    const loading = list(state({ isLoading: true }));
    expect(loading.match(/data-slot="skeleton"/g)).toHaveLength(3);
    expect(loading.match(/aria-hidden="true"/g)).toHaveLength(3);
    expect(loading).toContain('aria-busy="true"');
    const empty = list(state({}));
    expect(empty).not.toContain("sr-only");
    expect(empty).toContain("data-empty-state");
  });

  it("a failed read says why and offers to read again, never the empty list", () => {
    const html = list(state({ error: "Sem conexão com o servidor." }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Tentar novamente");
    expect(html).not.toContain("Nenhuma despesa");
  });

  it("the empty period is a short sentence only: the button that creates is the title line's, and no phrase names it", () => {
    const html = list(state({}));
    const title = EMPTY_TITLE.exec(html)?.[1];
    expect(title).toBe("Nenhuma despesa neste período.");
    expect(title?.length).toBeLessThanOrEqual(EMPTY_TITLE_MAX);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Nova despesa");
    expect(html).not.toContain("Toque em");
    expect(html).not.toContain("para registrar a primeira");
  });

  it("the empty list under a category says so and offers Limpar filtros, never a button to create", () => {
    for (const html of [
      list(state({}), "active", "c1"),
      list(state({}), "voided", "c1"),
    ]) {
      expect(EMPTY_TITLE.exec(html)?.[1]).toBe(
        "Nenhuma despesa encontrada com estes filtros."
      );
      expect(html).toContain("Limpar filtros");
      expect(html).not.toContain("Nova despesa");
    }
    expect(list(state({}))).not.toContain("Limpar filtros");
  });

  it("the empty voided list says so with no button: the segmented, one touch away, is how to leave it", () => {
    const html = list(state({}), "voided");
    expect(EMPTY_TITLE.exec(html)?.[1]).toBe(
      "Nenhuma despesa anulada neste período."
    );
    expect(html).not.toContain("<button");
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
    expect(html).toContain('role="status"');
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

  it("says there is more while another page is pending, and stops saying it after the last page", () => {
    const rows = [expense({ id: "e1" }), expense({ id: "e2" })];
    const pending = foot(list(state({ expenses: rows, nextCursor: "c1" })));
    expect(pending).toContain("2 despesas · há mais");
    const last = foot(list(state({ expenses: rows, nextCursor: null })));
    expect(last).toContain("2 despesas");
    expect(last).not.toContain("há mais");
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
