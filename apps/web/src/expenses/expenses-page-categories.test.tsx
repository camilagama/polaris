// @vitest-environment happy-dom
import type {
  ExpenseCategoryReadModel,
  ExpenseReadModel,
} from "@polaris/contracts";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ListInput {
  cursor: string | null;
}

const list = vi.fn();
const listCategories = vi.fn();
const renameCategory = vi.fn();
const archiveCategory = vi.fn();
const createCategory = vi.fn();

vi.mock("../lib/orpc", () => ({
  orpcClient: {
    expense: {
      archiveCategory: (input: unknown) => archiveCategory(input),
      createCategory: (input: unknown) => createCategory(input),
      list: (input: ListInput) => list(input),
      listCategories: (input: unknown) => listCategories(input),
      renameCategory: (input: unknown) => renameCategory(input),
    },
  },
}));

import { StaticOrganizationProvider } from "../lib/current-organization";
import { ExpensesPage } from "./expenses-page";

const NOW = new Date("2026-11-15T15:00:00.000Z");
const organizationId = "org_1";
const FRETE = "f0000000-0000-4000-8000-000000000001";
const ALUGUEL = "a0000000-0000-4000-8000-000000000002";

function category(
  id: string,
  name: string,
  status: "active" | "archived" = "active"
): ExpenseCategoryReadModel {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    groupKey: "operational",
    id,
    name,
    organizationId,
    status,
    systemKey: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}

let names: Record<string, { archived: boolean; name: string }>;

function expense(
  index: number,
  categoryId: string,
  amount: string
): ExpenseReadModel {
  return {
    amount,
    categoryGroup: "operational",
    categoryId,
    categoryName: names[categoryId]?.name ?? "",
    competenceOn: "2026-11-10",
    createdAt: "2026-11-10T12:00:00.000Z",
    description: `Despesa ${index}`,
    id: `e000000${index}-0000-4000-8000-000000000000`,
    organizationId,
    payee: null,
    recurringRuleId: null,
    saleId: null,
    status: "active",
    updatedAt: "2026-11-10T12:00:00.000Z",
    version: 1,
    voidedAt: null,
  };
}

const PAGE_TWO = "page-two";

function answer({ cursor }: ListInput) {
  const totals = [FRETE, ALUGUEL].map((id, index) => ({
    categoryArchived: names[id]?.archived ?? false,
    categoryId: id,
    categoryName: names[id]?.name ?? "",
    count: index === 0 ? 2 : 1,
    total: index === 0 ? "20.00" : "30.00",
  }));
  const first = cursor === null;
  return {
    count: 3,
    expenses: first
      ? [expense(1, FRETE, "10.00"), expense(2, FRETE, "10.00")]
      : [expense(3, ALUGUEL, "30.00")],
    nextCursor: first ? PAGE_TWO : null,
    total: "50.00",
    totalsByCategory: totals,
  };
}

function renderPage() {
  return render(
    <StaticOrganizationProvider
      organization={{
        id: organizationId,
        name: "Loja do teste",
        role: "owner",
        timezone: "America/Sao_Paulo",
      }}
    >
      <ExpensesPage />
    </StaticOrganizationProvider>
  );
}

async function openCategories(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Categorias" }));
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  window.history.replaceState(null, "", "/expenses");
  names = {
    [ALUGUEL]: { archived: false, name: "Aluguel" },
    [FRETE]: { archived: false, name: "Frete" },
  };
  list.mockImplementation((input: ListInput) => Promise.resolve(answer(input)));
  listCategories.mockImplementation(() =>
    Promise.resolve({
      categories: [category(FRETE, "Frete"), category(ALUGUEL, "Aluguel")],
    })
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("renaming a category on the Categorias part", () => {
  it("reads the list again and the split by category shows the new name", async () => {
    const user = userEvent.setup();
    renameCategory.mockImplementation(() => {
      names[FRETE] = { archived: false, name: "Transporte" };
      return Promise.resolve({ category: category(FRETE, "Transporte") });
    });
    renderPage();
    await screen.findByText(/Despesa 1/);
    const block = await screen.findByRole("region", { name: "Por categoria" });
    expect(within(block).getByText("Frete")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);

    await openCategories(user);
    await user.click(
      screen.getByRole("button", { name: "Renomear categoria Frete" })
    );
    const field = await screen.findByLabelText("Nome da categoria");
    await user.clear(field);
    await user.type(field, "Transporte");
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() =>
      expect(within(block).getByText("Transporte")).toBeTruthy()
    );
    expect(within(block).queryByText("Frete")).toBeNull();
  });
});
