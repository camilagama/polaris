/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  expectFormDialogLayout,
  expectKeyboardKeepsMainButton,
  FORM_WIDTHS,
  sizeFor,
} from "../e2e/form-dialog-checks";
import { DETAIL_SALE_ID, saleDetailAnswers } from "./sale-detail-fixture";
import { WORKER_MARK } from "./worker-mark";

/**
 * The real route `/sales/detail` (the customer panel is part of it), the API answered by the test (`page.route`, synthetic data
 * only): the focus when a cancellation or a return changes step, and the customer panel that asks before it removes
 * and keeps a turned-off button reachable and with its reason (t260, on t255).
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
    await page.getByRole("button", { name: "Registrar devolução" }).click();
    const first = page.getByLabel("Devolvido: Calça jeans — 42 (até 2)");
    await first.fill("1");
    await tabTo(page, "Revisar devolução");
    await page.keyboard.press("Enter");
    await expect(notice(page, "Confirme a devolução")).toBeFocused();
    await tabTo(page, "Voltar");
    await page.keyboard.press("Enter");
    await expect(first).toBeFocused();
  });

  test("a cancellation: review puts it on the confirmation, back puts it on the reason", async ({
    page,
  }) => {
    await openDetail(page);
    await page.getByRole("button", { name: "Cancelar venda" }).click();
    await tabTo(page, "Revisar cancelamento");
    await page.keyboard.press("Enter");
    await expect(notice(page, "Confirme o cancelamento")).toBeFocused();
    await tabTo(page, "Voltar");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("combobox", { name: "Motivo (opcional)" })
    ).toBeFocused();
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
  await expect(
    page.getByRole("heading", { level: 2, name: "Cliente da venda" })
  ).toBeVisible();
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
    const openForm = page.getByRole("button", {
      exact: true,
      name: "Trocar cliente",
    });
    await openForm.click();
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
    await openForm.click();
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
    await openForm.click();
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
  test("changing the customer takes 4 taps: open, open the list, pick, send", async ({
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
    // the number of taps is counted here, one per click: it was 3 when the list and the button were on the page
    let taps = 0;
    const tap = async (target: Locator) => {
      taps += 1;
      await target.click();
    };
    await tap(
      page.getByRole("button", { exact: true, name: "Trocar cliente" })
    );
    const dialog = page.getByRole("dialog", { name: "Trocar cliente" });
    await tap(dialog.getByRole("combobox", { exact: true, name: "Cliente" }));
    await tap(page.getByRole("option", { exact: true, name: "Bruno Lima" }));
    await tap(dialog.getByRole("button", { name: "Trocar cliente" }));
    await expect.poll(() => count(asked, "sale/reassignCustomer")).toBe(1);
    expect(taps).toBe(4);
  });

  test("removing asks first: Cancelar sends nothing, Sim sends once", async ({
    page,
  }) => {
    const asked = await openCustomer(page);
    await page.getByRole("button", { name: "Remover cliente" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Remover o cliente desta venda?",
    });
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();
    expect(count(asked, "sale/unassignCustomer")).toBe(0);

    await page.getByRole("button", { name: "Remover cliente" }).click();
    await dialog.getByRole("button", { name: "Sim, remover cliente" }).click();
    await expect.poll(() => count(asked, "sale/unassignCustomer")).toBe(1);
  });

  test("Trocar cliente without another active customer is off, reads why and does nothing on Enter", async ({
    page,
  }) => {
    const asked = await openCustomer(page);
    // the choice is made in a dialog: the button that opens it, then the one that sends the choice
    await page.getByRole("button", { name: "Trocar cliente" }).click();
    const dialog = page.getByRole("dialog", { name: "Trocar cliente" });
    const swap = dialog.getByRole("button", { name: "Trocar cliente" });
    await expect(swap).toHaveAttribute("aria-disabled", "true");
    await expect(swap).toHaveAccessibleDescription("Escolha um cliente ativo.");
    await swap.focus();
    await expect(swap).toBeFocused();
    await page.keyboard.press("Enter");
    // let a call that would be made reach the route
    await page.waitForTimeout(300);
    expect(count(asked, "sale/reassignCustomer")).toBe(0);
  });

  test("Associar cliente with nobody chosen is off, reads why and does nothing on Enter", async ({
    page,
  }) => {
    const link = saleDetailAnswers({ withReturn: true })[
      "sale/getCustomerLink"
    ] as object;
    const asked = await openCustomer(page, {
      ...link,
      current: { customerId: null, version: 2 },
    });
    await page.getByRole("button", { name: "Associar cliente" }).click();
    const dialog = page.getByRole("dialog", { name: "Associar cliente" });
    const assign = dialog.getByRole("button", { name: "Associar cliente" });
    await expect(assign).toHaveAttribute("aria-disabled", "true");
    await expect(assign).toHaveAccessibleDescription(
      "Escolha um cliente ativo."
    );
    await assign.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect(count(asked, "sale/assignCustomer")).toBe(0);
  });
});
