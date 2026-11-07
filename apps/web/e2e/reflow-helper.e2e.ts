/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  findClipped,
  openReflowViewport,
  type ReflowPointer,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import type { KnownCoarseFinding } from "./reflow-known";

/**
 * The sweep has to catch what it says it catches: each defect below is planted on purpose and the helper must fail on
 * it, and the same markup without the defect must pass (a helper that fails on everything catches nothing).
 */
skipOutsideChromium();

async function show(page: Page, body: string, pointer?: ReflowPointer) {
  await openReflowViewport(page, pointer === undefined ? {} : { pointer });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">${body}</body></html>`
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

test("o corte de um texto em linha dentro de uma caixa que esconde o excesso reprova", async ({
  page,
}) => {
  await show(
    page,
    `<div id="root"><div style="width:60px;overflow:hidden"><span style="white-space:nowrap">${LONG}</span></div></div>`
  );
  await expect(assertNothingClipped(page.locator("#root"))).rejects.toThrow(
    CUT_TEXT
  );
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

const FIELD_ONLY_CUT_WITH_TOUCH = `<style>@media (pointer: coarse) { #field { width: 60px; overflow: hidden; white-space: nowrap; } }</style><div id="root"><span id="field" style="display:block">${LONG}</span></div>`;
const FIELD_ALWAYS_CUT =
  '<div id="root"><span id="field" style="display:block;width:60px;overflow:hidden;white-space:nowrap">Cartão de crédito parcelado em doze vezes sem juros</span></div>';

// the Pixel 5 project is a finger already: the cases that tell the two pointers apart run only where the mouse is real
test.describe("ponteiros", () => {
  test.beforeEach(({ browserName: _ }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "the Pixel 5 project is a coarse pointer in every case"
    );
  });

  reflowTest(
    "um campo que só corta com toque passa com o mouse e reprova com o dedo",
    async ({ page, pointer }) => {
      await show(page, FIELD_ONLY_CUT_WITH_TOUCH, pointer);
      const root = page.locator("#root");
      if (pointer === "fine") {
        await assertNothingClipped(root);
        return;
      }
      await expect(assertNothingClipped(root)).rejects.toThrow(CUT_TEXT);
      await page.locator("#field").evaluate((element) => {
        element.style.whiteSpace = "normal";
        element.style.overflowWrap = "anywhere";
      });
      await assertNothingClipped(root);
    }
  );

  reflowTest(
    "a lista de conhecidos só desculpa o corte com toque, o nome e a medida que ela diz",
    async ({ page, pointer }) => {
      await show(page, FIELD_ALWAYS_CUT, pointer);
      const root = page.locator("#root");
      const { offenders } = await findClipped(root);
      expect(offenders).toHaveLength(1);
      const [cut] = offenders;
      const line: KnownCoarseFinding = {
        cases: [
          "a lista de conhecidos só desculpa o corte com toque, o nome e a medida que ela diz",
        ],
        clientWidth: cut?.clientWidth ?? 0,
        reason: "campo de teste que corta de propósito",
        screen: "página de teste do auxiliar",
        scrollWidth: cut?.scrollWidth ?? 0,
        selector: cut?.selector ?? "",
        spec: "reflow-helper.e2e.ts",
      };
      if (pointer === "fine") {
        await expect(
          assertNothingClipped(root, { known: [line] })
        ).rejects.toThrow(CUT_TEXT);
        return;
      }
      await assertNothingClipped(root, { known: [line] });
      const others = [
        { ...line, scrollWidth: line.scrollWidth + 1 },
        { ...line, clientWidth: line.clientWidth + 1 },
        { ...line, selector: "span#outro" },
        { ...line, spec: "outro.e2e.ts" },
        { ...line, cases: ["outro caso do mesmo spec"] },
      ];
      await Promise.all(
        others.map((other) =>
          expect(
            assertNothingClipped(root, { known: [other] })
          ).rejects.toThrow(CUT_TEXT)
        )
      );
      await expect(assertNothingClipped(root, { known: [] })).rejects.toThrow(
        CUT_TEXT
      );
    }
  );

  reflowTest(
    "a rolagem lateral da página com toque também só passa se estiver na lista",
    async ({ page, pointer }) => {
      await show(
        page,
        '<div id="wide" style="width:400px;height:10px"></div>',
        pointer
      );
      await expect(assertNoPageScroll(page)).rejects.toThrow(
        "px wide in a window"
      );
      const scroll = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      const line: KnownCoarseFinding = {
        cases: [
          "a rolagem lateral da página com toque também só passa se estiver na lista",
        ],
        clientWidth: scroll.client,
        reason: "página de teste que rola de propósito",
        screen: "página de teste do auxiliar",
        scrollWidth: scroll.scroll,
        selector: "html",
        spec: "reflow-helper.e2e.ts",
      };
      if (pointer === "fine") {
        await expect(
          assertNoPageScroll(page, { known: [line] })
        ).rejects.toThrow("px wide in a window");
        return;
      }
      await assertNoPageScroll(page, { known: [line] });
    }
  );

  test("o ponteiro pedido que o navegador não tem reprova, e o que ele tem passa", async ({
    page,
  }) => {
    await expect(
      openReflowViewport(page, { pointer: "coarse" })
    ).rejects.toThrow("reports the other");
    await openReflowViewport(page, { pointer: "fine" });
  });
});

test.describe("com toque", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("o ponteiro pedido confere com o do navegador: com toque o grosso passa e o fino reprova", async ({
    page,
  }) => {
    await openReflowViewport(page, { pointer: "coarse" });
    await expect(openReflowViewport(page, { pointer: "fine" })).rejects.toThrow(
      "reports the other"
    );
  });
});
