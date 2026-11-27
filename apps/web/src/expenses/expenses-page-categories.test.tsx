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

const FIRST_ROW = /Despesa 1/;
const THIRD_ROW = /Despesa 3/;
const FOURTH_ROW = /Despesa 4/;
const OTHER_ROW = /^Outro · /;
const RENAMED_ROW = /^Transporte · /;
const MONTH_BUTTON = /^Mês de competência/;
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
    archivedAt: status === "archived" ? "2026-01-02T00:00:00.000Z" : null,
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
      categories: [FRETE, ALUGUEL].map((id) =>
        category(
          id,
          names[id]?.name ?? "",
          names[id]?.archived ? "archived" : "active"
        )
      ),
    })
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const cursorsRead = () => list.mock.calls.map(([input]) => input.cursor);

type User = ReturnType<typeof userEvent.setup>;

async function openSecondPage(user: User) {
  await user.click(
    await screen.findByRole("button", { name: "Carregar mais" })
  );
  await screen.findByText(THIRD_ROW);
}

async function renameFrete(user: User, name: string) {
  await openCategories(user);
  await user.click(
    screen.getByRole("button", { name: "Renomear categoria Frete" })
  );
  const field = await screen.findByLabelText("Nome da categoria");
  await user.clear(field);
  await user.type(field, name);
  await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
}

function renameCommand(name: string) {
  renameCategory.mockImplementation(() => {
    names[FRETE] = { archived: false, name };
    return Promise.resolve({ category: category(FRETE, name) });
  });
}

describe("the Categorias part is a list block per group", () => {
  it("names each group's region by its title and keeps the rows, the badge and the actions in it", async () => {
    names[FRETE] = { archived: true, name: "Frete" };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(FIRST_ROW);
    await openCategories(user);
    await user.click(
      screen.getByRole("checkbox", { name: "Mostrar categorias arquivadas" })
    );

    const region = await screen.findByRole("region", {
      name: "Operacional/Administrativa",
    });
    const rows = within(region).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-category-id"))).toEqual([
      FRETE,
      ALUGUEL,
    ]);
    const frete = rows[0] as HTMLElement;
    expect(within(frete).getByText("Arquivada")).toBeTruthy();
    expect(
      within(frete).getByRole("button", { name: "Renomear categoria Frete" })
    ).toBeTruthy();
    expect(
      within(frete).getByRole("button", { name: "Restaurar categoria Frete" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Operacional/Administrativa",
      })
    ).toBeTruthy();
    expect(region.querySelector("[data-list-count]")).toBeNull();
  });
});

describe("the Categorias part has no card around the list blocks", () => {
  it("puts no plain block or card above a group's region, while loaded and while loading", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(FIRST_ROW);
    await openCategories(user);

    const region = await screen.findByRole("region", {
      name: "Operacional/Administrativa",
    });
    expect(region.closest('[data-block="plain"]')).toBeNull();
    expect(region.parentElement?.closest('[data-slot="card"]')).toBeNull();
    const controls = screen.getByRole("button", { name: "Nova categoria" });
    expect(controls.closest('[data-slot="card"]')).toBeNull();
    expect(controls.closest('[data-block="plain"]')).toBeNull();
  });

  it("keeps the loading block outside any card", async () => {
    listCategories.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    renderPage();
    await openCategories(user);

    const block = await screen.findByRole("region", {
      name: "Categorias de despesa",
    });
    expect(block.closest('[data-block="plain"]')).toBeNull();
    expect(block.parentElement?.closest('[data-slot="card"]')).toBeNull();
  });
});

