/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  type ItemGeometry,
  layoutOf,
  measureItem,
  measureStates,
  setBrowserFont,
} from "./sale-item-geometry";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The fields of an item of the sale (Quantidade, Preço cobrado, Preço de tabela) choose their disposition by the width
 * of the item, not by the window: three columns from 27 rem, the phone's two-and-one from 16.25 rem, and one column
 * below that. The cuts were measured on the item at the widths the labels and the longest common value, `99.999,99`,
 * stop fitting; the rem is the real font size of the page (`Page.setFontSizes`), as in `breakpoints-rem.e2e.ts`.
 */

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "`Page.setFontSizes` is a Chrome DevTools command"
);

const STACKED_FROM_REM = 16.25;
const THREE_COLUMNS_FROM_REM = 27;
const NARROWEST_REM = 9.5;
const LONGEST_VALUE = "99.999,99";
const SHIRT_OPTION = /Camiseta do laboratório · Azul/;
const ORGANIZATION = "0199c2d0-0000-7000-8000-00000000a001";
const SHIRT = "0199c2d0-0000-7000-8000-0000000000b1";
const WIDTHS = [320, 360, 390, 640, 768, 900, 1024, 1280];

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

async function openItem(page: Page, pixels: number): Promise<Locator> {
  await page.setViewportSize({ height: 800, width: 1280 });
  await setBrowserFont(page, pixels);
  await page.addInitScript(
    ([key, variant]) => {
      window.localStorage.setItem(
        key as string,
        JSON.stringify({
          [variant as string]: {
            charged: "45.00",
            listed: "50.00",
            on: "2026-10-01",
          },
        })
      );
    },
    [`polaris.sale.lastPrices.v1:${ORGANIZATION}`, SHIRT]
  );
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill(rpc({ profiles: [] }))
  );
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=sale");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize
    )
  ).toBe(`${pixels}px`);
  await page.getByLabel("Rede disponível").uncheck();
  const item = page.getByRole("group", { exact: true, name: "Item 1" });
  await item.getByLabel("Produto ou variante").fill("camiseta azul");
  await page.getByRole("option", { name: SHIRT_OPTION }).click();
  return item;
}

async function fillValues(item: Locator) {
  await item.getByLabel("Preço cobrado").fill(LONGEST_VALUE);
  await item.getByLabel("Preço de tabela").fill(LONGEST_VALUE);
}

function setItemWidth(item: Locator, pixels: number) {
  return item.evaluate((node, width) => {
    node.style.width = `${width}px`;
    node.style.justifySelf = "start";
  }, pixels);
}

const remOf = (geometry: ItemGeometry) => geometry.width / geometry.rem;

function expectedLayout(rem: number) {
  if (rem >= THREE_COLUMNS_FROM_REM) {
    return "tres";
  }
  return rem >= STACKED_FROM_REM ? "celular" : "empilhada";
}

/**
 * Below 18.25 rem, in the disposition with Quantidade and Preço cobrado side by side, the price field is narrower
 * than the longest common value. The cut stays at 16.25 rem because 320 px with the default font (16.5 rem) must keep
 * that disposition, so "Preço cobrado" is the only field whose value may scroll, and only in that range.
 */
const VALUE_SCROLLS_BELOW_REM = 18.25;

function problems(geometry: ItemGeometry) {
  const rem = remOf(geometry);
  const valueMayScroll =
    expectedLayout(rem) === "celular" && rem < VALUE_SCROLLS_BELOW_REM;
  return [
    ...geometry.clipped.filter(
      (text) => !(valueMayScroll && text === "Preço cobrado: valor com rolagem")
    ),
    ...geometry.overlaps,
  ];
}

