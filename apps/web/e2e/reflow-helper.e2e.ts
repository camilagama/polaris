/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  skipOutsideChromium,
} from "./reflow";

/**
 * The sweep has to catch what it says it catches: each defect below is planted on purpose and the helper must fail on
 * it, and the same markup without the defect must pass (a helper that fails on everything catches nothing).
 */
skipOutsideChromium();

async function show(page: Page, body: string) {
  await openReflowViewport(page);
  await page.setContent(
    `<!doctype html><html><body style="margin:0">${body}</body></html>`
  );
  await expectReflowFont(page);
}

const CUT_TEXT = "Cartão de crédito";
const LONG = "Cartão de crédito parcelado em doze vezes sem juros";

test("o corte de um elemento com texto reprova, e o mesmo texto que cabe passa", async ({
  page,
}) => {
  await show(
    page,
    `<div id="root"><span id="cut" style="display:block;width:60px;overflow:hidden;white-space:nowrap">${LONG}</span></div>`
  );
  await expect(assertNothingClipped(page.locator("#root"))).rejects.toThrow(
    CUT_TEXT
  );
  await page.locator("#cut").evaluate((element) => {
    element.style.whiteSpace = "normal";
    element.style.overflowWrap = "anywhere";
  });
  await assertNothingClipped(page.locator("#root"));
});

test("o corte dentro de um elemento que rola de propósito ainda reprova, e o próprio elemento que rola não", async ({
  page,
}) => {
  const strip = (inside: string) =>
    `<div id="root"><div role="tablist" style="width:200px;overflow-x:auto;white-space:nowrap">${LONG}${inside}</div></div>`;
  await show(page, strip('<span style="display:inline-block">ok</span>'));
  await expect(assertNothingClipped(page.locator("#root"))).rejects.toThrow(
    CUT_TEXT
  );
  await assertNothingClipped(page.locator("#root"), {
    allowScroll: ['[role="tablist"]'],
  });
  await page.locator("#root span").evaluate((element) => {
    element.style.width = "40px";
    element.style.overflow = "hidden";
    element.textContent = "Cartão de crédito";
  });
  await expect(
    assertNothingClipped(page.locator("#root"), {
      allowScroll: ['[role="tablist"]'],
    })
  ).rejects.toThrow(CUT_TEXT);
});

test("reticências que escondem texto reprovam, e as que não têm o que esconder passam", async ({
  page,
}) => {
  await show(
    page,
    `<div id="data" style="width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${LONG}</div>`
  );
  await expect(assertNoEllipsis(page.locator("#data"))).rejects.toThrow(
    CUT_TEXT
  );
  await page.locator("#data").evaluate((element) => {
    element.textContent = "Pix";
  });
  await assertNoEllipsis(page.locator("#data"));
});

test("o corte de linhas com line-clamp reprova", async ({ page }) => {
  await show(
    page,
    `<p id="data" style="width:90px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:0">${LONG}</p>`
  );
  await expect(assertNoEllipsis(page.locator("#data"))).rejects.toThrow(
    CUT_TEXT
  );
});

test("o localizador sem nenhum elemento reprova em vez de passar vazio", async ({
  page,
}) => {
  await show(page, "<p>texto</p>");
  await expect(assertNoEllipsis(page.locator("#nao-existe"))).rejects.toThrow(
    "found no element"
  );
  await expect(
    assertNothingClipped(page.locator("#nao-existe"), { allowScroll: [] })
  ).rejects.toThrow();
});

test("1 px de rolagem lateral da página reprova, e a largura exata da janela passa", async ({
  page,
}) => {
  await show(page, '<div id="wide" style="width:321px;height:10px"></div>');
  await expect(assertNoPageScroll(page)).rejects.toThrow(
    "321 px wide in a window of 320 px"
  );
  await page.locator("#wide").evaluate((element) => {
    element.style.width = "320px";
  });
  await assertNoPageScroll(page);
});

test("a janela é de 320 px e a letra do navegador é de 20 px, e não a de 16", async ({
  page,
}) => {
  await show(page, "<p>texto</p>");
  expect(await page.evaluate(() => window.innerWidth)).toBe(320);
  await expect(expectReflowFont(page, 16)).rejects.toThrow();
});
