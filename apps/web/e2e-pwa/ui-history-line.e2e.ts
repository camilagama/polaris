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
const ROW_NAMES = [
  /^14\/10\/2026 · \d\d:\d\d Confirmada Ângela Souza · Pix · 2 itens/,
  /^14\/10\/2026 · \d\d:\d\d Cancelada Sem cliente · Dinheiro · 1 item/,
  /^14\/10\/2026 · \d\d:\d\d Confirmada Com devoluções Maria Aparecida/,
  /^10\/10\/2026 · \d\d:\d\d Confirmada Retroativa Sem cliente/,
];
const DASH_ALONE = /(?:^|\s)[–—-](?:\s|$)/u;

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

for (const [width, height] of [
  [360, 740],
  [1280, 800],
] as const) {
  test.describe(`avatar vazio em ${width} px`, () => {
    test.use({ viewport: { height, width } });

    test("sem cliente não há círculo com traço, o nome é 'Sem cliente' e o texto começa no mesmo x das linhas com avatar", async ({
      page,
    }) => {
      await historyStates.list(page);
      const links = page
        .getByRole("list", { name: "Vendas" })
        .getByRole("link");
      const withCustomer = links.filter({ hasText: "Ângela Souza" });
      const without = links.filter({ hasText: "Sem cliente" });
      await expect(withCustomer).toHaveCount(1);
      expect(await without.count()).toBeGreaterThan(1);
      const startOf = async (row: typeof withCustomer) => {
        const box = await row.getByText(DATE_AND_TIME).boundingBox();
        expect(box).not.toBeNull();
        return box?.x ?? Number.NaN;
      };
      const reference = await startOf(withCustomer);
      const rows = await without.all();
      const starts = await Promise.all(rows.map(startOf));
      for (const start of starts) {
        expect(Math.abs(start - reference)).toBeLessThanOrEqual(1);
      }
      const circles = await Promise.all(
        rows.map(async (row) => {
          const circle = row.locator("span[aria-hidden='true']").first();
          return {
            filled: await circle.evaluate(
              (el) =>
                getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)"
            ),
            text: (await circle.innerText()).trim(),
            width: (await circle.boundingBox())?.width ?? 0,
            whole: await row.innerText(),
          };
        })
      );
      for (const circle of circles) {
        expect(circle.width).toBeGreaterThan(0);
        expect(circle.text).toBe("");
        expect(circle.filled).toBe(false);
        expect(circle.whole).not.toMatch(DASH_ALONE);
      }
    });
  });
}

/**
 * The state "Confirmada" is the ordinary one: nearly every row has it, so as a badge on all of them it hides the few
 * rows that are not. In the list it is only text for the screen reader, in the name of the row, where the badge was;
 * the other states stay as badges. The value and the chevron end at the same x in a row with a badge and in one
 * without. Where the badge wraps under the date (a phone) the row without it is shorter; it is never taller, and on
 * a wide screen both are as tall.
 */
for (const [width, height] of [
  [360, 740],
  [1280, 800],
] as const) {
  test.describe(`selo de estado em ${width} px`, () => {
    test.use({ viewport: { height, width } });

    test("só a venda fora do comum tem selo visível, e o nome de cada linha traz o estado, Confirmada incluso", async ({
      page,
    }) => {
      await historyStates.list(page);
      const list = page.getByRole("list", { name: "Vendas" });
      await expect(list.getByRole("link")).toHaveCount(4);
      await expect(list.locator("[data-slot='badge']")).toHaveText([
        "Cancelada",
        "Com devoluções",
        "Retroativa",
      ]);
      await Promise.all(
        ROW_NAMES.map((name) =>
          expect(list.getByRole("link", { name })).toHaveCount(1)
        )
      );
    });

    test("o valor e o chevron ficam no mesmo x com e sem selo, e a linha sem selo nunca é mais alta", async ({
      page,
    }) => {
      await historyStates.list(page);
      const links = page
        .getByRole("list", { name: "Vendas" })
        .getByRole("link");
      const withoutBadge = links.filter({ hasText: "Ângela Souza" });
      const withBadge = links.filter({ hasText: "Cancelada" });
      await expect(withoutBadge.locator("[data-slot='badge']")).toHaveCount(0);
      await expect(withBadge.locator("[data-slot='badge']")).toHaveCount(1);
      const measure = async (row: typeof withBadge, total: string) => {
        const [value, chevron, box] = await Promise.all([
          row.getByText(total).boundingBox(),
          row.locator("svg[aria-hidden='true']").last().boundingBox(),
          row.boundingBox(),
        ]);
        expect(value).not.toBeNull();
        expect(chevron).not.toBeNull();
        expect(box).not.toBeNull();
        return {
          chevronRight: (chevron?.x ?? 0) + (chevron?.width ?? 0),
          height: box?.height ?? 0,
          valueRight: (value?.x ?? 0) + (value?.width ?? 0),
        };
      };
      const plain = await measure(withoutBadge, "219,90");
      const badged = await measure(withBadge, "20,00");
      expect(Math.abs(plain.chevronRight - badged.chevronRight)).toBeLessThan(
        0.5
      );
      expect(plain.chevronRight - plain.valueRight).toBeGreaterThan(0);
      expect(plain.height).toBeLessThanOrEqual(badged.height + 0.5);
      if (width >= 760) {
        expect(Math.abs(plain.height - badged.height)).toBeLessThan(0.5);
      }
    });
  });
}
