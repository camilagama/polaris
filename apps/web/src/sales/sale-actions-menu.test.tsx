// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasSaleActions,
  SaleActionsMenu,
  type SaleActionsOffer,
} from "./sale-actions-menu";

const EVERYTHING: SaleActionsOffer = {
  cancel: true,
  choose: "reassign",
  linking: false,
  remove: true,
  return: true,
};
const NOTHING: SaleActionsOffer = {
  cancel: false,
  choose: null,
  linking: false,
  remove: false,
  return: false,
};
const ACTIONS = { name: "Ações" };

function renderMenu(offer: SaleActionsOffer, online = true) {
  const onAction = vi.fn();
  render(
    <SaleActionsMenu
      offer={offer}
      onAction={onAction}
      online={online}
      triggerRef={null}
    />
  );
  return onAction;
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", ACTIONS));
  return user;
}

afterEach(cleanup);

describe("hasSaleActions", () => {
  it("is true when any item applies and false when none does", () => {
    expect(hasSaleActions(EVERYTHING)).toBe(true);
    expect(hasSaleActions({ ...NOTHING, return: true })).toBe(true);
    expect(hasSaleActions({ ...NOTHING, choose: "assign" })).toBe(true);
    expect(hasSaleActions(NOTHING)).toBe(false);
  });
});

describe("the Ações menu of the sale", () => {
  it("draws no button when no item applies", () => {
    renderMenu(NOTHING);
    expect(screen.queryByRole("button", ACTIONS)).toBeNull();
  });

  it("lists the customer first, the return next and the cancellation last, after a separator", async () => {
    renderMenu(EVERYTHING);
    await openMenu();
    const items = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      "Trocar cliente",
      "Remover cliente",
      "Registrar devolução",
      "Cancelar venda",
    ]);
    const menu = screen.getByRole("menu");
    const roles = [
      ...menu.querySelectorAll('[role="menuitem"], [role="separator"]'),
    ].map((node) => node.getAttribute("role"));
    expect(roles.at(-2)).toBe("separator");
    expect(
      screen
        .getByRole("menuitem", { name: "Cancelar venda" })
        .getAttribute("data-variant")
    ).toBe("destructive");
  });

  it("offers Associar cliente alone for a sale without customer, and no separator before a lone cancellation", async () => {
    renderMenu({ ...NOTHING, choose: "assign", remove: false });
    await openMenu();
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Associar cliente"]);

    cleanup();
    renderMenu({ ...NOTHING, cancel: true });
    await openMenu();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("asks for the item chosen", async () => {
    const onAction = renderMenu(EVERYTHING);
    const user = await openMenu();
    await user.click(
      screen.getByRole("menuitem", { name: "Registrar devolução" })
    );
    expect(onAction).toHaveBeenCalledWith("return");
  });

  it("keeps the items, off, with the reason in the item, when there is no connection", async () => {
    const onAction = renderMenu(EVERYTHING, false);
    const user = await openMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.textContent).toContain("Precisa de conexão");
    }
    await user.click(items[2] as HTMLElement);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("holds the customer items while the link is being saved, and not the others", async () => {
    renderMenu({ ...EVERYTHING, linking: true });
    await openMenu();
    const state = Object.fromEntries(
      screen
        .getAllByRole("menuitem")
        .map((item) => [
          item.textContent,
          item.getAttribute("aria-disabled") === "true",
        ])
    );
    expect(state).toEqual({
      "Cancelar venda": false,
      "Registrar devolução": false,
      "Remover cliente": true,
      "Trocar cliente": true,
    });
  });
});
