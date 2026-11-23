/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  DETAIL_SALE_ID,
  saleDetailAnswers,
} from "../e2e-pwa/sale-detail-fixture";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The payment block of the receipt of the sale detail, read at 320 px with the browser font at 16 px and at 20 px (`./reflow`), with
 * the two unknowns the receipt can carry (the fee and the settlement): no word of the notice is split in the middle, the
 * value goes whole to the line below its label when both do not fit, and the page does not scroll sideways.
 */
skipOutsideChromium();

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const NOW = new Date("2026-10-14T12:00:00-03:00");
const FEE_NOTICE = "desconhecida — não é zero";
const SETTLEMENT_NOTICE = "prazo desconhecido — não é zero";
const UNKNOWN_NOTICES = [FEE_NOTICE, SETTLEMENT_NOTICE];

const FONTS = [16, 20] as const;

const answer = (body: string) => ({
  body,
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});
const rpc = (json: unknown) => answer(JSON.stringify({ json, meta: [] }));

async function openPaymentBlock(page: Page, fontPixels: number) {
  const answers = saleDetailAnswers({ withReturn: true });
  await openReflowViewport(page, { fontPixels });
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(
      answer(JSON.stringify({ session: { id: "s" }, user: { id: "u" } }))
    )
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    const found = (answers as Record<string, unknown>)[procedure];
    return found === undefined
      ? route.abort("internetdisconnected")
      : route.fulfill(rpc(found));
  });
  await page.clock.setFixedTime(NOW);
  await page.goto(`/sales/detail?saleId=${DETAIL_SALE_ID}`);
  const block = page.locator('[data-receipt-block="payment"]');
  await expect(block).toBeVisible();
  await expectReflowFont(page, fontPixels);
  return block;
}

/** Every word of each notice with the number of lines its box is painted on: more than one is a word cut in the middle. */
function wordLines(page: Page, notices: readonly string[]) {
  return page.evaluate((texts) => {
    const WORDS = /\S+/g;
    const found: Array<{ lines: number; notice: string; word: string }> = [];
    const walker = document.createTreeWalker(
      document.querySelector('[data-receipt-block="payment"]') as Element,
      NodeFilter.SHOW_TEXT
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const content = node.textContent ?? "";
      const notice = texts.find((text) => content.includes(text));
      if (notice === undefined) {
        continue;
      }
      for (const match of content.matchAll(WORDS)) {
        const start = match.index ?? 0;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + match[0].length);
        found.push({
          lines: range.getClientRects().length,
          notice,
          word: match[0],
        });
      }
    }
    return found;
  }, notices);
}

for (const fontPixels of FONTS) {
  reflowTest(
    `a 320 px com letra de ${fontPixels} px nenhuma palavra do aviso de taxa e de prazo do pagamento quebra no meio`,
    async ({ page }) => {
      const block = await openPaymentBlock(page, fontPixels);
      await expect(block.getByText(FEE_NOTICE)).toBeVisible();
      await expect(block.getByText(SETTLEMENT_NOTICE)).toBeVisible();
      const words = await wordLines(page, UNKNOWN_NOTICES);
      const expected = UNKNOWN_NOTICES.reduce(
        (sum, notice) => sum + notice.split(" ").length,
        0
      );
      expect(words.length, "words measured in the two notices").toBe(expected);
      expect(
        words.filter(({ lines }) => lines !== 1),
        "words painted on more than one line"
      ).toEqual([]);
      await assertNothingClipped(block);
      await assertNoPageScroll(page);
    }
  );

  reflowTest(
    `a 320 px com letra de ${fontPixels} px o aviso da taxa desce inteiro para baixo do nome, na borda direita da linha`,
    async ({ page }) => {
      const block = await openPaymentBlock(page, fontPixels);
      const row = block
        .locator(":scope > div")
        .filter({ hasText: "Taxa de processamento" });
      await expect(row).toHaveCount(1);
      const box = await row.evaluate((line) => {
        const term = (
          line.querySelector("dt") as Element
        ).getBoundingClientRect();
        const value = (
          line.querySelector("dd") as Element
        ).getBoundingClientRect();
        return {
          rowRight: line.getBoundingClientRect().right,
          termBottom: term.bottom,
          valueRight: value.right,
          valueTop: value.top,
        };
      });
      expect(
        box.valueTop,
        "o aviso começa abaixo do nome da taxa, não ao lado"
      ).toBeGreaterThanOrEqual(box.termBottom);
      expect(
        Math.abs(box.rowRight - box.valueRight),
        "o aviso termina na borda direita da linha"
      ).toBeLessThanOrEqual(1);
    }
  );
}
