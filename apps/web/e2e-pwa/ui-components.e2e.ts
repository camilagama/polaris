/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { watchCspViolations } from "../e2e/csp-fixture";
import { axeViolations } from "./ui-guardrails";

/**
 * The components the sale uses (ADR 0103, section 8, item 3), in the gallery: each one is found by its role and
 * its label, as the e2e of the sale will find it, and axe finds no violation on the page in each theme. The
 * gallery is served by the static server under the CSP of the build's `_headers`; axe is evaluated through the
 * test channel, not as a script of the page, and the CSP watch stays empty.
 */
const THEMES = [
  { colorScheme: "light", name: "claro", stored: "claro" },
  { colorScheme: "light", name: "escuro", stored: "escuro" },
  { colorScheme: "dark", name: "sistema escuro", stored: null },
] as const;

const ANTICIPATION_HELP = /^É uma intenção registrada na venda/;

async function openGallery(page: Page, stored: string | null) {
  if (stored) {
    await page.addInitScript((theme) => {
      window.localStorage.setItem("polaris-tema", theme);
    }, stored);
  }
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("heading", { name: "Galeria da interface" })
  ).toBeVisible();
  // Geist must be in before axe measures contrast and sizes
  await page.evaluate(() => document.fonts.ready);
}

/** The box of a control grown by its touch pseudo-element (the larger of ::before and ::after), in pixels. */
const touchArea = (element: Element) => {
  const box = element.getBoundingClientRect();
  // the touch area is the larger of the two pseudo-elements, resolved to pixels by the browser
  const sizes = (["::before", "::after"] as const).map((pseudo) => {
    const style = getComputedStyle(element, pseudo);
    if (style.content === "none" || style.position !== "absolute") {
      return { height: 0, width: 0 };
    }
    const px = (value: string) => Number.parseFloat(value) || 0;
    return {
      height: box.height - px(style.top) - px(style.bottom),
      width: box.width - px(style.left) - px(style.right),
    };
  });
  return {
    height: Math.max(box.height, ...sizes.map((size) => size.height)),
    width: Math.max(box.width, ...sizes.map((size) => size.width)),
  };
};