for (const pixels of [16, 20]) {
  test.describe(`letra de ${pixels} px`, () => {
    test(`a grade do item segue a largura do item: de ${NARROWEST_REM} a 40 rem, nada cortado nem sobreposto, e os cortes em ${STACKED_FROM_REM} e ${THREE_COLUMNS_FROM_REM} rem`, async ({
      page,
    }) => {
      const item = await openItem(page, pixels);
      await fillValues(item);
      const seen = new Set<string>();
      for (let rem = NARROWEST_REM; rem <= 40; rem += 0.25) {
        // biome-ignore lint/performance/noAwaitInLoops: the widths are applied to the same page, one after the other
        await setItemWidth(item, rem * pixels);
        const geometry = await measureItem(item);
        expect(remOf(geometry)).toBeCloseTo(rem, 1);
        expect(problems(geometry), `${rem} rem`).toEqual([]);
        expect(layoutOf(geometry), `${rem} rem`).toBe(expectedLayout(rem));
        seen.add(layoutOf(geometry));
      }
      expect([...seen].sort()).toEqual(["celular", "empilhada", "tres"]);
    });

    test("nas larguras de janela de 320 a 1280 px nada fica cortado nem sobreposto, e 320, 360 e 390 px com letra de 16 px seguem na disposição do celular", async ({
      page,
    }) => {
      const item = await openItem(page, pixels);
      await fillValues(item);
      for (const width of WIDTHS) {
        // biome-ignore lint/performance/noAwaitInLoops: the widths are applied to the same page, one after the other
        await page.setViewportSize({ height: 800, width });
        await expect(item).toBeVisible();
        const geometry = await measureItem(item);
        expect(problems(geometry), `${width} px`).toEqual([]);
        expect(layoutOf(geometry), `${width} px`).toBe(
          expectedLayout(remOf(geometry))
        );
        if (pixels === 16 && width <= 390) {
          const { Quantidade, "Preço cobrado": charged } = geometry.boxes;
          const listed = geometry.boxes["Preço de tabela"];
          expect(layoutOf(geometry), `${width} px`).toBe("celular");
          expect(charged.left).toBeGreaterThan(Quantidade.right);
          expect(listed.top).toBeGreaterThan(Quantidade.bottom);
          expect(listed.left).toBeCloseTo(Quantidade.left, 0);
          expect(listed.right).toBeCloseTo(charged.right, 0);
        }
      }
    });

    test("com aviso de estoque, dica de preço e linha de negociação, e depois com erro sob cada campo, nada sobrepõe nem corta, no menor e no maior item", async ({
      page,
    }) => {
      const item = await openItem(page, pixels);
      const sweep = async (minimum: number) => {
        for (const rem of [12, 16.5, 24, 40]) {
          // biome-ignore lint/performance/noAwaitInLoops: the widths are applied to the same page, one after the other
          await setItemWidth(item, rem * pixels);
          const geometry = await measureItem(item);
          expect(problems(geometry), `${rem} rem`).toEqual([]);
          const states = await measureStates(item);
          expect(states.checked, `${rem} rem`).toBeGreaterThanOrEqual(minimum);
          expect(states.problems, `${rem} rem`).toEqual([]);
          expect(layoutOf(geometry)).toBe(expectedLayout(rem));
        }
      };
      await expect(
        item.getByText("Preços sugeridos pela última venda")
      ).toBeVisible();
      await expect(item.getByText("Negociação:")).toBeVisible();
      await item.getByLabel("Quantidade").fill("9");
      await expect(item.getByText("Acima do saldo (5)")).toBeVisible();
      await sweep(3);
      await item.getByLabel("Quantidade").fill("abc");
      await item.getByLabel("Preço cobrado").fill("abc");
      await item.getByLabel("Preço de tabela").fill("abc");
      await expect(item.locator("[id$=-error]:not(:empty)")).toHaveCount(3);
      await sweep(4);
    });
  });
}

test("a ordem do DOM segue Quantidade, Preço cobrado, Preço de tabela em qualquer disposição", async ({
  page,
}) => {
  const item = await openItem(page, 16);
  for (const rem of [12, 20, 40]) {
    // biome-ignore lint/performance/noAwaitInLoops: the widths are applied to the same page, one after the other
    await setItemWidth(item, rem * 16);
    const order = await item.evaluate((node) =>
      [...node.querySelectorAll("label")].map((label) =>
        label.textContent?.trim()
      )
    );
    expect(order).toEqual(["Quantidade", "Preço cobrado", "Preço de tabela"]);
  }
});
