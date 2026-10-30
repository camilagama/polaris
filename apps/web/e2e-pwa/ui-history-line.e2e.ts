/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { historyStates, WORST_CUSTOMER_NAME } from "./ui-history-states";

/**
 * The line of a sale in the history, "cliente · forma de pagamento · itens": with a connection the row is a link
 * that ends in a chevron. On a phone the line is one line: the customer name is cut with an ellipsis and the short
 * payment method and the item count are not cut nor pushed under the total. In the widest case (the longest name,
 * "Transferência", twelve items, a total of five digits) the name is at its minimum, the method is cut last (the item
 * count stays) and nothing reaches the total. The date and time stay on one line. Without a connection the row is
 * plain text, with no link and no chevron.
 */
const LONG_NAME =
  "Maria Aparecida da Conceição Albuquerque de Oliveira Santos Filho";
const DATE_AND_TIME = /^\d\d\/\d\d\/\d{4} · \d\d:\d\d$/;
const WIDTHS = [320, 359, 360];

test.use({ hasTouch: true, isMobile: true });

const lineCount = (element: Element) => {
  const height = Number.parseFloat(getComputedStyle(element).lineHeight);
  return { height, lines: element.getBoundingClientRect().height / height };
};

for (const width of WIDTHS) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { height: 740, width } });

    test("com conexão, o nome longo é cortado em uma linha, o método e os itens ficam inteiros e antes do total, e a linha termina no chevron", async ({
      page,
    }) => {
      await historyStates.list(page);
      const row = page.getByRole("link").filter({ hasText: LONG_NAME });
      const support = row.getByText(`${LONG_NAME} · Crédito · 2 itens`);
      await expect(support).toBeVisible();
      const name = support.getByText(LONG_NAME, { exact: true });
      const rest = support.getByText(" · Crédito · 2 itens");
      expect(
        await rest.evaluate((el) => {
          const text = el.firstElementChild?.firstChild;
          const range = document.createRange();
          range.setStart(text as Node, 0);
          range.setEnd(text as Node, 1);
          return range.getBoundingClientRect().width;
        })
      ).toBeGreaterThan(1);
      const measured = await support.evaluate(lineCount);
      expect(measured.height).toBeGreaterThan(0);
      expect(measured.lines).toBeLessThan(1.05);
      expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        true
      );
      const restBox = await rest.boundingBox();
      const nameBox = await name.boundingBox();
      const totalBox = await row.getByText("1.234,50").boundingBox();
      const chevron = row.locator("svg[aria-hidden='true']").last();
      await expect(chevron).toBeVisible();
      const chevronBox = await chevron.boundingBox();
      expect(restBox).not.toBeNull();
      expect(nameBox).not.toBeNull();
      expect(totalBox).not.toBeNull();
      expect(chevronBox).not.toBeNull();
      expect(nameBox?.width ?? 0).toBeGreaterThan(0);
      expect((nameBox?.x ?? 0) + (nameBox?.width ?? 0)).toBeLessThanOrEqual(
        (restBox?.x ?? 0) + 1
      );
      expect((restBox?.x ?? 0) + (restBox?.width ?? 0)).toBeLessThanOrEqual(
        totalBox?.x ?? 0
      );
      expect((totalBox?.x ?? 0) + (totalBox?.width ?? 0)).toBeLessThanOrEqual(
        chevronBox?.x ?? 0
      );
    });

    for (const customer of [WORST_CUSTOMER_NAME, "Ana Lima"]) {
      test(`no pior caso (${customer.split(" ")[0]}, Transferência, 12 itens, R$ 12.345,67) a linha de apoio não toca o valor nem o chevron (o nome e, se preciso, por último o método são cortados; os itens ficam)`, async ({
        page,
      }) => {
        await historyStates.worstCase(page);
        const row = page.getByRole("link").filter({ hasText: customer });
        const support = row.getByText(`${customer} · Transferência · 12 itens`);
        await expect(support).toBeVisible();
        expect((await support.evaluate(lineCount)).lines).toBeLessThan(1.05);
        const items = support.getByText(" · 12 itens", { exact: true });
        const chevron = row.locator("svg[aria-hidden='true']").last();
        const [name, rest, itemsBox, total, chevronBox, supportBox] =
          await Promise.all([
            support.getByText(customer, { exact: true }).boundingBox(),
            support.getByText(" · Transferência · 12 itens").boundingBox(),
            items.boundingBox(),
            row.getByText("12.345,67").boundingBox(),
            chevron.boundingBox(),
            support.boundingBox(),
          ]);
        for (const box of [
          name,
          rest,
          itemsBox,
          total,
          chevronBox,
          supportBox,
        ]) {
          expect(box).not.toBeNull();
        }
        const right = (box: typeof name) => (box?.x ?? 0) + (box?.width ?? 0);
        for (const box of [name, rest, itemsBox, supportBox]) {
          expect(right(box)).toBeLessThanOrEqual(total?.x ?? 0);
        }
        expect(right(total)).toBeLessThanOrEqual(chevronBox?.x ?? 0);
        expect(name?.width ?? 0).toBeGreaterThan(30);
        expect(right(itemsBox)).toBeLessThanOrEqual(right(supportBox) + 0.5);
      });
    }

    test("um nome curto aparece inteiro, e a data e a hora ficam em uma linha em toda venda", async ({
      page,
    }) => {
      await historyStates.list(page);
      const name = page
        .getByRole("link")
        .filter({ hasText: "Ângela Souza" })
        .getByText("Ângela Souza", { exact: true });
      expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        false
      );
      const dates = page
        .getByRole("list", { name: "Vendas" })
        .getByText(DATE_AND_TIME);
      expect(await dates.count()).toBe(4);
      const measures = await Promise.all(
        (await dates.all()).map((date) => date.evaluate(lineCount))
      );
      for (const measured of measures) {
        expect(measured.height).toBeGreaterThan(0);
        expect(measured.lines).toBeLessThan(1.05);
      }
    });
  });
}

test.describe("em 360 px", () => {
  test.use({ viewport: { height: 740, width: 360 } });

  test("sem cliente, a linha diz 'Sem cliente' sem o prefixo 'Cliente:'", async ({
    page,
  }) => {
    await historyStates.list(page);
    await expect(
      page.getByText("Sem cliente · Dinheiro · 1 item")
    ).toBeVisible();
    await expect(page.getByText("Cliente: ")).toHaveCount(0);
    await expect(
      page.getByText("Da mais recente para a mais antiga")
    ).toHaveCount(0);
  });

  test("sem conexão, a linha é só texto: sem link e sem chevron", async ({
    page,
  }) => {
    await historyStates.offline(page);
    const rows = page
      .getByRole("list", { name: "Vendas" })
      .getByRole("listitem");
    await expect(rows.first()).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Vendas" }).getByRole("link")
    ).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Vendas" }).locator("svg")
    ).toHaveCount(0);
  });
});