test("os componentes da venda têm papel e rótulo", async ({ page }) => {
  await openGallery(page, null);
  const sale = page.getByRole("region", { name: "Componentes da venda" });

  // Badge: text, never only color
  await expect(sale.getByText("Sincronizado", { exact: true })).toBeVisible();
  await expect(sale.getByText("Offline · 3")).toBeVisible();

  // Alert: only the error interrupts (alert); the warning and the information are a polite status
  await expect(
    sale
      .getByRole("alert")
      .filter({ hasText: "Não deu para carregar os perfis." })
  ).toBeVisible();
  await expect(
    sale.getByRole("status").filter({ hasText: "Sem internet." })
  ).toBeVisible();
  await expect(
    sale
      .getByRole("status")
      .filter({ hasText: "Esta venda ainda não foi enviada." })
  ).toBeVisible();

  // The profile hint is a field description tied to the select, not an alert
  await expect(
    sale.getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
  ).toHaveAccessibleDescription(
    "Sem perfil, taxas e prazo ficam como estimativa."
  );

  await expect(
    sale.getByRole("status").filter({ hasText: "Sem perfil, taxas e prazo" })
  ).toHaveCount(0);

  // Card: its title is the heading the screen gives it
  await expect(
    sale.getByRole("heading", { level: 3, name: "Itens" })
  ).toBeVisible();
  await expect(
    sale.getByRole("heading", { level: 3, name: "Pagamento" })
  ).toBeVisible();

  // ButtonGroup: − field +, a named group; the field keeps its own label
  const stepper = sale.getByRole("group", { name: "Quantidade" });
  await expect(
    stepper.getByRole("button", { name: "Diminuir a quantidade" })
  ).toBeVisible();
  await expect(
    stepper.getByRole("button", { name: "Aumentar a quantidade" })
  ).toBeVisible();
  await expect(sale.getByRole("textbox", { name: "Quantidade" })).toHaveValue(
    "2"
  );

  // Field + InputGroup with the "R$" addon: label, description, and a click on "R$" focuses the field
  const price = sale.getByRole("textbox", { name: "Preço cobrado" });
  await expect(price).toHaveAccessibleDescription(
    "Tabela: R$ 50,00 por unidade"
  );
  // the addon lets the pointer through (pointer-events: none), so the click goes to where the person taps
  await price.scrollIntoViewIfNeeded();
  const addon = await sale
    .getByText("R$", { exact: true })
    .first()
    .boundingBox();
  expect(addon).not.toBeNull();
  if (addon) {
    await page.mouse.click(
      addon.x + addon.width / 2,
      addon.y + addon.height / 2
    );
  }
  await expect(price).toBeFocused();

  // FieldError: invalid field, error announced and tied to the field
  const empty = sale.getByRole("textbox", { name: "Preço do segundo item" });
  await expect(empty).toHaveAttribute("aria-invalid", "true");
  await expect(empty).toHaveAccessibleDescription(
    "Informe um preço maior que zero."
  );
  await expect(
    sale
      .getByRole("alert")
      .filter({ hasText: "Informe um preço maior que zero." })
  ).toBeVisible();

  // RadioGroup of choice cards inside a FieldSet: the legend names the group, each card names its radio
  const methods = sale.getByRole("radiogroup", {
    name: "Forma de pagamento",
  });
  await expect(
    sale.getByRole("group", { name: "Forma de pagamento" })
  ).toBeVisible();
  await expect(methods.getByRole("radio")).toHaveCount(6);
  await expect(methods.getByRole("radio", { name: "Pix" })).toBeChecked();
  await sale.getByText("Dinheiro", { exact: true }).click();
  await expect(methods.getByRole("radio", { name: "Dinheiro" })).toBeChecked();
  await expect(methods.getByRole("radio", { name: "Pix" })).not.toBeChecked();
  await page.keyboard.press("ArrowRight");
  const credit = methods.getByRole("radio", { name: "Crédito" });
  await expect(credit).toBeFocused();
  // inside a choice card the card draws the focus outline: the radio adds no 3 px halo of its own
  expect(
    await credit.evaluate((radio) => ({
      card: getComputedStyle(radio.closest("label") as Element).outlineWidth,
      halo: getComputedStyle(radio).boxShadow,
    }))
  ).toEqual({ card: "3px", halo: expect.not.stringContaining("3px") });

  // Checkbox: named by its label, described by its help, toggled by the label
  const anticipation = sale.getByRole("checkbox", {
    name: "Pretendo antecipar este recebimento",
  });
  await expect(anticipation).toHaveAccessibleDescription(ANTICIPATION_HELP);
  await expect(anticipation).not.toBeChecked();
  await sale.getByText("Pretendo antecipar este recebimento").click();
  await expect(anticipation).toBeChecked();
  await anticipation.press("Space");
  await expect(anticipation).not.toBeChecked();

  // Separator
  await expect(sale.getByRole("separator")).toHaveCount(3);
});

for (const theme of THEMES) {
  test(`tema ${theme.name}: axe não acha violação de WCAG 2.2 AA na galeria`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      colorScheme: theme.colorScheme,
    });
    const page = await context.newPage();
    const csp = await watchCspViolations(page);
    await openGallery(page, theme.stored);
    expect(await axeViolations(page)).toEqual([]);
    expect(csp.violations()).toEqual([]);
    await context.close();
  });
}

test("com toque, radio, caixa de seleção, botões do contador e campo com R$ têm área de 48 px", async ({
  isMobile,
  page,
}) => {
  test.skip(
    !isMobile,
    "the touch area exists only with touch (pointer: coarse or under 760 px)"
  );
  await openGallery(page, null);
  const sale = page.getByRole("region", { name: "Componentes da venda" });
  const targets = [
    sale.getByRole("radio", { name: "Pix" }),
    sale.getByRole("checkbox", { name: "Pretendo antecipar este recebimento" }),
    sale.getByRole("button", { name: "Diminuir a quantidade" }),
    sale.getByRole("button", { name: "Aumentar a quantidade" }),
    sale.locator("[data-slot=input-group]").filter({ hasText: "R$" }).first(),
  ];
  const areas = await Promise.all(
    targets.map((target) => target.evaluate(touchArea))
  );
  for (const area of areas) {
    expect(area.height).toBeGreaterThanOrEqual(48);
    expect(area.width).toBeGreaterThanOrEqual(48);
  }
});

test("controle: o axe desta página acusa uma imagem sem texto alternativo", async ({
  page,
}) => {
  await openGallery(page, null);
  await page.evaluate(() => {
    const image = document.createElement("img");
    image.src = "/icons/icon-192.png";
    document.querySelector("main")?.append(image);
  });
  const violations = await axeViolations(page);
  expect(violations.map((violation) => violation.id)).toContain("image-alt");
});
