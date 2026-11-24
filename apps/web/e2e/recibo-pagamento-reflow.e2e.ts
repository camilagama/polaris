/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { axeFaults } from "../e2e-pwa/ui-guardrails/measures";
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
const UNKNOWN_ROW_LABELS = ["Taxa de processamento", "Prazo"] as const;

const FONTS = [16, 20] as const;
const PARTS_NAME = "Pagamento em 2 partes";
const MONEY = /R\$ ([\d.]+),(\d{2})/;
const centsOf = (text: string) => {
  const found = MONEY.exec(text);
  return found
    ? Number((found[1] ?? "").replaceAll(".", "") + found[2])
    : Number.NaN;
};

const answer = (body: string) => ({
  body,
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});
const rpc = (json: unknown) => answer(JSON.stringify({ json, meta: [] }));

async function openPaymentBlock(
  page: Page,
  fontPixels: number,
  withParts = false
) {
  const answers = saleDetailAnswers({
    withParts,
    withReturn: !withParts,
  });
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
  const block = withParts
    ? page.getByRole("list", { name: PARTS_NAME })
    : page.locator('[data-receipt-block="payment"]');
  await expect(block).toBeVisible();
  await expectReflowFont(page, fontPixels);
  return block;
}

/** Where the label and the value of one line of the payment block sit, so the value can be checked against both. */
async function rowBox(block: Locator, label: string) {
  const row = block.locator(":scope > div").filter({
    has: block.page().locator("dt", { hasText: new RegExp(`^${label}$`) }),
  });
  await expect(row).toHaveCount(1);
  return row.evaluate((line) => {
    const term = (line.querySelector("dt") as Element).getBoundingClientRect();
    const value = (line.querySelector("dd") as Element).getBoundingClientRect();
    return {
      rowRight: line.getBoundingClientRect().right,
      termBottom: term.bottom,
      valueRight: value.right,
      valueTop: value.top,
    };
  });
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
    `a 320 px com letra de ${fontPixels} px o aviso da taxa e o do prazo descem inteiros para baixo do nome, na borda direita da linha`,
    async ({ page }) => {
      const block = await openPaymentBlock(page, fontPixels);
      const boxes = await Promise.all(
        UNKNOWN_ROW_LABELS.map((label) => rowBox(block, label))
      );
      boxes.forEach((box, index) => {
        const label = UNKNOWN_ROW_LABELS[index];
        expect(
          box.valueTop,
          `o aviso de "${label}" começa abaixo do nome, não ao lado`
        ).toBeGreaterThanOrEqual(box.termBottom);
        expect(
          Math.abs(box.rowRight - box.valueRight),
          `o aviso de "${label}" termina na borda direita da linha`
        ).toBeLessThanOrEqual(1);
      });
    }
  );
}

for (const fontPixels of FONTS) {
  reflowTest(
    `a 320 px com letra de ${fontPixels} px o pagamento em 2 partes lista método e valor de cada parte, soma o total e não corta nem rola`,
    async ({ page }) => {
      const block = await openPaymentBlock(page, fontPixels, true);
      const parts = block.getByRole("listitem");
      await expect(parts).toHaveCount(2);
      await expect(parts.nth(0)).toContainText("Parte 1: Pix");
      await expect(parts.nth(0)).toContainText("R$ 109,60");
      await expect(parts.nth(1)).toContainText("Parte 2: Cartão de crédito");
      await expect(parts.nth(1)).toContainText("R$ 300,00");
      await expect(parts.nth(1)).toContainText("3x · Parcelado pelo lojista");
      await expect(page.getByText("Valor do pagamento")).toHaveCount(0);
      const amounts = await parts.evaluateAll((items) =>
        items.map(
          (item) => item.querySelector("p")?.lastElementChild?.textContent ?? ""
        )
      );
      const total = await page
        .locator("[data-receipt-totals] dd")
        .first()
        .textContent();
      expect(amounts.map(centsOf).reduce((sum, cents) => sum + cents, 0)).toBe(
        centsOf(total ?? "")
      );
      expect(await axeFaults(page, `[aria-label="${PARTS_NAME}"]`)).toEqual([]);
      await assertNothingClipped(block);
      await assertNoPageScroll(page);
    }
  );
}
