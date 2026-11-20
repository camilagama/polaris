/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { test } from "@playwright/test";
import {
  COLOR_SCHEME,
  type UiContext,
  type UiScreen,
  VIEWPORTS,
} from "../ui-screens";
import { startMotionRecorder } from "./measures";

const touchName = (touch: boolean) => (touch ? "com toque" : "com mouse");
export const contextName = ({ theme, touch, viewport }: UiContext) =>
  `${viewport} px · ${touchName(touch)} · tema ${theme}`;

/** The browser options of a context: a phone is mobile, the wide screen with touch is a tablet. */
export const contextOptions = ({ theme, touch, viewport }: UiContext) => ({
  colorScheme: COLOR_SCHEME[theme],
  hasTouch: touch,
  isMobile: touch && VIEWPORTS[viewport].width < 760,
  viewport: VIEWPORTS[viewport],
});

// One file with hundreds of tests that share nothing (each opens its own page): without this the whole file is one
// group and runs in a single worker, however many there are.
export function configureMatrix() {
  test.describe.configure({ mode: "parallel" });

  test.beforeEach(({ browserName }, testInfo) => {
    test.skip(
      browserName !== "chromium" ||
        testInfo.project.name !== "chromium-desktop",
      "the matrix sets its own viewports and touch: the Pixel 5 project would repeat it"
    );
  });
}

export async function openScreen(screen: UiScreen, page: Page) {
  await page.addInitScript(startMotionRecorder);
  await screen.open(page, page.context());
}
