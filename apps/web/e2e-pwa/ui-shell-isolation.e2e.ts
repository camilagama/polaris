/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveEntry } from "./ui-entry-states";
import {
  addLegacyRule,
  addPageRule,
  addProbe,
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

/** The fonts are in and the finite animations are over (a spinner that never ends is not waited for). */
const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.effect?.getComputedTiming().iterations ===
            Number.POSITIVE_INFINITY || animation.playState !== "running"
      )
  );
};

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
  await settle(page);
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
      await settle(page);
    },
  })),
];

for (const screen of SCREENS) {
  test(`${screen.name}: a camada legacy não muda nada sob [data-ui]`, async ({
    page,
  }) => {
    await screen.open(page);
    await addProbe(page);
    const state = await legacyLayerOnAndOff(page);
    const names = Object.keys(state.on.snapshot);
    // the check is not vacuous: the layer was on the page and came off, there was something to measure, the probe
    // was measured, and so was the focus (Tab put the page in keyboard mode and some control took the ring)
    expect(state.off.removed).toBeGreaterThan(100);
    expect(names.length).toBeGreaterThan(20);
    expect(
      names.some((name) => name.startsWith('input "sonda com erro"'))
    ).toBe(true);
    expect(names.some((name) => name.endsWith(":focus-visible"))).toBe(true);
    expect(leaks(state)).toEqual([]);
  });
}

test.describe("controle: a verificação pega a regra legacy que vaza", () => {
  // each rule is the fault in the shape it had, injected in the layer; `found` is what the check must print for it
  const LEAKS = [
    // the real fault of "Trocar senha": the field of the group takes the border of the old input
    {
      css: ".ui-root input { border: 1px solid rgb(255 0 0); }",
      found:
        'input[input-group-control] "Senha atual": border-top-color rgb(255, 0, 0) (com legacy)',
      name: ".ui-root input (a regra do ui.css antes da correção)",
    },
    // a rule of the old sheets for every button of the page, with no `.ui-root` to say where it is meant for
    {
      css: "button { text-transform: uppercase; }",
      found: ": text-transform uppercase (com legacy)",
      from: 'button[button] "Mostrar',
      name: "button sem escopo",
    },
    {
      css: ".ui-root :focus-visible { outline: 3px solid rgb(255 0 0); }",
      found: ":focus-visible: outline-color rgb(255, 0, 0) (com legacy)",
      name: ".ui-root :focus-visible (o contorno do campo e do título)",
    },
    // the rules of ui.css that the open screens do not show, on the probe
    {
      css: '.ui-root input[aria-invalid="true"] { border-color: rgb(255 0 0); }',
      found:
        'input "sonda com erro": border-top-color rgb(255, 0, 0) (com legacy)',
      name: '.ui-root input[aria-invalid="true"]',
    },
    {
      css: ".ui-root input::placeholder { color: rgb(255 0 0); }",
      found:
        'input "sonda com texto de apoio" ::placeholder: color rgb(255, 0, 0) (com legacy)',
      name: ".ui-root input::placeholder",
    },
    {
      css: ".ui-root select { box-sizing: content-box; }",
      found: 'select "sonda de lista": box-sizing content-box (com legacy)',
      name: ".ui-root select",
    },
    {
      css: ".ui-root textarea { box-sizing: content-box; }",
      found: 'textarea "sonda de texto": box-sizing content-box (com legacy)',
      name: ".ui-root textarea",
    },
  ];
  for (const leak of LEAKS) {
    test(leak.name, async ({ page }) => {
      await CHANGE_PASSWORD.open(page);
      await addProbe(page);
      await addLegacyRule(page, leak.css);
      const found = leaks(await legacyLayerOnAndOff(page));
      expect(
        found.some(
          (line) =>
            line.startsWith(leak.from ?? "") && line.includes(leak.found)
        )
      ).toBe(true);
    });
  }

  test("o que transiciona também é visto (a leitura não pega o começo da transição)", async ({
    page,
  }) => {
    await CHANGE_PASSWORD.open(page);
    await addPageRule(page, "[data-ui] input { transition: border-color 5s; }");
    await addLegacyRule(page, ".ui-root input { border-color: rgb(255 0 0); }");
    const found = leaks(await legacyLayerOnAndOff(page));
    expect(
      found.some((line) =>
        line.includes(
          'input[input-group-control] "Senha atual": border-top-color rgb(255, 0, 0)'
        )
      )
    ).toBe(true);
  });

  test("uma regra legacy só para o que é antigo não reprova", async ({
    page,
  }) => {
    await CHANGE_PASSWORD.open(page);
    await addProbe(page);
    await addLegacyRule(
      page,
      ".app-shell-root header, .app-shell-root footer, .app-shell-root nav { border: 2px solid rgb(255 0 0); padding: 9px; }"
    );
    expect(leaks(await legacyLayerOnAndOff(page))).toEqual([]);
  });
});
