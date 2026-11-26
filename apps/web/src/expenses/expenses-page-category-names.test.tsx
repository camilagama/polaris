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

const list = vi.fn();
const listCategories = vi.fn();
const connection = { online: true };

vi.mock("../lib/orpc", () => ({
  orpcClient: {
    expense: {
      list: (input: unknown) => list(input),
      listCategories: (input: unknown) => listCategories(input),
    },
  },
}));

vi.mock("../lib/motion-level", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/motion-level")>()),
  useMotionLevel: () => "none" as const,
}));

vi.mock("../lib/browser-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/browser-connection")>()),
  useConnectionOnline: () => connection.online,
}));

import { StaticOrganizationProvider } from "../lib/current-organization";
import { ExpensesPage } from "./expenses-page";

const NOW = new Date("2026-11-15T15:00:00.000Z");
const organizationId = "org_1";
const FRETE = "f0000000-0000-4000-8000-000000000001";
const ALUGUEL = "a0000000-0000-4000-8000-000000000002";
const RENAMED = "Aluguel do galpão";

function category(id: string, name: string): ExpenseCategoryReadModel {
  return {
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    groupKey: "operational",
    id,
    name,
    organizationId,
    status: "active",
    systemKey: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}

function expense(
  index: number,
  categoryId: string,
  categoryName: string
): ExpenseReadModel {
  return {
    amount: "10.00",
    categoryGroup: "operational",
    categoryId,
    categoryName,
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

function serverAnswer() {
  return {
    count: 2,
    expenses: [expense(1, FRETE, "Frete"), expense(2, ALUGUEL, RENAMED)],
    nextCursor: null,
    total: "20.00",
    totalsByCategory: [
      { categoryId: FRETE, categoryName: "Frete", count: 1, total: "10.00" },
      { categoryId: ALUGUEL, categoryName: RENAMED, count: 1, total: "10.00" },
    ],
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

let localCategories: ExpenseCategoryReadModel[];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  window.history.replaceState(null, "", "/expenses");
  connection.online = true;
  localCategories = [category(FRETE, "Frete"), category(ALUGUEL, "Aluguel")];
  list.mockImplementation(() => Promise.resolve(serverAnswer()));
  listCategories.mockImplementation(() =>
    Promise.resolve({ categories: localCategories })
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("a category renamed in another tab", () => {
  it("reads the categories once and the split and the filter chip say the new name", async () => {
    const user = userEvent.setup();
    listCategories
      .mockImplementationOnce(() =>
        Promise.resolve({ categories: localCategories })
      )
      .mockImplementation(() =>
        Promise.resolve({
          categories: [category(FRETE, "Frete"), category(ALUGUEL, RENAMED)],
        })
      );
    renderPage();
    const block = await screen.findByRole("region", { name: "Por categoria" });
    await within(block).findByText(RENAMED);

    await waitFor(() => expect(listCategories).toHaveBeenCalledTimes(2));
    await user.click(
      await screen.findByRole("button", {
        name: new RegExp(`^Filtrar por ${RENAMED}`),
      })
    );
    const bar = await screen.findByLabelText("Filtrar despesas");
    expect(within(bar).getByText(RENAMED)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listCategories).toHaveBeenCalledTimes(2);
  });

  it("reads the categories once when another tab archived one, and the chip says so", async () => {
    const user = userEvent.setup();
    list.mockImplementation(() => {
      const answer = serverAnswer();
      return Promise.resolve({
        ...answer,
        totalsByCategory: answer.totalsByCategory.map((entry) =>
          entry.categoryId === ALUGUEL
            ? { ...entry, categoryArchived: true }
            : entry
        ),
      });
    });
    localCategories = [category(FRETE, "Frete"), category(ALUGUEL, RENAMED)];
    listCategories
      .mockImplementationOnce(() =>
        Promise.resolve({ categories: localCategories })
      )
      .mockImplementation(() =>
        Promise.resolve({
          categories: [
            category(FRETE, "Frete"),
            { ...category(ALUGUEL, RENAMED), status: "archived" as const },
          ],
        })
      );
    renderPage();
    const block = await screen.findByRole("region", { name: "Por categoria" });
    await within(block).findByText(`${RENAMED} (arquivada)`);
    await waitFor(() => expect(listCategories).toHaveBeenCalledTimes(2));
    await user.click(
      await screen.findByRole("button", {
        name: new RegExp(`^Filtrar por ${RENAMED} \\(arquivada\\)`),
      })
    );
    const bar = await screen.findByLabelText("Filtrar despesas");
    expect(within(bar).getByText(`${RENAMED} (arquivada)`)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listCategories).toHaveBeenCalledTimes(2);
  });

  it("lists the new name in the Categoria menu after the read", async () => {
    const user = userEvent.setup();
    listCategories
      .mockImplementationOnce(() =>
        Promise.resolve({ categories: localCategories })
      )
      .mockImplementation(() =>
        Promise.resolve({
          categories: [category(FRETE, "Frete"), category(ALUGUEL, RENAMED)],
        })
      );
    renderPage();
    const block = await screen.findByRole("region", { name: "Por categoria" });
    await within(block).findByText(RENAMED);
    await waitFor(() => expect(listCategories).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Filtrar" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Categoria" })
    );
    const choices = await screen.findByRole("group", { name: "Categoria" });
    await within(choices).findByRole("button", { name: RENAMED });
    await waitFor(() =>
      expect(
        within(choices).queryByRole("button", { name: "Aluguel" })
      ).toBeNull()
    );
  });

  it("lists the archived category as such in the Categoria menu after the read", async () => {
    const user = userEvent.setup();
    list.mockImplementation(() => {
      const answer = serverAnswer();
      return Promise.resolve({
        ...answer,
        totalsByCategory: answer.totalsByCategory.map((entry) =>
          entry.categoryId === ALUGUEL
            ? { ...entry, categoryArchived: true }
            : entry
        ),
      });
    });
    localCategories = [category(FRETE, "Frete"), category(ALUGUEL, RENAMED)];
    listCategories
      .mockImplementationOnce(() =>
        Promise.resolve({ categories: localCategories })
      )
      .mockImplementation(() =>
        Promise.resolve({
          categories: [
            category(FRETE, "Frete"),
            { ...category(ALUGUEL, RENAMED), status: "archived" as const },
          ],
        })
      );
    renderPage();
    const block = await screen.findByRole("region", { name: "Por categoria" });
    await within(block).findByText(`${RENAMED} (arquivada)`);
    await waitFor(() => expect(listCategories).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Filtrar" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Categoria" })
    );
    const choices = await screen.findByRole("group", { name: "Categoria" });
    await within(choices).findByRole("button", {
      name: `${RENAMED} (arquivada)`,
    });
  });

  it("does not read again in a loop when the server still disagrees with the list read", async () => {
    list.mockImplementation(() => {
      const answer = serverAnswer();
      return Promise.resolve({
        ...answer,
        totalsByCategory: answer.totalsByCategory.map((entry) =>
          entry.categoryId === ALUGUEL
            ? { ...entry, categoryArchived: true }
            : entry
        ),
      });
    });
    listCategories.mockImplementation(() =>
      Promise.resolve({
        categories: [category(FRETE, "Frete"), category(ALUGUEL, RENAMED)],
      })
    );
    renderPage();
    await waitFor(() => expect(listCategories).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(listCategories).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not read the categories when the names agree", async () => {
    localCategories = [category(FRETE, "Frete"), category(ALUGUEL, RENAMED)];
    renderPage();
    const block = await screen.findByRole("region", { name: "Por categoria" });
    await within(block).findByText(RENAMED);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listCategories).toHaveBeenCalledTimes(1);
  });

  it("makes no new read without a connection", async () => {
    connection.online = false;
    renderPage();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listCategories).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listCategories).toHaveBeenCalledTimes(1);
  });
});
