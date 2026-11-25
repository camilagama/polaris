import type { ExpenseReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EMPTY_TITLE_MAX } from "@/ui/empty-state";
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
  /<button[^>]*aria-label="Mês de competência, Outubro de 2026"[^>]*aria-haspopup="dialog"[^>]*><svg.*<\/svg>Outubro de 2026<\/button>/;
const VOIDING_TEXT = /Anulando…/g;
const VOIDING_STATUS = /<p[^>]*role="status"[^>]*>Anulando…<\/p>/;
const RESTORING_TEXT = /Reativando…/g;
const AMOUNT = /R\$\s1\.500,50/;

const rowOf = (html: string, id: string): string => {
  const row = html
    .split("<li ")
    .slice(1)
    .map((chunk) => chunk.split("</li>")[0] ?? "")
    .find((chunk) => chunk.includes(`data-expense-id="${id}"`));
  if (row === undefined) {
    throw new Error(`no row with data-expense-id="${id}" in the list`);
  }
  return row;
};

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
  categoryId = filters.categoryId,
  busyKey: string | null = null
) =>
  renderToStaticMarkup(
    <ExpenseList
      busyKey={busyKey}
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
  it("says it is loading on the first read, as a status, inside the frame with its title", () => {
    const html = list(state({ isLoading: true }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Carregando…");
    expect(html).toContain("Despesas do período");
    expect(html).toContain('data-state="loading"');
  });

  it("the loading line is for the screen reader only, the rows are skeletons that no one reads, the count is not drawn and the empty list keeps the frame", () => {
    const loading = list(state({ isLoading: true }));
    expect(loading).toContain(
      '<p class="sr-only" role="status">Carregando…</p>'
    );
    expect(loading).toContain('data-slot="skeleton"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain("0 despesas");
    const empty = list(state({}));
    expect(empty).not.toContain("Carregando…");
    expect(empty).toContain("data-empty-state");
    expect(empty).toContain('data-state="filtered-empty"');
  });

  it("a failed read says why and offers to read again, never the empty list", () => {
    const html = list(state({ error: "Sem conexão com o servidor." }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Tentar novamente");
    expect(html).not.toContain("Nenhuma despesa");
    expect(html).not.toContain("data-list-block");
    expect(html).not.toContain("data-list-total");
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

  it('Anular is not a button of the row: the row has Editar and the "…" menu that holds it', () => {
    const html = list(state({ count: 1, expenses: [expense({})] }));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.find((tag) => tag.includes("Editar despesa"))).toContain(
      "border-border"
    );
    expect(
      buttons.find((tag) => tag.includes("Mais ações para Aluguel de outubro"))
    ).toContain('aria-haspopup="menu"');
    expect(html).not.toContain("Anular despesa");
    expect(html).not.toContain("text-destructive");
  });

  it("a voided expense is read only, with Reativar; an active one has Editar and the menu", () => {
    const active = list(state({ count: 1, expenses: [expense({})] }));
    expect(active).toContain('aria-label="Editar despesa Aluguel de outubro"');
    expect(active).toContain('aria-label="Mais ações para Aluguel de outubro"');
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
    expect(voided).not.toContain("Mais ações");
  });

  it("saving the edit of a row does not say Anulando… on any row", () => {
    const html = list(
      state({
        count: 2,
        expenses: [expense({}), expense({ id: "e2" })],
      }),
      "active",
      "",
      "save:e1"
    );
    expect(html).not.toContain("Anulando");
  });

  describe.each([
    ["e1, e2", [{}, { description: "Energia", id: "e2" }]],
    ["e2, e1", [{ description: "Energia", id: "e2" }, {}]],
  ] as const)("with the rows in the order %s", (_order, rows) => {
    it("voiding says Anulando… as a status on that row only", () => {
      const html = list(
        state({ count: 2, expenses: rows.map((row) => expense(row)) }),
        "active",
        "",
        "void:e1"
      );
      expect(html.match(VOIDING_TEXT)).toHaveLength(1);
      expect(html).toMatch(VOIDING_STATUS);
      expect(rowOf(html, "e1"), "row e1 is the one being voided").toContain(
        "Anulando…"
      );
      expect(rowOf(html, "e2"), "row e2 is not being voided").not.toContain(
        "Anulando…"
      );
    });

    it("restoring says Reativando… on the voided row only", () => {
      const html = list(
        state({
          count: 2,
          expenses: rows.map((row) => expense({ ...row, status: "voided" })),
        }),
        "voided",
        "",
        "restore:e1"
      );
      expect(html.match(RESTORING_TEXT)).toHaveLength(1);
      expect(rowOf(html, "e1"), "row e1 is the one being restored").toContain(
        "Reativando…"
      );
      expect(rowOf(html, "e2"), "row e2 is not being restored").not.toContain(
        "Reativando…"
      );
      expect(html).not.toContain("Anulando");
    });
  });

  it("a generated occurrence carries the Recorrente badge", () => {
    const html = list(
      state({ count: 1, expenses: [expense({ recurringRuleId: "r1" })] })
    );
    expect(html).toContain("Recorrente");
  });
});

describe("the total of the period", () => {
  it("is the first line of the panel and the count is the frame's, beside the title; the month is only said to a screen reader", () => {
    const html = list(
      state({
        count: 3,
        expenses: [expense({})],
        total: "4562.00",
      })
    );
    expect(html).toContain("Total do período");
    expect(html).toContain('data-money-number="">4.562<');
    expect(html).toContain('<span class="sr-only"> em outubro de 2026</span>');
    expect(html).toContain('data-list-count="">3 despesas</p>');
    expect(html.indexOf("Total do período")).toBeLessThan(
      html.indexOf("data-list-block-row")
    );
    expect(html.indexOf("data-list-block-row")).toBeLessThan(
      html.indexOf("data-list-total")
    );
  });

  it("says anuladas in the label when the status is Anuladas", () => {
    const html = list(
      state({ count: 1, expenses: [expense({ status: "voided" })] }),
      "voided"
    );
    expect(html).toContain("Total do período (anuladas)");
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

  it("while the first page loads it is a skeleton, and after a failed read there is no total at all, never a zero", () => {
    expect(list(state({ isLoading: true }))).toContain(
      "data-list-total-skeleton"
    );
    const failed = list(state({ error: "Falhou." }));
    expect(failed).not.toContain("data-list-total");
    expect(failed).not.toContain("R$ 0,00");
  });
});
