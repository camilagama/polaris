/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  expectFormDialogLayout,
  expectKeyboardKeepsMainButton,
  FORM_WIDTHS,
  sizeFor,
} from "../e2e/form-dialog-checks";
import { runClockFor } from "../e2e/run-clock-for";
import {
  DETAIL_SALE_ID,
  openSaleAction,
  type SaleDetailSituation,
  saleDetailAnswers,
} from "./sale-detail-fixture";
import { WORKER_MARK } from "./worker-mark";

/**
 * The real route `/sales/detail` (the customer is part of it), the API answered by the test (`page.route`, synthetic data
 * only): the "Ações" menu of the title with the return, the cancellation and the customer in dialogs, the focus when a
 * cancellation or a return changes step, and the customer dialogs that ask before they remove and keep a turned-off
 * button reachable and with its reason.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const RPC_PREFIX = /^.*\/rpc\//;
const json = (body: unknown) => ({
  body: JSON.stringify(body),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

/** Opens a route of the shell with a session and the answers by procedure; returns the procedures asked, in order. */
async function openInShell(
  page: Page,
  path: string,
  answers: Readonly<Record<string, unknown>>
) {
  const asked: string[] = [];
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill(
      json({ emailPassword: true, google: true, turnstileSiteKey: null })
    )
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(json({ session: { id: "s" }, user: { id: "u" } }))
  );
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    asked.push(procedure);
    const answer =
      procedure === "organization/listMine"
        ? { organizations: [ORGANIZATION] }
        : answers[procedure];
    return answer === undefined
      ? route.abort("internetdisconnected")
      : route.fulfill(json({ json: answer, meta: [] }));
  });
  await page.goto(path);
  return asked;
}

const count = (asked: readonly string[], procedure: string) =>
  asked.filter((name) => name === procedure).length;

/** Tab until the button is the one with the focus (the keyboard path, not a click). */
async function tabTo(page: Page, name: string) {
  for (let step = 0; step < 60; step += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each Tab depends on where the previous one left the focus
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.textContent ?? ""
    );
    if (focused.trim() === name) {
      return;
    }
  }
  throw new Error(`Tab never reached "${name}"`);
}

const notice = (page: Page, title: string) =>
  page.locator('[data-slot="alert"]').filter({ hasText: title });

const actionsButton = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Ações" });

async function openDetail(page: Page) {
  await openInShell(
    page,
    `/sales/detail?saleId=${DETAIL_SALE_ID}`,
    saleDetailAnswers({ withReturn: false })
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Detalhe da venda" })
  ).toBeVisible();
}

test.describe("the focus when the step changes", () => {
  test("a return: review puts it on the confirmation, back puts it on the first field", async ({
    page,
  }) => {
    await openDetail(page);
    await openSaleAction(page, "Registrar devolução");
    const first = page.getByLabel("Devolvido: Calça jeans — 42 (até 2)");
    await first.fill("1");
    await tabTo(page, "Revisar devolução");
    await page.keyboard.press("Enter");
    await expect(notice(page, "Confirme a devolução")).toBeFocused();
    await tabTo(page, "Voltar");
    await page.keyboard.press("Enter");
    await expect(first).toBeFocused();
  });

  test("a return keeps what was typed when Esc closes it, and Não devolver drops it", async ({
    page,
  }) => {
    await openDetail(page);
    await openSaleAction(page, "Registrar devolução");
    const dialog = page.getByRole("dialog", { name: "Registrar devolução" });
    const first = page.getByLabel("Devolvido: Calça jeans — 42 (até 2)");
    await first.fill("1");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await openSaleAction(page, "Registrar devolução");
    await expect(first).toHaveValue("1");
    await dialog.getByRole("button", { name: "Não devolver" }).click();
    await expect(dialog).toBeHidden();
    await openSaleAction(page, "Registrar devolução");
    await expect(first).toHaveValue("");
  });

  test("a cancellation: review puts it on the confirmation, back puts it on the reason", async ({
    page,
  }) => {
    await openDetail(page);
    await openSaleAction(page, "Cancelar venda");
    await tabTo(page, "Revisar cancelamento");
    await page.keyboard.press("Enter");
    await expect(notice(page, "Confirme o cancelamento")).toBeFocused();
    await tabTo(page, "Voltar");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("combobox", { name: "Motivo Opcional" })
    ).toBeFocused();
  });

  test("the note of a cancellation is a multi-line field: taller than the 44 px of a one-line one", async ({
    page,
  }) => {
    await openDetail(page);
    await openSaleAction(page, "Cancelar venda");
    await page.getByRole("combobox", { name: "Motivo Opcional" }).click();
    await page.getByRole("option", { exact: true, name: "Outro" }).click();
    const group = page.locator("[data-slot=input-group]").filter({
      has: page.getByLabel("Observação (obrigatória para “Outro”)"),
    });
    await expect(group).toBeVisible();
    expect((await group.boundingBox())?.height ?? 0).toBeGreaterThan(60);
  });
});

