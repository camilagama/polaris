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

/**
 * Resolves when every running animation and transition of the page that lasts at most `LONGEST_ANIMATION_MS` has
 * ended. Playwright's "stable" check (the same box in two frames) can pass in a frame the busy CPU skipped, in the
 * middle of the 200 ms of a panel opening or the 100 ms of a select popup, and the press then lands where the button
 * used to be. Two frames go by first because an animation only shows in `getAnimations()` once the style that starts
 * it was computed. The infinite ones (a skeleton's pulse) and the paused ones are not waited for.
 */
const LONGEST_ANIMATION_MS = 3000;

async function animationsEnded(page: Page): Promise<void> {
  await page.evaluate(async (longest) => {
    const nextFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await nextFrame();
    await nextFrame();
    const entrance = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          Number(
            animation.effect?.getComputedTiming().endTime ??
              Number.POSITIVE_INFINITY
          ) <= longest
      );
    await Promise.all(
      entrance.map((animation) => animation.finished.catch(() => undefined))
    );
  }, LONGEST_ANIMATION_MS);
}

/**
 * Opens the select named `label` inside `scope` and picks the option named `option` (a Base UI Select).
 *
 * The trigger goes to the middle of the viewport first: Playwright leaves a target at the edge of the viewport, where
 * the popup has no room below, opens on one side and flips to the other (shifting the page) while the click on the
 * option is already on its way, so the press lands outside the popup and nothing is chosen. The click on the option
 * waits for the popup to end its entrance, and the trigger must then show the option, so a lost choice fails here
 * and not 60 s later on the next field.
 */
export async function choose(
  page: Page,
  scope: Page | Locator,
  label: string,
  option: string
): Promise<void> {
  const trigger = scope.getByRole("combobox", { exact: true, name: label });
  await trigger.evaluate((element) =>
    element.scrollIntoView({ block: "center" })
  );
  await trigger.click();
  const choice = page.getByRole("option", { exact: true, name: option });
  await expect(choice).toBeVisible();
  await animationsEnded(page);
  await choice.click();
  await expect(trigger).toContainText(option);
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
    await page
      .getByRole("listbox", { name: "Variantes encontradas" })
      .getByRole("option", { name: line.option })
      .click();
    await item.getByLabel("Quantidade").fill(String(line.quantity));
    if (line.listed !== undefined) {
      await item.getByLabel("Preço de tabela").fill(line.listed);
    }
    await item.getByLabel("Preço cobrado").fill(line.charged);
  }
  if (discountPercents.length > 0) {
    // date and adjustments stay closed in one line until "Alterar"
    await page.getByRole("button", { name: "Alterar data e ajustes" }).click();
    await expect(
      page.getByRole("button", { name: "Fechar data e ajustes" })
    ).toBeVisible();
    await animationsEnded(page);
  }
  for (const [index, percent] of discountPercents.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one adjustment after the other
    await page.getByRole("button", { name: "Adicionar ajuste" }).click();
    const adjustment = page.getByRole("group", {
      exact: true,
      name: `Ajuste ${index + 1}`,
    });
    await expect(adjustment).toBeVisible();
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
