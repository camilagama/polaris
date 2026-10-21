/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveEntry } from "./ui-entry-states";
import {
  addLegacyRule,
  leaks,
  legacyLayerOnAndOff,
} from "./ui-shell-isolation";

/**
 * The migrated screens inside the real shell (t193): nothing of `@layer legacy` may reach what is under `[data-ui]`
 * (ADR 0103, section 3; the break was `.ui-root input` giving the field of "Trocar senha" a border and a 2.8rem
 * height). The screens of the guardrails (`ui-screens.ts`) run in the lab, which has no `.ui-root`, so they do not see it.
 * How the proof works is in `ui-shell-isolation.ts`; the runbook is docs/runbooks/testes-de-tela.md.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const json = (body: unknown) => ({
  body: JSON.stringify(body),
  contentType: "application/json",
});

/** The app as someone signed in sees it: a session, one organization, and no server for anything else (offline). */
async function openInShell(
  page: Page,
  path: string,
  ready: () => Promise<void>
) {
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill(
      json({ emailPassword: true, google: true, turnstileSiteKey: null })
    )
  );
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill(json({ session: { id: "s" }, user: { id: "u" } }))
  );
  await page.route("**/rpc/**", (route) =>
    new URL(route.request().url()).pathname.endsWith("/organization/listMine")
      ? route.fulfill(
          json({ json: { organizations: [ORGANIZATION] }, meta: [] })
        )
      : route.abort("internetdisconnected")
  );
  await page.goto(path);
  await expect(page.locator(".ui-root.app-shell-root")).toBeVisible();
  await ready();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((animation) => animation.playState !== "running")
  );
}

/** The pages of the entry and of the password: outside the shell, with the same sheets on the page. */
const ENTRY_PAGES = [
  { heading: "Entrar no Polaris", path: "/entrar" },
  { heading: "Criar conta", path: "/criar-conta" },
  { heading: "Esqueci a senha", path: "/esqueci-a-senha" },
  { heading: "Nova senha", path: "/redefinir-senha#token=tok-de-teste" },
];

const CHANGE_PASSWORD = {
  name: "Trocar senha no shell",
  open: (page: Page) =>
    openInShell(page, "/conta/seguranca", () =>
      expect(page.getByLabel("Senha atual")).toBeVisible()
    ),
};

const SCREENS = [
  CHANGE_PASSWORD,
  {
    name: "Venda no shell",
    open: (page: Page) =>
      openInShell(page, "/", () =>
        expect(
          page.getByRole("heading", { level: 1, name: "Nova venda" })
        ).toBeVisible()
      ),
  },
  ...ENTRY_PAGES.map(({ heading, path }) => ({
    name: path,
    open: async (page: Page) => {
      await serveEntry(page);
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: heading })
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every((animation) => animation.playState !== "running")
      );
    },
  })),
];

for (const screen of SCREENS) {
  test(`${screen.name}: a camada legacy não muda nada sob [data-ui]`, async ({
    page,
  }) => {
    await screen.open(page);
    const state = await legacyLayerOnAndOff(page);
    // the check is not vacuous: the layer was on the page, there was something to measure, and it came off
    expect(state.off.removed).toBeGreaterThan(100);
    expect(Object.keys(state.on.snapshot).length).toBeGreaterThan(20);
    expect(leaks(state)).toEqual([]);
  });
}

test.describe("controle: a verificação pega a regra legacy que vaza", () => {
  // each rule is the fault in the shape it had, injected in the layer; the line the check must print says what it reached
  const LEAKS = [
    // the real fault of "Trocar senha": the field of the group takes the border of the old input
    {
      css: ".ui-root input { border: 1px solid rgb(255 0 0); }",
      found: 'input "Senha atual": border-top-color rgb(255, 0, 0)',
      name: ".ui-root input (a regra do ui.css antes da correção)",
    },
    // a rule of the old sheets for every button of the page, with no `.ui-root` to say where it is meant for
    {
      css: "button { text-transform: uppercase; }",
      found: "button",
      name: "button sem escopo",
    },
    {
      css: ".ui-root :focus-visible { outline: 3px solid rgb(255 0 0); }",
      found: ":focus-visible: outline-color rgb(255, 0, 0)",
      name: ".ui-root :focus-visible (o contorno do campo e do título)",
    },
  ];
  for (const leak of LEAKS) {
    test(leak.name, async ({ page }) => {
      await CHANGE_PASSWORD.open(page);
      await addLegacyRule(page, leak.css);
      const found = leaks(await legacyLayerOnAndOff(page));
      expect(found.some((line) => line.includes(leak.found))).toBe(true);
    });
  }

  test("uma regra legacy só para o que é antigo não reprova", async ({
    page,
  }) => {
    await CHANGE_PASSWORD.open(page);
    await addLegacyRule(
      page,
      ".app-shell-root header, .app-shell-root footer, .app-shell-root nav { border: 2px solid rgb(255 0 0); padding: 9px; }"
    );
    expect(leaks(await legacyLayerOnAndOff(page))).toEqual([]);
  });
});
