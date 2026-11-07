/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The customer list read at 320 px with the browser font at 20 px (`./reflow`): the phone and the e-mail of every row
 * are whole, each on a line of its own when they do not fit side by side, and the row is still the one button that
 * opens the form. With the default font (16 px) a short phone and e-mail stay on one line.
 */
skipOutsideChromium();

const TOUCH = 44;
const EDIT_NAME = /Editar/;
const NAME_LENGTH = 60;
const EMAIL_LENGTH = 40;
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const DAY = "2026-10-14T12:00:00.000Z";
const id = (n: number) => `0199c2d0-0000-7000-8000-0000000000${n}`;

const LONG_NAME =
  "Maria Fernanda de Albuquerque e Souza Cavalcanti de Oliveira Santos";
const LONG_EMAIL = "mariafernanda.albuquerque@exemplo.com.br";

const customer = (n: number, name: string, extra: object = {}) => ({
  anonymizedAt: null,
  archivedAt: null,
  createdAt: DAY,
  email: null,
  id: id(60 + n),
  name,
  notes: null,
  organizationId: ORGANIZATION.id,
  phone: "11912345678",
  status: "active",
  updatedAt: DAY,
  version: 1,
  ...extra,
});

const ONLY_EMAIL = "caio.prado.de.almeida.junior@exemplo.com";
const WIDE = customer(1, LONG_NAME, { email: LONG_EMAIL });
const ONLY_PHONE = customer(2, "Bia Souza");
const NO_PHONE = customer(3, "Caio Prado", { email: ONLY_EMAIL, phone: null });
const SHORT = customer(4, "Ana", { email: "a@b.co", phone: "1133334444" });
const ACTIVE = [WIDE, ONLY_PHONE, NO_PHONE, SHORT];
const ARCHIVED_WIDE = customer(5, "Dora Archived Customer", {
  archivedAt: DAY,
  email: LONG_EMAIL,
  status: "archived",
});
const ANONYMIZED = customer(6, "Cliente anonimizado", {
  anonymizedAt: DAY,
  archivedAt: DAY,
  email: null,
  phone: null,
  status: "archived",
});
const ARCHIVED = [ARCHIVED_WIDE, ANONYMIZED];

const rpc = (json: unknown) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

async function openCustomers(page: Page, width: number, fontPixels: number) {
  await openReflowViewport(page, { fontPixels, width });
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    if (procedure === "customer/list") {
      const status = route.request().postDataJSON()?.json?.status;
      return route.fulfill(
        rpc({ customers: status === "archived" ? ARCHIVED : ACTIVE })
      );
    }
    return route.abort("internetdisconnected");
  });
  await page.goto("/customers");
  await expect(
    page.getByRole("heading", { exact: true, level: 1, name: "Clientes" })
  ).toBeVisible();
  await expect(page.locator("[data-customer-id]")).toHaveCount(ACTIVE.length);
  await expectReflowFont(page, fontPixels);
}

/** The lines the contacts of one row take: the top of each contact box, and whether it is whole. */
function contactBoxes(page: Page, customerId: string) {
  return page.evaluate((target) => {
    const support = document.getElementById(`customer-support-${target}`);
    if (support === null) {
      return null;
    }
    return {
      contacts: [...support.children].map((item) => {
        const { bottom, left, right, top } = item.getBoundingClientRect();
        return {
          bottom,
          clientWidth: item.clientWidth,
          left,
          right,
          scrollWidth: item.scrollWidth,
          text: item.textContent ?? "",
          top,
        };
      }),
      row: (() => {
        const { left, right } = support
          .closest("li")
          ?.getBoundingClientRect() ?? {
          left: 0,
          right: 0,
        };
        return { left, right };
      })(),
      text: support.textContent ?? "",
    };
  }, customerId);
}

