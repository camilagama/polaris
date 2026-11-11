import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setRule, visibleRules } from "@/ui/filter-bar-model";
import {
  ExpenseFiltersBar,
  expenseFields,
  expenseFilters,
  expenseRules,
} from "./expense-filters";

const category = (
  overrides: Partial<ExpenseCategoryReadModel>
): ExpenseCategoryReadModel => ({
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  groupKey: "operational",
  id: "c1",
  name: "Aluguel",
  organizationId: "org",
  status: "active",
  systemKey: null,
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
  ...overrides,
});

const CATEGORIES = [
  category({ id: "c1", name: "Aluguel" }),
  category({ id: "c2", name: "Marketing", groupKey: "commercial" }),
  category({ id: "c3", name: "Antiga", status: "archived" }),
];
const FIELDS = expenseFields(CATEGORIES);
const noop = () => undefined;

const apply = (
  filters: Parameters<typeof expenseRules>[0],
  fieldId: string,
  value: string | null
) =>
  expenseFilters(
    setRule(FIELDS, expenseRules(filters), fieldId, value),
    filters.status
  );

const render = (
  filters: Parameters<typeof expenseRules>[0],
  leading: ReactNode = null
) =>
  renderToStaticMarkup(
    <ExpenseFiltersBar
      categories={CATEGORIES}
      filters={filters}
      leading={leading}
      onChange={noop}
    />
  );

const pressed = (html: string, status: string) =>
  new RegExp(`aria-pressed="true"[^>]*data-status="${status}"`).test(html);

describe("a barra de filtros de Despesas", () => {
  it("o mês, Ativas | Anuladas e 'Filtrar' dividem a primeira linha, nessa ordem, sem pílula", () => {
    const html = render(
      { categoryId: "", status: "active" },
      <span>Outubro de 2026</span>
    );
    expect(html).toContain('aria-label="Filtrar despesas"');
    const month = html.indexOf("Outubro de 2026");
    const segmented = html.indexOf('aria-label="Situação"');
    const filter = html.indexOf('data-slot="filter-add"');
    expect(month).toBeLessThan(segmented);
    expect(segmented).toBeLessThan(filter);
    expect(html).not.toContain("filter-pill");
    expect(html).not.toContain("Limpar tudo");
  });

  it("o segmentado marca a situação atual: Ativas na abertura, Anuladas depois do toque", () => {
    const open = render({ categoryId: "", status: "active" });
    expect(pressed(open, "active")).toBe(true);
    expect(pressed(open, "voided")).toBe(false);
    const voided = render({ categoryId: "", status: "voided" });
    expect(pressed(voided, "voided")).toBe(true);
    expect(pressed(voided, "active")).toBe(false);
    expect(voided).not.toContain("filter-pill");
  });

  it("só a categoria é pílula, e o menu 'Filtrar' não lista Situação", () => {
    const html = render({ categoryId: "c2", status: "voided" });
    expect(html).toContain("Categoria: Marketing, editar");
    expect(html).not.toContain("Situação: ");
    expect(html).not.toContain("Limpar tudo");
    expect(FIELDS.map((field) => field.label)).toEqual(["Categoria"]);
  });

  it("os campos listam as categorias na ordem dos grupos e a arquivada dita", () => {
    const [categoryField] = FIELDS;
    expect(categoryField?.type === "select" && categoryField.options).toEqual([
      { label: "Marketing", value: "c2" },
      { label: "Aluguel", value: "c1" },
      { label: "Antiga (arquivada)", value: "c3" },
    ]);
  });

  it("escolher e tirar a categoria devolve os dois filtros da página, com a situação como estava", () => {
    const open = { categoryId: "", status: "active" } as const;
    expect(apply(open, "category", "c2")).toEqual({
      categoryId: "c2",
      status: "active",
    });
    expect(
      apply({ categoryId: "c2", status: "voided" }, "category", null)
    ).toEqual({ categoryId: "", status: "voided" });
  });

  it("sem categoria não há regra, qualquer que seja a situação; uma categoria que a lista não tem não vira pílula", () => {
    expect(expenseRules({ categoryId: "", status: "active" })).toEqual([]);
    expect(expenseRules({ categoryId: "", status: "voided" })).toEqual([]);
    const shown = visibleRules(
      FIELDS,
      expenseRules({ categoryId: "gone", status: "active" })
    );
    expect(shown).toEqual([]);
  });
});