async function openCustomer(
  page: Page,
  link: unknown = saleDetailAnswers({ withReturn: true })[
    "sale/getCustomerLink"
  ],
  more: Readonly<Record<string, unknown>> = {}
) {
  const answers = saleDetailAnswers({ withReturn: true });
  const asked = await openInShell(
    page,
    `/sales/detail?saleId=${DETAIL_SALE_ID}`,
    {
      ...answers,
      ...more,
      "sale/getCustomerLink": link,
      "sale/unassignCustomer": {
        changed: true,
        link: {
          ...(answers["sale/getCustomerLink"] as object),
          current: { customerId: null, version: 2 },
        },
      },
    }
  );
  await expect(page.locator("[data-sale-customer]")).toBeVisible();
  return asked;
}

for (const width of FORM_WIDTHS) {
  test(`Trocar cliente at ${width} px: the dialog opens, cancels and saves, the whole screen on a phone`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "the width is the test's"
    );
    await page.setViewportSize(sizeFor(width));
    const answers = saleDetailAnswers({ withReturn: true });
    const link = answers["sale/getCustomerLink"] as object;
    const [, other] = (
      answers["customer/list"] as { customers: { id: string }[] }
    ).customers;
    const asked = await openCustomer(page, link, {
      "sale/reassignCustomer": {
        changed: true,
        link: { ...link, current: { customerId: other?.id, version: 3 } },
      },
    });
    const openForm = actionsButton(page);
    const openChoice = () => openSaleAction(page, "Trocar cliente");
    await openChoice();
    const dialog = page.getByRole("dialog", { name: "Trocar cliente" });
    await expect(dialog).toBeVisible();
    await expectFormDialogLayout(dialog, width);

    const send = dialog.getByRole("button", { name: "Trocar cliente" });
    await dialog
      .getByRole("combobox", { exact: true, name: "Cliente" })
      .click();
    await page.getByRole("option", { exact: true, name: "Bruno Lima" }).click();
    await expect(send).not.toHaveAttribute("aria-disabled", "true");
    if (width < 760) {
      await expectKeyboardKeepsMainButton(page, dialog, send);
    }

    // Esc keeps the choice (in memory only): the form closes, the focus goes back and the same form brings it back
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(openForm).toBeFocused();
    await openChoice();
    await expect(
      dialog.getByRole("combobox", { exact: true, name: "Cliente" })
    ).toHaveText("Bruno Lima");
    await expect(send).not.toHaveAttribute("aria-disabled", "true");

    // "Cancelar": nothing is sent, the form closes, the focus goes back to the button that opened it and the choice is thrown away
    await dialog.getByRole("button", { exact: true, name: "Cancelar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(openForm).toBeFocused();
    expect(count(asked, "sale/reassignCustomer")).toBe(0);

    // the choice does not stay for the next time; sending closes the form
    await openChoice();
    await expect(send).toHaveAttribute("aria-disabled", "true");
    await dialog
      .getByRole("combobox", { exact: true, name: "Cliente" })
      .click();
    await page.getByRole("option", { exact: true, name: "Bruno Lima" }).click();
    await send.click();
    await expect.poll(() => count(asked, "sale/reassignCustomer")).toBe(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

test.describe("the customer of the sale", () => {
  test("changing the customer takes 5 taps: the menu, the item, open the list, pick, send", async ({
    page,
  }) => {
    const answers = saleDetailAnswers({ withReturn: true });
    const link = answers["sale/getCustomerLink"] as object;
    const [, other] = (
      answers["customer/list"] as { customers: { id: string }[] }
    ).customers;
    const asked = await openCustomer(page, link, {
      "sale/reassignCustomer": {
        changed: true,
        link: { ...link, current: { customerId: other?.id, version: 3 } },
      },
    });
    // the number of taps is counted here, one per click: it was 4 when the button was on the page, before the menu
    let taps = 0;
    const tap = async (target: Locator) => {
      taps += 1;
      await target.click();
    };
    await tap(actionsButton(page));
    await tap(
      page.getByRole("menuitem", { exact: true, name: "Trocar cliente" })
    );
    const dialog = page.getByRole("dialog", { name: "Trocar cliente" });
    await tap(dialog.getByRole("combobox", { exact: true, name: "Cliente" }));
    await tap(page.getByRole("option", { exact: true, name: "Bruno Lima" }));
    await tap(dialog.getByRole("button", { name: "Trocar cliente" }));
    await expect.poll(() => count(asked, "sale/reassignCustomer")).toBe(1);
    expect(taps).toBe(5);
  });

  test("removing asks first: Manter cliente sends nothing, Remover cliente sends once", async ({
    page,
  }) => {
    const asked = await openCustomer(page);
    await openSaleAction(page, "Remover cliente");
    const dialog = page.getByRole("dialog", {
      name: "Remover o cliente desta venda?",
    });
    await dialog.getByRole("button", { name: "Manter cliente" }).click();
    await expect(dialog).toBeHidden();
    await expect(actionsButton(page)).toBeFocused();
    expect(count(asked, "sale/unassignCustomer")).toBe(0);

    await openSaleAction(page, "Remover cliente");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(count(asked, "sale/unassignCustomer")).toBe(0);

    await openSaleAction(page, "Remover cliente");
    await dialog.getByRole("button", { name: "Remover cliente" }).click();
    await expect.poll(() => count(asked, "sale/unassignCustomer")).toBe(1);
    await expect(notice(page, "Cliente removido da venda.")).toBeFocused();
  });

  test("Trocar cliente without another active customer is off, reads why and does nothing on Enter", async ({
    page,
  }) => {
    await page.clock.install();
    const asked = await openCustomer(page);
    // the choice is made in a dialog: the button that opens it, then the one that sends the choice
    await openSaleAction(page, "Trocar cliente");
    const dialog = page.getByRole("dialog", { name: "Trocar cliente" });
    const swap = dialog.getByRole("button", { name: "Trocar cliente" });
    await expect(swap).toHaveAttribute("aria-disabled", "true");
    await expect(swap).toHaveAccessibleDescription("Escolha um cliente ativo.");
    await swap.focus();
    await expect(swap).toBeFocused();
    await page.keyboard.press("Enter");
    // let a call that would be made reach the route
    await runClockFor(page, 300);
    expect(count(asked, "sale/reassignCustomer")).toBe(0);
  });

  test("Associar cliente with nobody chosen is off, reads why and does nothing on Enter", async ({
    page,
  }) => {
    await page.clock.install();
    const link = saleDetailAnswers({ withReturn: true })[
      "sale/getCustomerLink"
    ] as object;
    const asked = await openCustomer(page, {
      ...link,
      current: { customerId: null, version: 2 },
    });
    await openSaleAction(page, "Associar cliente");
    const dialog = page.getByRole("dialog", { name: "Associar cliente" });
    const assign = dialog.getByRole("button", { name: "Associar cliente" });
    await expect(assign).toHaveAttribute("aria-disabled", "true");
    await expect(assign).toHaveAccessibleDescription(
      "Escolha um cliente ativo."
    );
    await assign.focus();
    await page.keyboard.press("Enter");
    await runClockFor(page, 300);
    expect(count(asked, "sale/assignCustomer")).toBe(0);
  });
});

/** Opens the detail of a situation of the sale, with the answers of the test plus the ones that change it. */
async function openSituation(
  page: Page,
  situation?: SaleDetailSituation,
  without: readonly string[] = []
) {
  const base = saleDetailAnswers({ situation, withReturn: false });
  const answers: Record<string, unknown> = {
    ...base,
    "sale/unassignCustomer": {
      changed: true,
      link: {
        ...(base["sale/getCustomerLink"] as object),
        current: { customerId: null, version: 2 },
      },
    },
  };
  for (const procedure of without) {
    delete answers[procedure];
  }
  const asked = await openInShell(
    page,
    `/sales/detail?saleId=${DETAIL_SALE_ID}`,
    answers
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Detalhe da venda" })
  ).toBeVisible();
  return asked;
}

const menuItems = (page: Page) => page.getByRole("menu").getByRole("menuitem");

test.describe("the Ações menu of the title", () => {
  test("is on the line of the title at 1280 px and under it at 360 px, and the three cards of action are gone", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "the widths are the test's"
    );
    for (const [width, height] of [
      [1280, 800],
      [360, 740],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each width is its own page state
      await page.setViewportSize({ height, width });
      await openSituation(page);
      const title = await page
        .getByRole("heading", { level: 1, name: "Detalhe da venda" })
        .boundingBox();
      const button = await actionsButton(page).boundingBox();
      expect(title).not.toBeNull();
      expect(button).not.toBeNull();
      if (width >= 760) {
        expect(button?.y ?? 0).toBeLessThan(
          (title?.y ?? 0) + (title?.height ?? 0)
        );
        expect(button?.x ?? 0).toBeGreaterThan(
          (title?.x ?? 0) + (title?.width ?? 0)
        );
      } else {
        expect(button?.y ?? 0).toBeGreaterThanOrEqual(
          (title?.y ?? 0) + (title?.height ?? 0)
        );
      }
      await expect(page.getByRole("region", { name: "Devolução" })).toHaveCount(
        0
      );
      await expect(
        page.getByRole("region", { name: "Cancelar venda" })
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Cliente da venda" })
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { exact: true, name: "Cancelar venda" })
      ).toHaveCount(0);
    }
  });

  test("lists the customer first, then the return, and the cancellation last, after a separator", async ({
    page,
  }) => {
    await openSituation(page);
    await actionsButton(page).click();
    await expect(menuItems(page)).toHaveText([
      "Trocar cliente",
      "Remover cliente",
      "Registrar devolução",
      "Cancelar venda",
    ]);
    const menu = page.getByRole("menu");
    const order = await menu.evaluate((element) =>
      [
        ...element.querySelectorAll('[role="menuitem"], [role="separator"]'),
      ].map((node) => node.getAttribute("role"))
    );
    expect(order).toEqual([
      "menuitem",
      "menuitem",
      "menuitem",
      "separator",
      "menuitem",
    ]);
    await expect(
      page.getByRole("menuitem", { name: "Cancelar venda" })
    ).toHaveAttribute("data-variant", "destructive");
  });

  test("the customer and the returns made stay on the screen with the menu closed", async ({
    page,
  }) => {
    await openInShell(
      page,
      `/sales/detail?saleId=${DETAIL_SALE_ID}`,
      saleDetailAnswers({ withReturn: true })
    );
    await expect(page.locator("[data-sale-customer]")).toContainText(
      "Ângela Souza"
    );
    await expect(
      page.getByRole("heading", { level: 2, name: "Devoluções" })
    ).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("Cancelar venda and Remover cliente ask first: closing the dialog writes nothing, only the confirmation writes", async ({
    page,
  }) => {
    const asked = await openSituation(page);
    await openSaleAction(page, "Cancelar venda");
    const dialog = page.getByRole("dialog", { name: "Cancelar venda" });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await openSaleAction(page, "Cancelar venda");
    await dialog.getByRole("button", { name: "Revisar cancelamento" }).click();
    await expect(notice(page, "Confirme o cancelamento")).toBeVisible();
    await dialog.getByRole("button", { name: "Voltar" }).click();
    await dialog.getByRole("button", { name: "Não cancelar" }).click();
    await expect(dialog).toBeHidden();
    await expect(actionsButton(page)).toBeFocused();
    expect(count(asked, "sale/cancel")).toBe(0);
    expect(count(asked, "sale/unassignCustomer")).toBe(0);

    await openSaleAction(page, "Cancelar venda");
    await dialog.getByRole("button", { name: "Revisar cancelamento" }).click();
    await dialog
      .getByRole("button", { name: "Confirmar cancelamento" })
      .click();
    await expect.poll(() => count(asked, "sale/cancel")).toBe(1);
  });

  test("opens and closes by keyboard: Enter and Space open, the arrows move, Esc closes and the focus goes back to the button", async ({
    page,
  }) => {
    await openSituation(page);
    const button = actionsButton(page);
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(menuItems(page).first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menuItems(page).nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(menuItems(page).first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(button).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(button).toBeFocused();

    // an action by keyboard ends on the notice of its result
    await page.keyboard.press("Enter");
    await expect(menuItems(page).first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Remover o cliente desta venda?",
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remover cliente" }).focus();
    await page.keyboard.press("Enter");
    await expect(notice(page, "Cliente removido da venda.")).toBeFocused();
  });

  test("each item has a target of 44 px on a touch screen, and the one that opens under the thumb is the customer's", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile-emulated",
      "the touch target is the phone's"
    );
    await openSituation(page);
    await actionsButton(page).click();
    const heights = await menuItems(page).evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height)
    );
    expect(heights).toHaveLength(4);
    for (const height of heights) {
      expect(height).toBeGreaterThanOrEqual(44);
    }
    await expect(menuItems(page).first()).toHaveText("Trocar cliente");
    await expect(menuItems(page).last()).toHaveText("Cancelar venda");
  });

  test("a cancelled sale, a sale returned in full and a sale that is not on the server offer only what applies, and nothing when nothing does", async ({
    page,
  }) => {
    await openSituation(page, "cancelled");
    await actionsButton(page).click();
    await expect(menuItems(page)).toHaveText([
      "Trocar cliente",
      "Remover cliente",
    ]);
    await page.keyboard.press("Escape");

    await openSituation(page, "allReturned");
    await expect(
      page.getByText("Todas as unidades já foram devolvidas.")
    ).toBeVisible();
    await actionsButton(page).click();
    await expect(menuItems(page)).toHaveText([
      "Trocar cliente",
      "Remover cliente",
    ]);
    await page.keyboard.press("Escape");

    // cancelled, and the link of the customer unreadable: nothing is left to offer
    await openSituation(page, "cancelled", ["sale/getCustomerLink"]);
    await expect(page.getByText("Venda cancelada")).toBeVisible();
    await expect(actionsButton(page)).toHaveCount(0);

    // a sale that exists only in this device's queue has no read on the server
    await openSituation(page, undefined, ["sale/get", "sale/getCustomerLink"]);
    await expect(actionsButton(page)).toHaveCount(0);
  });

  test("without a connection the items stay, off, with their reason in the item, and tapping one does nothing", async ({
    page,
    context,
  }) => {
    await openSituation(page);
    await expect(page.locator("[data-sale-customer]")).toContainText(
      "Ângela Souza"
    );
    await context.setOffline(true);
    await actionsButton(page).click();
    for (const name of [
      "Trocar cliente",
      "Remover cliente",
      "Registrar devolução",
      "Cancelar venda",
    ]) {
      const item = page.getByRole("menuitem", { name });
      // biome-ignore lint/performance/noAwaitInLoops: one item at a time reads clearer than a pile of assertions
      await expect(item).toHaveAttribute("aria-disabled", "true");
      await expect(item).toContainText("Precisa de conexão");
      await expect
        .poll(() =>
          item.getByText("Precisa de conexão").evaluate((element) => {
            let product = 1;
            for (
              let node: Element | null = element;
              node !== null;
              node = node.parentElement
            ) {
              product *= Number(getComputedStyle(node).opacity);
            }
            return product;
          })
        )
        .toBe(1);
    }
    await page
      .getByRole("menuitem", { name: "Registrar devolução" })
      .click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