reflowTest(
  "a 320 px com letra de 20 px o telefone e o e-mail leem inteiros, cada um na sua linha",
  async ({ page }) => {
    await openCustomers(page, 320, 20);
    const both = await contactBoxes(page, WIDE.id);
    expect(both?.contacts.map((item) => item.text)).toEqual([
      "(11) 91234-5678",
      LONG_EMAIL,
    ]);
    const [phone, email] = both?.contacts ?? [];
    expect(email?.text.length ?? 0).toBeGreaterThanOrEqual(EMAIL_LENGTH);
    await expect(
      page.getByRole("button", { exact: true, name: `Editar ${LONG_NAME}` })
    ).toBeVisible();
    expect(LONG_NAME.length).toBeGreaterThanOrEqual(NAME_LENGTH);
    expect(
      email?.top ?? 0,
      "o e-mail desce para a sua linha"
    ).toBeGreaterThanOrEqual(phone?.bottom ?? Number.POSITIVE_INFINITY);
    for (const item of both?.contacts ?? []) {
      expect(item.scrollWidth, item.text).toBeLessThanOrEqual(
        item.clientWidth + 1
      );
      expect(item.right, `${item.text} dentro da linha`).toBeLessThanOrEqual(
        (both?.row.right ?? 0) + 0.5
      );
      expect(item.left).toBeGreaterThanOrEqual((both?.row.left ?? 0) - 0.5);
    }
    const onlyPhone = await contactBoxes(page, ONLY_PHONE.id);
    expect(onlyPhone?.text).toBe("(11) 91234-5678");
    const onlyEmail = await contactBoxes(page, NO_PHONE.id);
    expect(onlyEmail?.text).toBe(ONLY_EMAIL);
    const list = page.getByRole("list", { name: "Clientes" });
    await assertNothingClipped(list);
    await assertNoEllipsis(list.locator("[data-customer-id]"));
    await assertNoPageScroll(page);
  }
);

reflowTest(
  "a 320 px com letra de 20 px o cliente arquivado e o anonimizado leem inteiros",
  async ({ page }) => {
    await openCustomers(page, 320, 20);
    await page.getByRole("tab", { name: "Arquivados" }).click();
    await expect(page.locator("[data-customer-id]")).toHaveCount(
      ARCHIVED.length
    );
    const archived = await contactBoxes(page, ARCHIVED_WIDE.id);
    expect(archived?.contacts.map((item) => item.text)).toEqual([
      "(11) 91234-5678",
      LONG_EMAIL,
    ]);
    const anonymized = page.locator(`[data-customer-id="${ANONYMIZED.id}"]`);
    await expect(anonymized).toContainText("Cliente anonimizado");
    await expect(anonymized).toContainText("Dados pessoais removidos");
    await expect(
      anonymized.getByRole("button", { name: EDIT_NAME })
    ).toHaveCount(0);
    const list = page.getByRole("list", { name: "Clientes" });
    await assertNothingClipped(list);
    await assertNoEllipsis(list.locator("[data-customer-id]"));
    await assertNoPageScroll(page);
  }
);

reflowTest(
  "a linha continua um botão só que abre o formulário, com 44 px e o mesmo nome",
  async ({ page }) => {
    await openCustomers(page, 320, 20);
    const boxes = await Promise.all(
      ACTIVE.map(async (entry) => {
        const button = page.getByRole("button", {
          exact: true,
          name: `Editar ${entry.name}`,
        });
        await expect(button).toHaveCount(1);
        return { box: await button.boundingBox(), name: entry.name };
      })
    );
    for (const { box, name } of boxes) {
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(TOUCH);
      expect(box?.width ?? 0, name).toBeGreaterThanOrEqual(TOUCH);
    }
    await page
      .getByRole("button", { exact: true, name: `Editar ${LONG_NAME}` })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Editar cliente" })
    ).toBeVisible();
  }
);

const WIDE_WINDOW = 1280;

for (const width of [360, WIDE_WINDOW]) {
  reflowTest(
    `a ${width} px com letra de 16 px o telefone e o e-mail curtos ficam na mesma linha, `,
    async ({ page }) => {
      await openCustomers(page, width, 16);
      const short = await contactBoxes(page, SHORT.id);
      expect(short?.text).toBe("(11) 3333-4444 · a@b.co");
      const [phone, email] = short?.contacts ?? [];
      expect(
        Math.abs((email?.top ?? 0) - (phone?.top ?? 0)),
        "na mesma linha"
      ).toBeLessThanOrEqual(1);
      await assertNoPageScroll(page);
    },
    { coarse: width !== WIDE_WINDOW }
  );
}
