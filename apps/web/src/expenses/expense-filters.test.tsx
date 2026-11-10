import type { ExpenseCategoryReadModel } from "@polaris/contracts";
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
) => expenseFilters(setRule(FIELDS, expenseRules(filters), fieldId, value));

describe("a barra de filtros de Despesas", () => {
  it("abre em Ativas, sem pílula: só o 'Filtrar' e o mês na mesma linha", () => {
    const html = renderToStaticMarkup(
      <ExpenseFiltersBar
        categories={CATEGORIES}
        filters={{ categoryId: "", status: "active" }}
        leading={<span>Outubro de 2026</span>}
        onChange={noop}
      />
    );
    expect(html).toContain('aria-label="Filtrar despesas"');
    expect(html.indexOf("Outubro de 2026")).toBeLessThan(
      html.indexOf(">Filtrar</button>")
    );
    expect(html).not.toContain("filter-pill");
    expect(html).not.toContain("Limpar tudo");
  });

  it("Anuladas e uma categoria são uma pílula cada, e 'Limpar tudo' vem com as duas", () => {
    const one = renderToStaticMarkup(
      <ExpenseFiltersBar
        categories={CATEGORIES}
        filters={{ categoryId: "", status: "voided" }}
        leading={null}
        onChange={noop}
      />
    );
    expect(one).toContain("Situação: Anuladas, editar");
    expect(one).not.toContain("Limpar tudo");
    const two = renderToStaticMarkup(
      <ExpenseFiltersBar
        categories={CATEGORIES}
        filters={{ categoryId: "c2", status: "voided" }}
        leading={null}
        onChange={noop}
      />
    );
    expect(two).toContain("Categoria: Marketing, editar");
    expect(two).toContain("Limpar tudo");
  });

  it("os campos listam as categorias na ordem dos grupos, a arquivada dita, e Ativas e Anuladas", () => {
    const [categoryField, statusField] = FIELDS;
    expect(categoryField?.type === "select" && categoryField.options).toEqual([
      { label: "Marketing", value: "c2" },
      { label: "Aluguel", value: "c1" },
      { label: "Antiga (arquivada)", value: "c3" },
    ]);
    expect(statusField?.type === "select" && statusField.options).toEqual([
      { label: "Ativas", value: "active" },
      { label: "Anuladas", value: "voided" },
    ]);
  });

  it("escolher e tirar filtros devolve os dois filtros da página, sempre escritos", () => {
    const open = { categoryId: "", status: "active" } as const;
    expect(apply(open, "status", "voided")).toEqual({
      categoryId: "",
      status: "voided",
    });
    expect(apply(open, "category", "c2")).toEqual({
      categoryId: "c2",
      status: "active",
    });
    expect(
      apply({ categoryId: "c2", status: "voided" }, "status", null)
    ).toEqual({ categoryId: "c2", status: "active" });
    expect(
      apply({ categoryId: "c2", status: "voided" }, "category", null)
    ).toEqual({ categoryId: "", status: "voided" });
    expect(
      apply({ categoryId: "", status: "voided" }, "status", "active")
    ).toEqual(open);
  });

  it("Ativas é o estado de abertura, sem pílula; uma categoria que a lista não tem não vira pílula", () => {
    expect(expenseRules({ categoryId: "", status: "active" })).toEqual([]);
    const shown = visibleRules(
      FIELDS,
      expenseRules({ categoryId: "gone", status: "active" })
    );
    expect(shown).toEqual([]);
  });
});
