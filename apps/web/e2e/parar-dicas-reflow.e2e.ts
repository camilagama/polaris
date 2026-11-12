/// <reference lib="dom" />

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { securityHeaders } from "@polaris/http-security";
import {
  renderTipsStopPage,
  TIPS_STOP_TEXTS,
  type TipsStopPageState,
  tipsStopStyleHash,
} from "../src/server/tips-stop/tips-stop-page";
import {
  assertNoEllipsis,
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";

/**
 * The page that stops the tips e-mails, as the Worker answers it (its HTML and the headers of its profile, served
 * here by an intercepted route, so the policy of the page is the one the browser enforces): read at 320 px with the
 * browser font at 20 px and at 360 px with 16 px, light and dark, every state whole, inside the card, with no
 * horizontal scroll, the style allowed by its hash and the one button 44 px high. The form posts back to the URL with
 * the token, and the browser sends what the mail reader sends.
 */
skipOutsideChromium();

const ORIGIN = "https://polaris.test";
const PAGE_URL = `${ORIGIN}/api/parar-dicas?t=token-de-teste`;
const TOUCH = 44;
const STATES: TipsStopPageState[] = [
  "confirm",
  "done",
  "invalid",
  "rate_limited",
  "unavailable",
];
const SIZES = [
  { fontPixels: 20, width: 320 },
  { fontPixels: 16, width: 360 },
] as const;
const SCHEMES = ["light", "dark"] as const;

async function serve(page: Page, state: TipsStopPageState) {
  const headers = securityHeaders("form-document", {
    styleHashes: [await tipsStopStyleHash()],
  });
  const posted: { body: string | null; url: string }[] = [];
  await page.route(`${ORIGIN}/**`, (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      posted.push({ body: request.postData(), url: request.url() });
    }
    return route.fulfill({
      body: renderTipsStopPage(request.method() === "POST" ? "done" : state),
      contentType: "text/html; charset=utf-8",
      headers: { ...headers, "Cache-Control": "no-store" },
      status: 200,
    });
  });
  const refused: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) {
      refused.push(message.text());
    }
  });
  return { posted, refused };
}

for (const state of STATES) {
  for (const { fontPixels, width } of SIZES) {
    for (const scheme of SCHEMES) {
      reflowTest(
        `${state} a ${width} px com fonte de ${fontPixels} px, tema ${scheme === "light" ? "claro" : "escuro"}: inteira, sem rolar de lado`,
        async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await openReflowViewport(page, { fontPixels, width });
          const { refused } = await serve(page, state);
          await page.goto(PAGE_URL);
          await expectReflowFont(page, fontPixels);

          const card = page.locator(".card");
          await expect(card).toBeVisible();
          // the style block applied under the policy: the card has its own background and the page its padding
          expect(
            await card.evaluate((element) => getComputedStyle(element).display)
          ).toBe("flex");
          expect(refused).toEqual([]);

          await assertNothingClipped(page.locator("main"));
          await assertNoEllipsis(page.locator("main h1"));
          await assertNoPageScroll(page);

          const actions = page.locator(".action");
          expect(await actions.count()).toBeLessThanOrEqual(1);
          if ((await actions.count()) === 1) {
            const box = await actions.boundingBox();
            expect(box?.height ?? 0).toBeGreaterThanOrEqual(TOUCH);
            const cardBox = await card.boundingBox();
            expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
              (cardBox?.x ?? 0) + (cardBox?.width ?? 0) + 1
            );
          }
        }
      );
    }
  }
}

reflowTest(
  "o botão posta para o próprio endereço, com o corpo do clique do leitor de e-mail, e mostra o pronto",
  async ({ page }) => {
    await openReflowViewport(page, { fontPixels: 16, width: 360 });
    const { posted, refused } = await serve(page, "confirm");
    await page.goto(PAGE_URL);

    await page
      .getByRole("button", { name: TIPS_STOP_TEXTS.confirmButton })
      .click();

    await expect(
      page.getByRole("heading", { name: TIPS_STOP_TEXTS.doneTitle })
    ).toBeVisible();
    expect(posted).toEqual([
      { body: "List-Unsubscribe=One-Click", url: PAGE_URL },
    ]);
    expect(refused).toEqual([]);
  }
);
