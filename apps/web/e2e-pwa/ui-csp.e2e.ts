/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { productionPolicy, watchCspViolations } from "../e2e/csp-fixture";
import { PWA_ORIGIN } from "../e2e/run-settings";

const DARK = /\bdark\b/;
const NOT_DARK = /^(?!.*\bdark\b).*$/;
const APPEARANCE = /^Aparência:/;
const OWN_FONT_FILE = new RegExp(
  `^${PWA_ORIGIN.replaceAll(".", "\\.")}/assets/geist[\\w-]+\\.woff2$`
);

/**
 * ADR 0103, condition 2 (and V1 of the architect): every interface primitive opens under the shell's real
 * Content-Security-Policy with zero violations, in both themes. The policy is the one of the build's
 * `_headers`, sent by the static server itself (scripts/serve-static.mjs), not rewritten by the test. The
 * page also carries the characters of every font face in use (Portuguese accents and symbols): a face
 * inlined as `data:` would be refused by `font-src 'self'` and show up here.
 */
const THEMES = [
  { colorScheme: "light", dark: false, name: "claro", stored: "claro" },
  { colorScheme: "light", dark: true, name: "escuro", stored: "escuro" },
  { colorScheme: "dark", dark: true, name: "sistema escuro", stored: null },
] as const;

async function openGallery(page: Page, stored: string | null) {
  if (stored) {
    await page.addInitScript((theme) => {
      window.localStorage.setItem("polaris-tema", theme);
    }, stored);
  }
  const response = await page.goto("/ui-galeria");
  expect(response?.headers()["content-security-policy"]).toBe(productionPolicy);
  await expect(
    page.getByRole("heading", { name: "Galeria da interface" })
  ).toBeVisible();
}

