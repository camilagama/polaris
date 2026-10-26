/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { watchCspViolations } from "../e2e/csp-fixture";

/**
 * The editor of each pill of the filter bar on a phone (t414), in the gallery: below 760 px it is the form Dialog of
 * the whole screen (title = the field, "Aplicar" and "Cancelar" in the fixed footer), nothing is applied before
 * "Aplicar", and Cancelar, ×, Esc and the step back of the phone close it with the filter as it was and the focus on the
 * pill that opened it. From 760 px it is still the Popover of before. The bar starts with Período 01/10 a 24/10,
 * Situação Paga and Cliente Maria Souza ("hoje" is 24/10/2026).
 */
const PHONE = { height: 740, width: 360 } as const;
const DESKTOP = { height: 800, width: 1280 } as const;
const GALLERY = /\/ui-galeria$/;
const STATUS_ITEM = /^Situação/;

/** The gallery, opened after another page: a step back that leaves the screen lands there. */
async function openGallery(page: Page) {
  await page.goto("/termos");
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("heading", { name: "Galeria da interface" })
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const bar = (page: Page) =>
  page.getByRole("search", { exact: true, name: "Filtrar vendas" });
// by `aria-label`, not by role: under the Dialog the page behind is `aria-hidden`, and a hidden element is not found by role and has no name
const pill = (page: Page, label: string) =>
  page.locator(
    `search[aria-label="Filtrar vendas"] button[aria-label^="${label}: "][aria-label$=", editar"]`
  );
const addButton = (page: Page) =>
  page.locator('search[aria-label="Filtrar vendas"] [data-slot="filter-add"]');
const count = (page: Page) => page.getByTestId("filtros-contagem");
const editor = (page: Page, label: string) =>
  page.getByRole("dialog", { name: label });
const apply = (open: Locator) =>
  open.getByRole("button", { exact: true, name: "Aplicar" });
const cancel = (open: Locator) =>
  open.getByRole("button", { exact: true, name: "Cancelar" });
const shortcut = (open: Locator, name: string) =>
  open
    .getByRole("group", { name: "Atalhos do período" })
    .getByRole("button", { name });
const entry = (page: Page) =>
  page.evaluate(() => history.state?.polarisDialog ?? null);

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found as { height: number; width: number; x: number; y: number };
}

/** Opens the editor of a pill that is there and waits for its content (the calendar comes on demand). */
async function openPill(page: Page, label: string) {
  await pill(page, label).click();
  const open = editor(page, label);
  await expect(open).toBeVisible();
  if (label === "Período") {
    await expect(open.getByRole("grid").first()).toBeVisible();
  }
  return open;
}

/** After the editor closed by itself its entry in the history goes away: the next step back leaves the screen. */
async function expectNoEntryLeft(page: Page) {
  await expect.poll(() => entry(page)).toBeNull();
  await expect(page).toHaveURL(GALLERY);
}

