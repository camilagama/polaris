import { expect, type Locator, type Page } from "@playwright/test";

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const CONFIRMED_HEADLINE = /Venda confirmada|já estava confirmada/;

/** The sale screen (/sales), by role and label only. */

export interface SaleLineInput {
  charged: string;
  /** Filled when the catalog has no list price. */
  listed?: string;
  option: RegExp;
  quantity: number;
  search: string;
}

/** Opens the select named `label` inside `scope` and picks the option named `option` (a Base UI Select). */
export async function choose(
  page: Page,
  scope: Page | Locator,
  label: string,
  option: string
): Promise<void> {
  await scope.getByRole("combobox", { exact: true, name: label }).click();
  await page.getByRole("option", { exact: true, name: option }).click();
}

/** The value (`<dd>`) of a row (`<dt>`) of a definition list inside `scope`. */
export function termValue(scope: Locator, label: string | RegExp): Locator {
  const exact =
    typeof label === "string"
      ? new RegExp(`^${label.replace(REGEX_SPECIAL, "\\$&")}$`)
      : label;
  return scope
    .locator("div")
    .filter({ has: scope.page().getByRole("term").filter({ hasText: exact }) })
    .last()
    .getByRole("definition");
}

export async function fillSale(
  page: Page,
  lines: SaleLineInput[],
  discountPercents: string[]
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: one item after the other, as a person fills the form
      await page.getByRole("button", { name: "Adicionar item" }).click();
    }
    const item = page.getByRole("group", {
      exact: true,
      name: `Item ${index + 1}`,
    });
    await item.getByLabel("Produto ou variante").fill(line.search);
    await item
      .getByRole("list", { name: "Variantes encontradas" })
      .getByRole("button", { name: line.option })
      .click();
    await item.getByLabel("Quantidade").fill(String(line.quantity));
    if (line.listed !== undefined) {
      await item.getByLabel("Preço de tabela").fill(line.listed);
    }
    await item.getByLabel("Preço cobrado").fill(line.charged);
  }
  for (const [index, percent] of discountPercents.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one adjustment after the other
    await page.getByRole("button", { name: "Adicionar ajuste" }).click();
    const adjustment = page.getByRole("group", {
      exact: true,
      name: `Ajuste ${index + 1}`,
    });
    await choose(page, adjustment, "Tipo de ajuste", "Desconto");
    await choose(page, adjustment, "Como informar", "Percentual (%)");
    await adjustment.getByLabel("Percentual (%)").fill(percent);
  }
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Dinheiro" })
    .check();
  await choose(page, page, "Perfil de pagamento", "Sem perfil de pagamento");
}

/** Confirms with a double tap (the WARN of the acceptance: one sale only) and returns the confirmed panel. */
export async function confirmSale(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Confirmar venda" }).dblclick();
  const confirmed = page.getByRole("region", {
    name: CONFIRMED_HEADLINE,
  });
  await expect(confirmed).toBeVisible();
  return confirmed;
}