async function openEveryPrimitive(page: Page) {
  await page.getByRole("button", { name: "Abrir diálogo" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancelar a venda?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Voltar" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Abrir popover" }).click();
  await expect(page.getByText("Informe o custo do item")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Informe o custo do item")).toBeHidden();

  await page.getByRole("button", { name: "Abrir menu" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Editar" })).toBeVisible();
  await expect(
    menu.getByRole("menuitemcheckbox", { name: "Mostrar no catálogo" })
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await page.getByRole("combobox", { name: "Método de pagamento" }).click();
  await page.getByRole("option", { name: "Pix" }).click();
  await expect(
    page.getByRole("combobox", { name: "Método de pagamento" })
  ).toContainText("Pix");

  // the icon trigger is named by the text of its tooltip
  await page
    .getByRole("button", { name: "Saldo confirmado pelo servidor" })
    .hover();
  // Base UI's tooltip popup has no tooltip role; the text is what the person reads.
  await expect(page.getByText("Saldo confirmado pelo servidor")).toBeVisible();
  await page.mouse.move(0, 0);

  await page.getByRole("button", { name: "Mostrar aviso" }).click();
  await expect(page.getByText("Venda registrada")).toBeVisible();
  // the viewport is named in Portuguese (Base UI's default is "Notifications")
  await expect(
    page.getByRole("region", { name: "Avisos" }).getByText("Venda registrada")
  ).toBeVisible();
  // Base UI hides the X from assistive technology until the toasts expand (pointer or focus on them).
  await page.getByText("Venda registrada").hover();
  await page.getByRole("button", { name: "Fechar aviso" }).click();
  await expect(page.getByText("Venda registrada")).toBeHidden();

  // the components of the sale: choice card, checkbox and the "R$" field change state under the CSP too
  const sale = page.getByRole("region", { name: "Componentes da venda" });
  await sale.getByText("Transferência", { exact: true }).click();
  await expect(
    sale.getByRole("radio", { name: "Transferência" })
  ).toBeChecked();
  const anticipation = sale.getByRole("checkbox", {
    name: "Pretendo antecipar este recebimento",
  });
  const wasChecked = await anticipation.isChecked();
  await anticipation.click();
  await expect(anticipation).toBeChecked({ checked: !wasChecked });
  await sale.getByRole("textbox", { name: "Preço cobrado" }).fill("49,90");

  const viewport = page
    .getByRole("region", { name: "Área de rolagem" })
    .locator("[data-slot=scroll-area-viewport]");
  await viewport.scrollIntoViewIfNeeded();
  const scrolled = await viewport.evaluate((element) => {
    element.scrollTo(0, element.scrollHeight);
    return {
      // the native scrollbar is hidden by our rule, not by Base UI's <style> (off under the CSP)
      scrollbarWidth: getComputedStyle(element).scrollbarWidth,
      top: element.scrollTop,
    };
  });
  expect(scrolled.top).toBeGreaterThan(0);
  expect(scrolled.scrollbarWidth).toBe("none");
}

for (const theme of THEMES) {
  test(`tema ${theme.name}: cada primitivo abre sob a CSP do _headers sem nenhuma violação`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      colorScheme: theme.colorScheme,
    });
    const page = await context.newPage();
    const csp = await watchCspViolations(page);
    await openGallery(page, theme.stored);
    await expect(page.locator("html")).toHaveClass(
      theme.dark ? DARK : NOT_DARK
    );

    await openEveryPrimitive(page);

    // The appearance menu itself, from this theme to the opposite one.
    await page.getByRole("button", { name: APPEARANCE }).click();
    await page
      .getByRole("menuitemradio", { name: theme.dark ? "Claro" : "Escuro" })
      .click();
    await expect(page.locator("html")).toHaveClass(
      theme.dark ? NOT_DARK : DARK
    );
    // a radio item keeps the menu open, so the person sees the change
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await openEveryPrimitive(page);

    expect(csp.violations()).toEqual([]);
    await context.close();
  });
}

test("as faces da Geist e da Geist Mono vêm de arquivos do próprio app e cobrem os caracteres do português", async ({
  page,
}) => {
  const csp = await watchCspViolations(page);
  const fontRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") {
      fontRequests.push(request.url());
    }
  });
  await openGallery(page, null);
  const sample = page.getByTestId("font-sample");
  await expect(sample).toContainText("áàâãä");
  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    const text =
      document.querySelector("[data-testid=font-sample]")?.textContent ?? "";
    return {
      loaded: [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => face.family.replaceAll('"', "")),
      mono: document.fonts.check('16px "Geist Mono Variable"', text),
      sans: document.fonts.check('16px "Geist Variable"', text),
    };
  });
  expect(faces.loaded).toEqual(
    expect.arrayContaining(["Geist Variable", "Geist Mono Variable"])
  );
  expect(faces.sans).toBe(true);
  expect(faces.mono).toBe(true);
  expect(fontRequests.length).toBeGreaterThanOrEqual(2);
  for (const url of fontRequests) {
    expect(url).toMatch(OWN_FONT_FILE);
  }
  expect(csp.violations()).toEqual([]);
});

test("no CSS do build, a ordem das camadas é theme, base, components e utilities, sem legacy", async ({
  page,
}) => {
  await openGallery(page, null);
  const order = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .flatMap((rule) => {
        if (rule instanceof CSSLayerStatementRule) {
          return [...rule.nameList];
        }
        return rule instanceof CSSLayerBlockRule ? [rule.name] : [];
      })
  );
  // `properties` is Tailwind's own fallback layer for @property, ahead of everything (and below it all).
  const firstSeen = [...new Set(order)];
  expect(firstSeen.filter((name) => name !== "properties")).toEqual([
    "theme",
    "base",
    "components",
    "utilities",
  ]);
});

test("controle: a CSP servida pelo servidor bloqueia um <style> injetado e a fixture o pega", async ({
  page,
}) => {
  const csp = await watchCspViolations(page);
  await openGallery(page, null);
  expect(csp.violations()).toEqual([]);
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = "body { outline: 1px solid red; }";
    document.head.append(style);
  });
  await expect.poll(() => csp.events().length).toBeGreaterThan(0);
  expect(csp.events().join(" ")).toContain("style-src");
});
