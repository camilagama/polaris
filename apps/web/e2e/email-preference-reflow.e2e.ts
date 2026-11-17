/// <reference lib="dom" />
import { expect } from "@playwright/test";
import { openPreferenceScreen } from "./email-preference-stub";
import {
  assertNoPageScroll,
  assertNothingClipped,
  expectReflowFont,
  openReflowViewport,
  reflowTest,
  skipOutsideChromium,
} from "./reflow";

/**
 * The card "E-mails que você recebe" read at 320 px with the browser font at 20 px and at 360 px with 16 px, light and
 * dark, with the line of what was sent drawn (the tallest state): the label breaks in two lines before it pushes the
 * switch, the switch stays inside the card with a touch area of 44 px, and nothing is cut or scrolls sideways.
 */
skipOutsideChromium();

const TOUCH = 44;
const SIZES = [
  { fontPixels: 20, width: 320 },
  { fontPixels: 16, width: 360 },
] as const;
const SCHEMES = ["light", "dark"] as const;

for (const { fontPixels, width } of SIZES) {
  for (const scheme of SCHEMES) {
    reflowTest(
      `o cartão de e-mails a ${width} px com fonte de ${fontPixels} px, tema ${scheme === "light" ? "claro" : "escuro"}: inteiro, o interruptor dentro e com toque de 44 px`,
      async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openReflowViewport(page, { fontPixels, width });
        await openPreferenceScreen(page, { state: { sent: 2, tips: true } });
        await expectReflowFont(page, fontPixels);

        const card = page.getByRole("region", {
          exact: true,
          name: "E-mails que você recebe",
        });
        const toggle = card.getByRole("switch", { name: "Dicas para começar" });
        await expect(toggle).toBeVisible();
        await expect(card).toContainText("Enviados até agora: 2 de 3.");

        await assertNothingClipped(card);
        await assertNoPageScroll(page);

        const cardBox = await card.boundingBox();
        const toggleBox = await toggle.boundingBox();
        expect(
          (toggleBox?.x ?? 0) + (toggleBox?.width ?? 0)
        ).toBeLessThanOrEqual((cardBox?.x ?? 0) + (cardBox?.width ?? 0) + 1);

        const area = await toggle.evaluate((element) => {
          const hit = getComputedStyle(element, "::after");
          return {
            height:
              element.getBoundingClientRect().height +
              2 * Math.abs(Number.parseFloat(hit.top)),
            width:
              element.getBoundingClientRect().width +
              2 * Math.abs(Number.parseFloat(hit.left)),
          };
        });
        expect(area.height).toBeGreaterThanOrEqual(TOUCH);
        expect(area.width).toBeGreaterThanOrEqual(TOUCH);

        const label = card.getByText("Dicas para começar", { exact: true });
        const labelBox = await label.boundingBox();
        expect(labelBox?.width ?? 0).toBeLessThan(
          (toggleBox?.x ?? 0) - (cardBox?.x ?? 0)
        );
      }
    );
  }
}
