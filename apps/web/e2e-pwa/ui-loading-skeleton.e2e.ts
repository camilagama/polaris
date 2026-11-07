import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { historyStates } from "./ui-history-states";
import { saleDetailStates } from "./ui-sale-detail-states";
import { stockStates } from "./ui-stock-states";

/**
 * The loading of the stock, of the sale detail and of the sales history: a `role="status"` card that carries
 * the sentence for the screen reader and, as the picture, the skeleton (hidden from the screen reader). The states
 * are the ones the guardrails open (`ui-*-states.ts`), the read never answers.
 */
const LOADING: ReadonlyArray<{
  message: string;
  name: string;
  open: (page: Page) => Promise<void>;
}> = [
  {
    message: "Carregando o estoque…",
    name: "Estoque",
    open: stockStates.loading,
  },
  {
    message: "Carregando venda…",
    name: "Detalhe da venda",
    open: saleDetailStates.loading,
  },
  {
    message: "Carregando vendas…",
    name: "Histórico de vendas",
    open: historyStates.loading,
  },
];

for (const screen of LOADING) {
  test(`${screen.name}: carregando é um status com a frase para o leitor de tela e o esqueleto escondido dele`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "a mesma tela");
    await screen.open(page);

    const status = page.getByRole("status").filter({ hasText: screen.message });
    await expect(status).toHaveCount(1);
    await expect(status).toHaveAttribute("aria-busy", "true");
    // the sentence is read, not drawn
    await expect(status.locator("p.sr-only")).toHaveText(screen.message);
    // the picture: skeletons, every one of them out of the screen reader's way
    const drawn = status.locator('[data-slot="skeleton"]');
    await expect(drawn).not.toHaveCount(0);
    await expect(
      status.locator('[aria-hidden="true"] [data-slot="skeleton"]')
    ).toHaveCount(await drawn.count());
    // no text of the card is drawn: it is only the skeleton
    await expect(status).toHaveText(screen.message);
  });
}
