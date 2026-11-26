/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import {
  CHECK_CONTEXTS,
  MOTION_CONTEXT,
  SCREENS,
  type UiCheck,
  type UiContext,
  type UiScreen,
} from "../ui-screens";
import { GUARDRAIL_GROUPS } from "./groups";
import {
  axeFaults,
  focusFaults,
  overflowFaults,
  readMotion,
  repeatedNameFaults,
  runningMotion,
  touchFaults,
} from "./measures";
import {
  configureMatrix,
  contextName,
  contextOptions,
  openScreen,
} from "./matrix";

/**
 * The interface guardrails: what the UX review finds by measuring, measured on every screen of
 * `ui-screens.ts`, each check only on the axes that can change its result (`CHECK_CONTEXTS`, with the table in
 * docs/runbooks/testes-de-tela.md). Each check has a control case in `controle-medidas.e2e.ts` and
 * `controle-movimento.e2e.ts` that proves it catches the fault it is for (a check that never fails proves nothing).
 * Adding a screen: docs/runbooks/testes-de-tela.md.
 *
 *   1. nothing leaves its container nor the viewport      4. colors only in OKLCH and tokens: scripts/ui-source-rules.test.ts
 *   2. touch area of 44 px, neighbors do not overlap      5. motion: nothing animates with reduce
 *   3. axe, WCAG 2.2 A and AA                              6. keyboard focus draws the 3 px ring
 */

/** The distinct contexts of the map, each with the checks that run on it: one page load serves them all. */
function contextsOfChecks() {
  const byKey = new Map<string, { checks: UiCheck[]; context: UiContext }>();
  for (const check of Object.keys(CHECK_CONTEXTS) as UiCheck[]) {
    for (const context of CHECK_CONTEXTS[check]) {
      const key = contextName(context);
      const entry = byKey.get(key) ?? { checks: [], context };
      entry.checks.push(check);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

/**
 * The checks of the screens of one group: the map is split round-robin into `GUARDRAIL_GROUPS` files, so that no file
 * outlasts the shard it lands on and a screen added at the end of the map moves no other.
 */
export function registerScreenChecks(group: number) {
  configureMatrix();

  // a check with no context would vanish without a test or a warning (a green run that ran nothing)
  for (const [check, contexts] of Object.entries(CHECK_CONTEXTS)) {
    if (contexts.length === 0) {
      throw new Error(
        `CHECK_CONTEXTS lists no context for the check "${check}"`
      );
    }
  }

  const screens = SCREENS.filter(
    (_, index) => index % GUARDRAIL_GROUPS === group - 1
  );
  for (const screen of screens) {
    registerScreen(screen);
  }
}

function registerScreen(screen: UiScreen) {
  for (const { checks, context } of contextsOfChecks()) {
    const where = `${screen.name} · ${contextName(context)}`;
    const runs = (check: UiCheck) => checks.includes(check);

    test.describe(where, () => {
      test.use(contextOptions(context));

      // One page load for the checks that only read: each reports on its own (soft), so a run shows every fault.
      test(`verificações: ${checks.join(", ")}`, async ({ page }) => {
        await openScreen(screen, page);
        // the context is what the name says: the 44 px areas of the touch check exist only with `pointer: coarse`
        expect(
          await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
          "o contexto tem o ponteiro que o nome diz"
        ).toBe(context.touch);
        if (runs("overflow")) {
          expect
            .soft(
              (await overflowFaults(page)).sort(),
              "1. nada sai do contêiner"
            )
            .toEqual([]);
        }
        if (runs("touch")) {
          expect
            .soft(
              (
                await touchFaults(page, {
                  exemptInlineLinks: true,
                  minimum: 44,
                })
              ).sort(),
              "2. área de toque"
            )
            .toEqual([]);
        }
        if (runs("axe")) {
          expect
            .soft((await axeFaults(page)).sort(), "3. axe WCAG 2.2 A e AA")
            .toEqual([]);
        }
        if (runs("focus")) {
          expect
            .soft((await focusFaults(page)).sort(), "6. foco de 3 px")
            .toEqual([]);
        }
        if (runs("names")) {
          expect
            .soft(
              (await repeatedNameFaults(page)).sort(),
              "10. nome acessível dito uma vez"
            )
            .toEqual([]);
        }
      });
    });
  }

  // Motion (5): once per state, in one context, and once more with reduce.
  const motionWhere = `${screen.name} · ${contextName(MOTION_CONTEXT)}`;
  test.describe(`${motionWhere} · movimento reduzido`, () => {
    test.use({ ...contextOptions(MOTION_CONTEXT), reducedMotion: "reduce" });

    test("com prefers-reduced-motion: reduce nada anima", async ({ page }) => {
      await openScreen(screen, page);
      await screen.exercise?.(page);
      expect(runningMotion(await readMotion(page))).toEqual([]);
    });
  });
}