test.describe("a 360 px", () => {
  test.use({ viewport: PHONE });

  for (const label of ["Período", "Situação", "Cliente"]) {
    test(`${label}: abre em tela inteira com o nome do filtro no título e Aplicar e Cancelar no rodapé fixo`, async ({
      page,
    }) => {
      const csp = await watchCspViolations(page);
      await openGallery(page);
      const open = await openPill(page, label);
      await expect(open).toHaveAttribute("data-layout", "form");
      await expect(open.getByRole("heading", { name: label })).toBeVisible();
      const screen = await box(open);
      expect(screen.x).toBeCloseTo(0, 0);
      expect(screen.y).toBeCloseTo(0, 0);
      expect(screen.width).toBeCloseTo(PHONE.width, 0);
      expect(screen.height).toBeCloseTo(PHONE.height, 0);
      // the footer is fixed at the bottom of the screen, both buttons in sight
      const footer = await box(open.locator('[data-slot="dialog-footer"]'));
      expect(footer.y + footer.height).toBeCloseTo(PHONE.height, 0);
      await expect(apply(open)).toBeVisible();
      await expect(cancel(open)).toBeVisible();
      // no Dialog inside a Dialog, and no Popover next to it
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(
        0
      );
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        )
      ).toBeLessThanOrEqual(0);
      expect(csp.violations()).toEqual([]);
    });
  }

  test("Aplicar grava o filtro e fecha, e o foco volta à pílula; nada vale antes dele", async ({
    page,
  }) => {
    await openGallery(page);

    const status = await openPill(page, "Situação");
    await status.getByRole("button", { name: "Cancelada" }).click();
    // a touch on the option is the draft: the dialog stays and the filter is still "Paga"
    await expect(status).toBeVisible();
    await expect(pill(page, "Situação")).toHaveAttribute(
      "aria-label",
      "Situação: Paga, editar"
    );
    await apply(status).click();
    await expect(status).toBeHidden();
    await expect(pill(page, "Situação")).toHaveAttribute(
      "aria-label",
      "Situação: Cancelada, editar"
    );
    await expect(pill(page, "Situação")).toBeFocused();
    await expectNoEntryLeft(page);

    const client = await openPill(page, "Cliente");
    const field = client.getByRole("textbox", { name: "Cliente" });
    await expect(field).toHaveValue("Maria Souza");
    await field.fill("Ana Lima");
    await expect(pill(page, "Cliente")).toHaveAttribute(
      "aria-label",
      "Cliente: Maria Souza, editar"
    );
    await apply(client).click();
    await expect(client).toBeHidden();
    await expect(pill(page, "Cliente")).toHaveAttribute(
      "aria-label",
      "Cliente: Ana Lima, editar"
    );
    await expect(pill(page, "Cliente")).toBeFocused();

    // Enter in the text applies as the button does; an empty draft takes the filter out
    const again = await openPill(page, "Cliente");
    await again.getByRole("textbox", { name: "Cliente" }).fill("");
    await page.keyboard.press("Enter");
    await expect(again).toBeHidden();
    await expect(pill(page, "Cliente")).toHaveCount(0);
    await expect(addButton(page)).toBeFocused();

    // the period: a shortcut and then two days are drafts too, and "Limpar" empties the draft
    const period = await openPill(page, "Período");
    await shortcut(period, "7 dias").click();
    await expect(period).toBeVisible();
    await expect(pill(page, "Período")).toHaveAttribute(
      "aria-label",
      "Período: 01/10 a 24/10, editar"
    );
    await period.locator('button[data-day="2026-10-20"]').click();
    await period.locator('button[data-day="2026-10-22"]').click();
    await expect(period).toBeVisible();
    await apply(period).click();
    await expect(period).toBeHidden();
    await expect(pill(page, "Período")).toHaveAttribute(
      "aria-label",
      "Período: 20/10 a 22/10, editar"
    );
    await expect(pill(page, "Período")).toBeFocused();

    const clearing = await openPill(page, "Período");
    await clearing.getByRole("button", { name: "Limpar" }).click();
    await expect(pill(page, "Período")).toHaveAttribute(
      "aria-label",
      "Período: 20/10 a 22/10, editar"
    );
    await apply(clearing).click();
    await expect(pill(page, "Período")).toHaveCount(0);
    await expect(count(page)).toHaveText("1 filtro ativo");
  });

  for (const close of ["Cancelar", "Esc", "voltar", "×"] as const) {
    test(`${close} fecha sem aplicar: o rascunho não vira filtro e o foco volta à pílula`, async ({
      page,
    }) => {
      await openGallery(page);
      const open = await openPill(page, "Situação");
      await open.getByRole("button", { name: "Cancelada" }).click();
      expect(await entry(page)).not.toBeNull();
      switch (close) {
        case "Cancelar":
          await cancel(open).click();
          break;
        case "Esc":
          await page.keyboard.press("Escape");
          break;
        case "voltar":
          await page.goBack();
          break;
        default:
          await open.getByRole("button", { name: "Fechar" }).click();
      }
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(pill(page, "Situação")).toHaveAttribute(
        "aria-label",
        "Situação: Paga, editar"
      );
      await expect(pill(page, "Situação")).toBeFocused();
      await expect(count(page)).toHaveText("3 filtros ativos");
      await expectNoEntryLeft(page);
      // the draft is gone: the dialog opens again from the filter
      const again = await openPill(page, "Situação");
      await expect(again.getByRole("button", { name: "Paga" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
  }

  test("o texto digitado e o período escolhido também ficam de fora ao cancelar", async ({
    page,
  }) => {
    await openGallery(page);
    const client = await openPill(page, "Cliente");
    await client.getByRole("textbox", { name: "Cliente" }).fill("Outro nome");
    await page.keyboard.press("Escape");
    await expect(client).toBeHidden();
    await expect(pill(page, "Cliente")).toHaveAttribute(
      "aria-label",
      "Cliente: Maria Souza, editar"
    );

    const period = await openPill(page, "Período");
    await shortcut(period, "Hoje").click();
    await cancel(period).click();
    await expect(period).toBeHidden();
    await expect(pill(page, "Período")).toHaveAttribute(
      "aria-label",
      "Período: 01/10 a 24/10, editar"
    );
    await expect(pill(page, "Período")).toBeFocused();
  });

  test("período pela metade: com só o primeiro dia marcado o Aplicar está desligado e descrito pelo aviso, e o dia não se perde", async ({
    page,
  }) => {
    await openGallery(page);
    const period = await openPill(page, "Período");
    await expect(apply(period)).not.toHaveAttribute("aria-disabled", "true");
    await period.locator('button[data-day="2026-10-20"]').click();
    await expect(apply(period)).toHaveAttribute("aria-disabled", "true");
    await expect(apply(period)).toHaveAccessibleDescription(
      "Início 20/10/2026. Escolha o último dia."
    );
    await apply(period).click({ force: true });
    await expect(period).toBeVisible();
    await period.locator('button[data-day="2026-10-22"]').click();
    await expect(apply(period)).not.toHaveAttribute("aria-disabled", "true");
    await apply(period).click();
    await expect(period).toBeHidden();
    await expect(pill(page, "Período")).toHaveAttribute(
      "aria-label",
      "Período: 20/10 a 22/10, editar"
    );
  });

  test("passar de 760 px com o editor aberto (celular girado, janela maior) o fecha: nada aplicado, sem entrada sobrando", async ({
    page,
  }) => {
    await openGallery(page);
    const open = await openPill(page, "Situação");
    await open.getByRole("button", { name: "Cancelada" }).click();
    await page.setViewportSize(DESKTOP);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectNoEntryLeft(page);
    await expect(pill(page, "Situação")).toHaveAttribute(
      "aria-label",
      "Situação: Paga, editar"
    );
  });

  test("campo novo pelo menu: abre o editor em tela inteira; Cancelar tira a pílula e o foco vai a Filtrar; Aplicar a mantém", async ({
    page,
  }) => {
    await openGallery(page);
    await bar(page)
      .getByRole("button", { name: "Tirar o filtro Situação" })
      .click();
    await expect(pill(page, "Situação")).toHaveCount(0);

    await addButton(page).click();
    await page
      .getByRole("menu", { name: "Filtrar por" })
      .getByRole("menuitem", { name: STATUS_ITEM })
      .click();
    const open = editor(page, "Situação");
    await expect(open).toHaveAttribute("data-layout", "form");
    await expect(pill(page, "Situação")).toHaveAttribute(
      "aria-label",
      "Situação: Escolher, editar"
    );
    await cancel(open).click();
    await expect(open).toBeHidden();
    await expect(pill(page, "Situação")).toHaveCount(0);
    await expect(addButton(page)).toBeFocused();
    await expect(count(page)).toHaveText("2 filtros ativos");

    await addButton(page).click();
    await page
      .getByRole("menu", { name: "Filtrar por" })
      .getByRole("menuitem", { name: STATUS_ITEM })
      .click();
    const second = editor(page, "Situação");
    await second.getByRole("button", { name: "Cancelada" }).click();
    await apply(second).click();
    await expect(second).toBeHidden();
    await expect(pill(page, "Situação")).toHaveAttribute(
      "aria-label",
      "Situação: Cancelada, editar"
    );
    await expect(pill(page, "Situação")).toBeFocused();
    await expect(count(page)).toHaveText("3 filtros ativos");
  });

  test("sem conexão a Busca continua bloqueada com o motivo: a pílula não abre editor nenhum", async ({
    page,
  }) => {
    await openGallery(page);
    const search = page.getByRole("search", {
      exact: true,
      name: "Filtrar vendas sem conexão",
    });
    const blocked = search.getByRole("button", {
      name: "Produto vendido: Camiseta",
    });
    await expect(blocked).toHaveAttribute("aria-disabled", "true");
    await expect(blocked).toHaveAccessibleDescription("Só com conexão");
    await blocked.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await entry(page)).toBeNull();
  });
});

test.describe("a 1280 px", () => {
  test.use({ viewport: DESKTOP });

  test("o editor continua sendo o Popover de antes, sem Aplicar nem Cancelar", async ({
    page,
  }) => {
    await openGallery(page);
    const open = await openPill(page, "Situação");
    await expect(open).not.toHaveAttribute("data-layout", "form");
    await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(1);
    await expect(open.getByRole("button", { name: "Aplicar" })).toHaveCount(0);
    await expect(cancel(open)).toHaveCount(0);
    expect(await entry(page)).toBeNull();
    // a touch on the option applies at once, as it did
    await open.getByRole("button", { name: "Cancelada" }).click();
    await expect(open).toBeHidden();
    await expect(pill(page, "Situação")).toHaveAttribute(
      "aria-label",
      "Situação: Cancelada, editar"
    );
    await expect(pill(page, "Situação")).toBeFocused();
  });
});