describe("the Categorias part while the categories load", () => {
  it("draws the skeleton block, not the rows, and no group yet", async () => {
    listCategories.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    renderPage();
    await openCategories(user);

    const block = await screen.findByRole("region", {
      name: "Categorias de despesa",
    });
    expect(block.getAttribute("data-state")).toBe("loading");
    expect(
      screen.queryByRole("region", { name: "Operacional/Administrativa" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Renomear categoria Frete" })
    ).toBeNull();
  });
});

describe("renaming a category on the Categorias part", () => {
  it("reads the list again and the split by category shows the new name", async () => {
    const user = userEvent.setup();
    renameCommand("Transporte");
    renderPage();
    await screen.findByText(FIRST_ROW);
    const block = await screen.findByRole("region", { name: "Por categoria" });
    expect(within(block).getByText("Frete")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);

    await renameFrete(user, "Transporte");

    await waitFor(() =>
      expect(within(block).getByText("Transporte")).toBeTruthy()
    );
    expect(within(block).queryByText("Frete")).toBeNull();
    expect(screen.getByText("Categoria “Transporte” renomeada.")).toBeTruthy();
  });

  it("keeps the second page and shows the new name in the rows and in the split", async () => {
    const user = userEvent.setup();
    renameCommand("Transporte");
    renderPage();
    await screen.findByText(FIRST_ROW);
    await openSecondPage(user);
    expect(cursorsRead()).toEqual([null, PAGE_TWO]);

    await renameFrete(user, "Transporte");

    await waitFor(() =>
      expect(cursorsRead()).toEqual([null, PAGE_TWO, null, PAGE_TWO])
    );
    await waitFor(() =>
      expect(screen.getAllByText(RENAMED_ROW)).toHaveLength(2)
    );
    expect(screen.getByText(THIRD_ROW)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Carregar mais" })).toBeNull();
    const block = screen.getByRole("region", {
      hidden: true,
      name: "Por categoria",
    });
    expect(within(block).getByText("Transporte")).toBeTruthy();
  });
});

describe("a rename while the page is moving", () => {
  it("waits for the page being added, then reads both pages with the new name", async () => {
    const user = userEvent.setup();
    renameCommand("Transporte");
    let release: () => void = () => undefined;
    list.mockImplementation((input: ListInput) => {
      if (input.cursor === PAGE_TWO && list.mock.calls.length === 2) {
        return new Promise((resolve) => {
          release = () => resolve(answer(input));
        });
      }
      return Promise.resolve(answer(input));
    });
    renderPage();
    await screen.findByText(FIRST_ROW);
    await user.click(
      await screen.findByRole("button", { name: "Carregar mais" })
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await renameFrete(user, "Transporte");
    await waitFor(() => expect(renameCategory).toHaveBeenCalledTimes(1));
    expect(list).toHaveBeenCalledTimes(2);
    release();

    await waitFor(() =>
      expect(cursorsRead()).toEqual([null, PAGE_TWO, null, PAGE_TWO])
    );
    await waitFor(() =>
      expect(screen.getAllByText(RENAMED_ROW)).toHaveLength(2)
    );
    expect(screen.getByText(THIRD_ROW)).toBeTruthy();
  });

  it("keeps the rows and says so when the read fails", async () => {
    const user = userEvent.setup();
    renameCommand("Transporte");
    renderPage();
    await screen.findByText(FIRST_ROW);
    await openSecondPage(user);
    list.mockImplementation(() => Promise.reject(new Error("offline")));

    await renameFrete(user, "Transporte");

    await screen.findByText("Não foi possível carregar as despesas.");
    expect(screen.getByText(THIRD_ROW)).toBeTruthy();
    expect(screen.getByText(FIRST_ROW)).toBeTruthy();
  });
});

describe("archiving a category on the Categorias part", () => {
  it("keeps the second page and writes (arquivada) in the split", async () => {
    const user = userEvent.setup();
    archiveCategory.mockImplementation(() => {
      names[FRETE] = { archived: true, name: "Frete" };
      return Promise.resolve({
        category: category(FRETE, "Frete", "archived"),
      });
    });
    renderPage();
    await screen.findByText(FIRST_ROW);
    await openSecondPage(user);

    await openCategories(user);
    await user.click(
      screen.getByRole("button", { name: "Arquivar categoria Frete" })
    );

    await waitFor(() =>
      expect(cursorsRead()).toEqual([null, PAGE_TWO, null, PAGE_TWO])
    );
    const block = screen.getByRole("region", {
      hidden: true,
      name: "Por categoria",
    });
    await waitFor(() =>
      expect(within(block).getByText("Frete (arquivada)")).toBeTruthy()
    );
    expect(screen.getByText(THIRD_ROW)).toBeTruthy();
    expect(screen.getByText("Categoria “Frete” arquivada.")).toBeTruthy();
  });
});

describe("creating a category on the Categorias part", () => {
  it("reads no expense: the new category has none", async () => {
    const user = userEvent.setup();
    const created = "c0000000-0000-4000-8000-000000000003";
    createCategory.mockImplementation(() =>
      Promise.resolve(category(created, "Embalagens"))
    );
    renderPage();
    await screen.findByText(FIRST_ROW);
    await openSecondPage(user);
    const before = list.mock.calls.length;

    await openCategories(user);
    await user.click(screen.getByRole("button", { name: "Nova categoria" }));
    await user.type(
      await screen.findByLabelText("Nome da categoria"),
      "Embalagens"
    );
    await user.click(
      screen.getByRole("button", { name: "Adicionar categoria" })
    );

    await screen.findByText("Embalagens");
    await screen.findByText("Categoria “Embalagens” criada.");
    expect(createCategory).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(before);
    expect(screen.getByText(THIRD_ROW)).toBeTruthy();
  });
});

describe("the month changes while a read of the pages is waiting", () => {
  async function pickOctober(user: User) {
    await user.click(screen.getByRole("button", { name: MONTH_BUTTON }));
    await user.click(
      await screen.findByRole("button", { name: "Out, outubro de 2026" })
    );
    await screen.findByText("Despesa de outubro 1");
  }

  function octoberAnswer(input: ListInput) {
    const first = input.cursor === null;
    return {
      ...answer(input),
      expenses: [
        {
          ...expense(7, FRETE, "5.00"),
          description: first ? "Despesa de outubro 1" : "Despesa de outubro 2",
        },
      ],
      nextCursor: first ? PAGE_TWO : null,
    };
  }

  async function expectNothingOfTheOldMonth(
    user: User,
    oldFrom: string | undefined,
    callsAtChange: number
  ) {
    await user.click(screen.getByRole("button", { name: "Carregar mais" }));
    await screen.findByText("Despesa de outubro 2");
    expect(
      list.mock.calls
        .slice(callsAtChange)
        .filter(([input]) => input.from === oldFrom)
    ).toEqual([]);
    expect(screen.queryByText(THIRD_ROW)).toBeNull();
    expect(screen.queryByText(FIRST_ROW)).toBeNull();
  }

  it("drops the page being added: no read of the old month after the change", async () => {
    const user = userEvent.setup();
    renameCommand("Transporte");
    renderPage();
    await screen.findByText(FIRST_ROW);
    const oldFrom = list.mock.calls[0]?.[0].from;
    let release: () => void = () => undefined;
    list.mockImplementation((input: ListInput & { from?: string }) => {
      if (input.from === oldFrom && input.cursor === null) {
        return new Promise((resolve) => {
          release = () => resolve(answer(input));
        });
      }
      return Promise.resolve(octoberAnswer(input));
    });

    await renameFrete(user, "Transporte");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("tab", { name: "Lançamentos" }));
    await user.click(screen.getByRole("button", { name: "Carregar mais" }));
    await pickOctober(user);
    const callsAtChange = list.mock.calls.length;
    release();

    await expectNothingOfTheOldMonth(user, oldFrom, callsAtChange);
  });

  it("drops the re-read queued behind the page being added", async () => {
    const user = userEvent.setup();
    renameCommand("Transporte");
    renderPage();
    await screen.findByText(FIRST_ROW);
    const oldFrom = list.mock.calls[0]?.[0].from;
    let release: () => void = () => undefined;
    list.mockImplementation((input: ListInput & { from?: string }) => {
      if (input.from === oldFrom && input.cursor === PAGE_TWO) {
        return new Promise((resolve) => {
          release = () => resolve(answer(input));
        });
      }
      if (input.from === oldFrom) {
        return Promise.resolve(answer(input));
      }
      return Promise.resolve(octoberAnswer(input));
    });
    await user.click(screen.getByRole("button", { name: "Carregar mais" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await renameFrete(user, "Transporte");
    await waitFor(() => expect(renameCategory).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("tab", { name: "Lançamentos" }));
    await pickOctober(user);
    const callsAtChange = list.mock.calls.length;
    release();

    await expectNothingOfTheOldMonth(user, oldFrom, callsAtChange);
  });
});

describe("a failed re-read of the list", () => {
  it("keeps the cursor: Carregar mais still reads the second page", async () => {
    const user = userEvent.setup();
    renameCommand("Transporte");
    renderPage();
    await screen.findByText(FIRST_ROW);
    list.mockImplementation(() => Promise.reject(new Error("offline")));

    await renameFrete(user, "Transporte");
    await user.click(screen.getByRole("tab", { name: "Lançamentos" }));
    await screen.findByText("Não foi possível carregar as despesas.");
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(cursorsRead().length).toBeGreaterThan(2));
    await screen.findByText("Não foi possível carregar as despesas.");
    list.mockImplementation((input: ListInput) =>
      Promise.resolve(answer(input))
    );
    const before = list.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Carregar mais" }));

    await screen.findByText(THIRD_ROW);
    expect(cursorsRead().slice(before)).toEqual([PAGE_TWO]);
  });
});

describe("a failed re-read after Carregar mais", () => {
  const PAGE_THREE = "page-three";

  function threePages({ cursor }: ListInput) {
    const base = answer({ cursor: null });
    if (cursor === null) {
      return base;
    }
    if (cursor === PAGE_TWO) {
      return {
        ...base,
        expenses: [expense(3, ALUGUEL, "30.00")],
        nextCursor: PAGE_THREE,
      };
    }
    return {
      ...base,
      expenses: [expense(4, ALUGUEL, "40.00")],
      nextCursor: null,
    };
  }

  async function failTwice(user: User) {
    renameCommand("Transporte");
    list.mockImplementation((input: ListInput) =>
      Promise.resolve(threePages(input))
    );
    renderPage();
    await screen.findByText(FIRST_ROW);
    await openSecondPage(user);
    list.mockImplementation(() => Promise.reject(new Error("offline")));

    await renameFrete(user, "Transporte");
    await user.click(screen.getByRole("tab", { name: "Lançamentos" }));
    const retry = await screen.findByRole("button", {
      name: "Tentar novamente",
    });
    const beforeRetry = list.mock.calls.length;
    await user.click(retry);
    await waitFor(() =>
      expect(list.mock.calls.length).toBeGreaterThan(beforeRetry)
    );
    await screen.findByText("Não foi possível carregar as despesas.");
    list.mockImplementation((input: ListInput) =>
      Promise.resolve(threePages(input))
    );
  }

  it("reads the third page, not the second again, and shows no row twice", async () => {
    const user = userEvent.setup();
    await failTwice(user);
    const before = list.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Carregar mais" }));

    await screen.findByText(FOURTH_ROW);
    expect(cursorsRead().slice(before)).toEqual([PAGE_THREE]);
    expect(screen.getAllByText(THIRD_ROW)).toHaveLength(1);
    expect(screen.getAllByText(FIRST_ROW)).toHaveLength(1);
  });

  it("keeps both pages on the next successful re-read", async () => {
    const user = userEvent.setup();
    await failTwice(user);
    const before = list.mock.calls.length;

    await openCategories(user);
    await user.click(
      screen.getByRole("button", { name: "Renomear categoria Transporte" })
    );
    const field = await screen.findByLabelText("Nome da categoria");
    await user.clear(field);
    await user.type(field, "Outro");
    renameCommand("Outro");
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));

    await waitFor(() =>
      expect(cursorsRead().slice(before)).toEqual([null, PAGE_TWO])
    );
    await waitFor(() => expect(screen.getAllByText(OTHER_ROW)).toHaveLength(2));
    expect(screen.getByText(THIRD_ROW)).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Lançamentos" }));
    expect(screen.getByRole("button", { name: "Carregar mais" })).toBeTruthy();
  });
});
