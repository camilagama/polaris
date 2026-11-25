// @vitest-environment happy-dom
import type { ExpenseReadModel } from "@polaris/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpenseList } from "./expense-list";
import type { ExpenseFilters, ExpenseListState } from "./use-expense-list";

const connection = vi.hoisted(() => ({ online: true }));
vi.mock("../lib/browser-connection", () => ({
  useConnectionOnline: () => connection.online,
}));

/**
 * The "…" menu of a row of Lançamentos holds Anular, the one destructive action: the static drawing in
 * expense-screen-parts.test.tsx shows the trigger; the item belongs to the popup (Base UI), opened here in a DOM.
 */
const NAME = "Aluguel de outubro";
const filters: ExpenseFilters = {
  categoryId: "",
  month: "2026-10",
  status: "active",
};
const expense: ExpenseReadModel = {
  amount: "1500.50",
  categoryGroup: "operational",
  categoryId: "c1",
  categoryName: "Aluguel",
  competenceOn: "2026-10-01",
  createdAt: "2026-10-14T12:00:00.000Z",
  description: NAME,
  id: "e1",
  organizationId: "org",
  payee: null,
  recurringRuleId: null,
  saleId: null,
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 1,
  voidedAt: null,
};
const state: ExpenseListState = {
  count: 1,
  error: null,
  expenses: [expense],
  isLoading: false,
  isLoadingMore: false,
  nextCursor: null,
  total: "1500.50",
};

describe("o menu … da linha de uma despesa", () => {
  afterEach(() => {
    cleanup();
    connection.online = true;
  });

  const user = userEvent.setup();
  const noop = () => undefined;

  function list(busyKey: string | null, onVoid: (e: ExpenseReadModel) => void) {
    return (
      <ExpenseList
        busyKey={busyKey}
        filters={filters}
        onClearFilters={noop}
        onEdit={noop}
        onLoadMore={noop}
        onRestore={noop}
        onRetry={noop}
        onVoid={onVoid}
        state={state}
      />
    );
  }

  async function openMenu(onVoid: (expense: ExpenseReadModel) => void) {
    render(list(null, onVoid));
    await user.click(
      screen.getByRole("button", { name: `Mais ações para ${NAME}` })
    );
    return screen.getByRole("menuitem", { name: `Anular despesa ${NAME}` });
  }

  it("Anular é um item destrutivo do menu, com o nome de hoje, e age no primeiro toque", async () => {
    const onVoid = vi.fn();
    const item = await openMenu(onVoid);
    expect(item.getAttribute("data-variant")).toBe("destructive");
    expect(item.textContent).toBe("Anular");
    expect(item.getAttribute("aria-disabled")).toBeNull();
    await user.click(item);
    expect(onVoid).toHaveBeenCalledTimes(1);
    expect(onVoid).toHaveBeenCalledWith(expense);
  });

  it("sem conexão o item fica desligado com o motivo e não envia nada", async () => {
    connection.online = false;
    const onVoid = vi.fn();
    const item = await openMenu(onVoid);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("aria-describedby")).not.toBeNull();
    await user.click(item);
    expect(onVoid).not.toHaveBeenCalled();
  });

  it("pelo teclado: Enter no gatilho abre o menu e Enter no item Anular age uma vez", async () => {
    const onVoid = vi.fn();
    render(list(null, onVoid));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `Editar despesa ${NAME}` })
    );
    expect(document.activeElement?.hasAttribute("data-expense-edit")).toBe(
      true
    );
    await user.tab();
    const trigger = screen.getByRole("button", {
      name: `Mais ações para ${NAME}`,
    });
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Enter}");
    const item = await screen.findByRole("menuitem", {
      name: `Anular despesa ${NAME}`,
    });
    await waitFor(() => expect(document.activeElement).toBe(item));
    await user.keyboard("{Enter}");
    expect(onVoid).toHaveBeenCalledTimes(1);
    expect(onVoid).toHaveBeenCalledWith(expense);
  });

  it("o item tem a altura de toque de 44 px", async () => {
    const item = await openMenu(vi.fn());
    expect(item.className).toContain("touch:min-h-11");
  });

  it("enquanto o Anular envia, a linha diz Anulando… e o menu não pode ser aberto de novo", () => {
    render(list(`void:${expense.id}`, vi.fn()));
    expect(screen.getByText("Anulando…").getAttribute("role")).toBe("status");
    expect(
      screen
        .getByRole("button", { name: `Mais ações para ${NAME}` })
        .hasAttribute("disabled")
    ).toBe(true);
  });
});
