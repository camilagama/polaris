import { expect, type Locator, type Page } from "@playwright/test";

/** The sale screen (/sales), by role and label only. */

export interface SaleLineInput {
  search: string;
  option: RegExp;
  quantity: number;
  charged: string;
  /** Filled when the catalog has no list price. */
  listed?: string;
}

/** The value (`<dd>`) of a row (`<dt>`) of a definition list inside `scope`. */
export function termValue(scope: Locator, label: string | RegExp): Locator {
  const exact = typeof label === "string" ? new RegExp(`^${label}$`) : label;
  return scope
    .locator("div")
    .filter({ has: scope.page().getByRole("term").filter({ hasText: exact }) })
    .last()
    .getByRole("definition");
}

export async function fillSale(page: Page, lines: SaleLineInput[], discountPercents: string[]): Promise<void> {
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: one item after the other, as a person fills the form
      await page.getByRole("button", { name: "Adicionar item" }).click();
    }
    const item = page.getByRole("group", { name: `Item ${index + 1}`, exact: true });
    await item.getByLabel("Produto ou variante").fill(line.search);
    await item.getByRole("list", { name: "Variantes encontradas" }).getByRole("button", { name: line.option }).click();
    await item.getByLabel("Quantidade").fill(String(line.quantity));
    if (line.listed !== undefined) {
      await item.getByLabel("Preço de tabela (R$)").fill(line.listed);
    }
    await item.getByLabel("Preço cobrado (R$)").fill(line.charged);
  }
  for (const [index, percent] of discountPercents.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one adjustment after the other
    await page.getByRole("button", { name: "Adicionar ajuste" }).click();
    const adjustment = page.getByRole("group", { name: `Ajuste ${index + 1}`, exact: true });
    await adjustment.getByLabel("Tipo de ajuste").selectOption({ label: "Desconto" });
    await adjustment.getByLabel("Como informar").selectOption({ label: "Percentual (%)" });
    await adjustment.getByLabel("Percentual (%)").fill(percent);
  }
  await page.getByLabel("Método de pagamento").selectOption({ label: "Dinheiro" });
  await page.getByLabel("Perfil de pagamento").selectOption({ label: "Sem perfil de pagamento (taxas e prazo desconhecidos)" });
}

/** Confirms with a double tap (the WARN of the acceptance: one sale only) and returns the confirmed panel. */
export async function confirmSale(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Confirmar venda" }).dblclick();
  const confirmed = page.getByRole("region", { name: /Venda confirmada|já estava confirmada/ });
  await expect(confirmed).toBeVisible();
  return confirmed;
}
