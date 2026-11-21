import type {
  ExpenseCategoryReadModel,
  ExpenseCategoryTotalReadModel,
} from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpenseByCategory, showsCategoryBlock } from "./expense-by-category";
import type { ExpenseFilters, ExpenseListState } from "./use-expense-list";

const noop = () => undefined;
const ids = {
  aluguel: "0199c2d0-0000-7000-8000-00000000c001",
  frete: "0199c2d0-0000-7000-8000-00000000c002",
};
const category = (id: string, name: string): ExpenseCategoryReadModel => ({
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  groupKey: "operational",
  id,
  name,
  organizationId: "org",
  status: "active",
  systemKey: null,
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
});
const categories = [
  category(ids.aluguel, "Aluguel"),
  category(ids.frete, "Frete"),
];
const totals: ExpenseCategoryTotalReadModel[] = [
  { categoryId: ids.aluguel, count: 1, total: "1500.50" },
  { categoryId: ids.frete, count: 2, total: "499.50" },
];
const filters: ExpenseFilters = {
  categoryId: "",
  month: "2026-10",
  status: "active",
};
const state = (overrides: Partial<ExpenseListState>): ExpenseListState => ({
  count: 3,
  error: null,
  expenses: [],
  isLoading: false,
  isLoadingMore: false,
  nextCursor: null,
  total: "2000.00",
  totalsByCategory: totals,
  ...overrides,
});

function render(
  overrides: Partial<ExpenseListState> = {},
  chosen: ExpenseFilters = filters,
  list: ExpenseCategoryReadModel[] = categories
) {
  return renderToStaticMarkup(
    <ExpenseByCategory
      categories={list}
      filters={chosen}
      onPick={noop}
      state={state(overrides)}
    />
  );
}

describe("ExpenseByCategory", () => {
  it("writes the name, the share and the amount of each line, and the bar is a drawing only", () => {
    const html = render();
    expect(html).toContain('role="heading"');
    expect(html).toContain("Por categoria");
    expect(html).toContain("Aluguel");
    expect(html).toContain("75%");
    expect(html).toContain("1.500,50");
    expect(html).toContain("Frete");
    expect(html).toContain("25%");
    expect(html).toContain("499,50");
    const tracks = html.match(/<div aria-hidden="true"[^>]*data-share-track/g);
    expect(tracks).toHaveLength(2);
  });

  it("makes a line with a category a button whose name starts with Filtrar por <categoria> and holds the share and the amount, with at least 44 px of height", () => {
    const html = render();
    expect(html).toContain('<span class="sr-only">Filtrar por </span>Aluguel');
    expect(html).toContain('<span class="sr-only">Filtrar por </span>Frete');
    expect(html).not.toContain(`aria-label="`);
    expect(html).not.toContain("aria-describedby");
    expect(html).toContain("min-h-11");
    expect(html).toContain("focus-ring");
  });

  it("leaves Outras and Sem categoria as plain lines: there is no category to filter by", () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      category(`0199c2d0-0000-7000-8000-00000000d00${index}`, `Cat ${index}`)
    );
    const html = render(
      {
        total: "2800.00",
        totalsByCategory: many.map((item, index) => ({
          categoryId: item.id,
          count: 1,
          total: `${(7 - index) * 100}.00`,
        })),
      },
      filters,
      many
    );
    expect(html).toContain("Outras (2)");
    expect(html).not.toContain("Filtrar por Outras");
    expect(html.match(/<button/g)).toHaveLength(5);
  });

  it("holds its place with lines of skeleton while the first read is open", () => {
    const html = render({ isLoading: true, totalsByCategory: undefined });
    expect(html).toContain("data-share-skeleton");
    expect(html).not.toContain("<button");
  });

  it.each([
    ["a category on the bar", { ...filters, categoryId: ids.aluguel }],
    ["the voided ones", { ...filters, status: "voided" as const }],
  ])("is not on the screen with %s", (_name, chosen) => {
    expect(render({}, chosen)).toBe("");
    expect(
      render({ isLoading: true, totalsByCategory: undefined }, chosen)
    ).toBe("");
  });

  it("is not on the screen with fewer than two categories in the month", () => {
    expect(
      render({
        total: "1500.50",
        totalsByCategory: [totals[0] as ExpenseCategoryTotalReadModel],
      })
    ).toBe("");
  });

  it("is not on the screen when the answer has no totalsByCategory (an old server, a copy of the device)", () => {
    expect(render({ totalsByCategory: undefined })).toBe("");
  });

  it("is not on the screen when the read failed or when the lines do not add up to the total", () => {
    expect(render({ error: "Falhou." })).toBe("");
    expect(render({ total: "2000.01" })).toBe("");
  });
});

describe("showsCategoryBlock", () => {
  it("is for the active expenses with no category chosen", () => {
    expect(showsCategoryBlock(filters)).toBe(true);
    expect(showsCategoryBlock({ ...filters, categoryId: ids.frete })).toBe(
      false
    );
    expect(showsCategoryBlock({ ...filters, status: "voided" })).toBe(false);
  });
});
