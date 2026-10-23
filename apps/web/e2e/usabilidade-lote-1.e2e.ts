/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Correções de usabilidade do staging, lote 1 (t213; U-NN são os achados do Diego e do Petković de 22/10).
 * Navegador de verdade, com o servidor substituído por respostas no formato do RPC.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const SESSION_MARKER_KEY = "polaris.sessionMarker";
const DARK = /\bdark\b/;
const RGBA_WITH_ALPHA = /^rgba\(.*,\s*0?\.\d+\)$/;
const PRIMARY = /primary-button/;
const NOT_STORED_ON_DEVICE = /tudo guardado neste aparelho/;

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  status,
});
const rpcError = (code: string, status: number, reason?: string) =>
  rpc(
    {
      code,
      data: reason ? { reason } : undefined,
      defined: true,
      message: code,
      status,
    },
    status
  );
const unauthorized = rpc(
  {
    code: "UNAUTHORIZED",
    data: undefined,
    defined: false,
    message: "Unauthorized",
    status: 401,
  },
  401
);

async function openLab(
  page: Page,
  screen: "customers" | "public-catalog" | "sale"
) {
  await page.goto(`/offline-screens-lab?screen=${screen}`);
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
}

/* -------------------------------------------------------------------------- */
/* U-01: "Sua sessão acabou" só quando havia sessão                            */
/* -------------------------------------------------------------------------- */

async function openWithoutSession(page: Page) {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ body: "null", contentType: "application/json" })
  );
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill({
      body: JSON.stringify({
        emailPassword: false,
        google: true,
        turnstileSiteKey: null,
      }),
      contentType: "application/json",
    })
  );
  await page.route("**/rpc/**", (route) => route.fulfill(unauthorized));
}

test("U-01: na primeira visita, sem nenhuma sessão antes, a entrada não diz que a sessão acabou", async ({
  page,
}) => {
  await openWithoutSession(page);
  await page.goto("/");
  await page.waitForURL("**/entrar?voltar=/");
  await expect(
    page.getByRole("heading", { name: "Entrar no Polaris" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continuar com o Google" })
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("sessão acabou");
  await expect(page.locator("body")).not.toContainText("Você saiu");
});

test("U-01: depois de 'Sair' a entrada diz 'Você saiu. Entre de novo quando quiser.'", async ({
  page,
}) => {
  await openWithoutSession(page);
  // what "Sair" leaves behind just before it goes to the start
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, "saiu");
  }, SESSION_MARKER_KEY);
  await page.goto("/");
  await page.waitForURL("**/entrar?motivo=saiu&voltar=/");
  await expect(
    page.getByText("Você saiu. Entre de novo quando quiser.", { exact: true })
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("sessão acabou");
});

test("U-01: a sessão que existia e acabou continua dizendo 'Sua sessão acabou'", async ({
  page,
}) => {
  await openWithoutSession(page);
  await page.addInitScript((key) => {
    // only on the opening: the sign-in screen it ends up on must not get the mark back
    if (window.location.pathname === "/") {
      window.localStorage.setItem(key, "ativa");
    }
  }, SESSION_MARKER_KEY);
  await page.goto("/");
  await page.waitForURL("**/entrar?motivo=sessao&voltar=/");
  await expect(
    page.getByText("Sua sessão acabou. Entre de novo.", { exact: true })
  ).toBeVisible();
  // said once: the next opening without a session starts clean
  expect(
    await page.evaluate(
      (key) => window.localStorage.getItem(key),
      SESSION_MARKER_KEY
    )
  ).toBeNull();
});

/* -------------------------------------------------------------------------- */
/* U-07: o chip do estado não é cortado a 360 nem a 320 px (cabeçalho v5.1)    */
/* -------------------------------------------------------------------------- */

for (const width of [360, 320]) {
  test(`U-07: o chip de estado do cabeçalho aparece inteiro a ${width} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width });
    await page.route("**/rpc/organization/listMine", (route) =>
      route.fulfill(rpc({ organizations: [ORGANIZATION] }))
    );
    await page.route("**/rpc/device/list", (route) =>
      route.fulfill(rpc({ devices: [] }))
    );
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill({
        body: JSON.stringify({ user: { id: "u" } }),
        contentType: "application/json",
      })
    );
    await page.goto("/devices");
    const chipText = page.locator(".sync-status-short");
    await expect(chipText).toBeVisible();
    const sizes = await chipText.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    // no ellipsis: all of the text fits in its box
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
    const box = await page.locator(".sync-status").boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    // the brand and the chip share the one line of the header of the phone (v5.1), and it stays 48 px tall
    const brand = await page
      .getByRole("link", { exact: true, name: "Polaris" })
      .boundingBox();
    expect(brand).not.toBeNull();
    expect(box).not.toBeNull();
    const chipMiddle = (box?.y ?? 0) + (box?.height ?? 0) / 2;
    expect(chipMiddle).toBeGreaterThan(brand?.y ?? 0);
    expect(chipMiddle).toBeLessThan((brand?.y ?? 0) + (brand?.height ?? 0));
    expect((brand?.x ?? 0) + (brand?.width ?? 0)).toBeLessThan(box?.x ?? 0);
    const header = await page.locator("header").first().boundingBox();
    expect(header?.height ?? 0).toBeLessThanOrEqual(49);
  });
}

/* -------------------------------------------------------------------------- */
/* U-40: o tema segue o sistema com a página aberta                            */
/* -------------------------------------------------------------------------- */

test("U-40: ao voltar o sistema de escuro para claro, a página sai do escuro sem recarregar", async ({
  page,
}) => {
  await openWithoutSession(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/entrar");
  await expect(page.locator("html")).toHaveClass(DARK);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(DARK);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(DARK);
});

test("U-40: quem escolheu o tema claro ou escuro não é mexido pelo sistema", async ({
  page,
}) => {
  await openWithoutSession(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("polaris-tema", "escuro");
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/entrar");
  await expect(page.locator("html")).toHaveClass(DARK);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(DARK);
});

/* -------------------------------------------------------------------------- */
/* U-19: a barra presa da venda é opaca e a página rola acima dela            */
/* -------------------------------------------------------------------------- */

test("U-19: a barra presa da venda tem fundo opaco e a página guarda espaço para ela ao rolar", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  await page.route("**/rpc/paymentProfile/list", (route) =>
    route.fulfill(rpc({ profiles: [] }))
  );
  await openLab(page, "sale");
  const bar = page.locator("[data-submit-bar]");
  await expect(bar).toBeVisible();
  const background = await bar.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  // an opaque color has no alpha: `rgb(...)`, or an `oklch(...)` without `/`
  expect(background).not.toContain("/");
  expect(background).not.toMatch(RGBA_WITH_ALPHA);
  const padding = await page.evaluate(
    () => getComputedStyle(document.documentElement).scrollPaddingBottom
  );
  expect(Number.parseFloat(padding)).toBeGreaterThanOrEqual(96);
});

/* -------------------------------------------------------------------------- */
/* U-24, U-25, U-28: formulário de clientes                                    */
/* -------------------------------------------------------------------------- */

async function expectMarked(page: Page, selector: string) {
  await expect(page.locator(selector)).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(selector)).toHaveAttribute(
    "aria-describedby",
    "customer-contact-error"
  );
}

async function register(page: Page, name: string, phone: string) {
  await page.locator("#customer-name").fill(name);
  await page.locator("#customer-phone").fill(phone);
  await page.getByRole("button", { name: "Cadastrar cliente" }).click();
}

test("U-24 e U-28: cliente sem contato — o erro fica junto do botão, os campos ficam marcados e o anel de foco não risca o texto", async ({
  page,
}) => {
  await openLab(page, "customers");
  await page.locator("#customer-name").fill("Sem Contato");
  await page.getByRole("button", { name: "Cadastrar cliente" }).click();

  const error = page.locator("#customer-contact-error");
  await expect(error).toHaveText(
    "Informe ao menos um telefone ou email para o cliente."
  );
  // beside the save button, not at the top of the page
  const save = page.getByRole("button", { name: "Cadastrar cliente" });
  const errorBox = await error.boundingBox();
  const saveBox = await save.boundingBox();
  expect(Math.abs((saveBox?.y ?? 0) - (errorBox?.y ?? 0))).toBeLessThan(120);
  await expect(page.locator(".customer-error")).toHaveCount(0);
  // the fields are marked and say why, and the focus goes to the first
  await expectMarked(page, "#customer-phone");
  await expectMarked(page, "#customer-email");
  await expect(page.locator("#customer-phone")).toBeFocused();
  // typing a contact takes the error away
  await page.locator("#customer-phone").fill("11900000009");
  await expect(error).toHaveCount(0);
  await expect(page.locator("#customer-phone")).not.toHaveAttribute(
    "aria-invalid",
    "true"
  );

  // U-28: the 3 px ring plus its 3 px offset clear the text under a field
  await page.evaluate(() => {
    const field = document.querySelector("#customer-name");
    const message = document.createElement("p");
    message.className = "field-error";
    message.textContent = "x";
    field?.after(message);
  });
  const margin = await page
    .locator("p.field-error")
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).marginTop)
    );
  expect(margin).toBeGreaterThanOrEqual(6);
});

test("U-25: cliente parecido — o aviso é anunciado e 'Usar existente' é a ação principal", async ({
  page,
}) => {
  await openLab(page, "customers");
  await page.getByLabel("Rede disponível").uncheck();
  await register(page, "Carla Dias", "11900000003");
  await expect(
    page.locator(".customer-card", { hasText: "Carla Dias" })
  ).toBeVisible();
  await register(page, "Carla D.", "11900000003");
  await expect(page.getByText("Correspondência por telefone.")).toBeVisible();
  // a live region that was there before the panel, now with the sentence
  await expect(
    page.locator('[role="status"].visually-hidden').first()
  ).toContainText("Encontramos possíveis clientes existentes");
  const useExisting = page.getByRole("button", {
    name: "Usar existente: Carla Dias",
  });
  const createAnyway = page.getByRole("button", { name: "Criar mesmo assim" });
  await expect(useExisting).toHaveClass(PRIMARY);
  await expect(createAnyway).not.toHaveClass(PRIMARY);
  await createAnyway.click();
  await expect(
    page.locator(".customer-card", { hasText: "Carla D." })
  ).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* U-48, U-49, U-54: perfil público do catálogo                                */
/* -------------------------------------------------------------------------- */

const SETUP = {
  enabled: true,
  profile: null,
  publicOrigin: "https://catalogo.example",
  publishedProductIds: [],
};
const SAVED_PROFILE = {
  description: null,
  instagram: null,
  publicName: "Loja da Ana",
  published: false,
  slug: "loja-da-ana",
  version: 1,
  whatsapp: null,
};

interface CatalogServer {
  saves: number;
  toggles: number;
}

/** The catalog procedures: `saveProfile` is answered by `onSave`; the rest is what the screen needs to open. */
async function serveCatalog(
  page: Page,
  onSave: () => ReturnType<typeof rpc>
): Promise<CatalogServer> {
  const server: CatalogServer = { saves: 0, toggles: 0 };
  let profile: typeof SAVED_PROFILE | null = null;
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "publicCatalog/setup") {
      return route.fulfill(rpc({ ...SETUP, profile }));
    }
    if (procedure === "product/list") {
      return route.fulfill(rpc({ products: [] }));
    }
    if (procedure === "publicCatalog/saveProfile") {
      server.saves += 1;
      const answer = onSave();
      if (answer.status === 200) {
        profile = SAVED_PROFILE;
      }
      return route.fulfill(answer);
    }
    if (procedure === "publicCatalog/setPublished" && profile) {
      server.toggles += 1;
      profile = { ...profile, published: !profile.published, version: 2 };
      return route.fulfill(rpc({ profile }));
    }
    return route.abort("internetdisconnected");
  });
  return server;
}

async function fillProfile(page: Page, name: string, slug: string) {
  await page.getByLabel("Nome público").fill(name);
  await page.getByLabel("Endereço", { exact: true }).fill(slug);
}

test("U-48: erro 400 do servidor ao salvar não apaga o Nome nem o Endereço e aparece no campo Endereço", async ({
  page,
}) => {
  const server = await serveCatalog(page, () =>
    rpcError("BAD_REQUEST", 400, "invalid_slug")
  );
  await openLab(page, "public-catalog");
  await expect(
    page.getByRole("heading", { name: "Perfil público" })
  ).toBeVisible();

  await fillProfile(page, "Loja da Ana", "loja-da-ana");
  await page.getByRole("button", { name: "Salvar perfil" }).click();
  await expect.poll(() => server.saves).toBe(1);

  // what was typed stays, even after the screen read the server again
  await expect(page.getByLabel("Nome público")).toHaveValue("Loja da Ana");
  await expect(page.getByLabel("Endereço", { exact: true })).toHaveValue(
    "loja-da-ana"
  );
  // the error is on the address field, tied to it, and the focus goes there
  const slug = page.locator("#public-slug");
  await expect(page.locator("#public-slug-error")).toContainText(
    "O endereço precisa ter de 3 a 40 caracteres"
  );
  await expect(slug).toHaveAttribute("aria-invalid", "true");
  await expect(slug).toHaveAttribute("aria-describedby", "public-slug-error");
  await expect(slug).toBeFocused();
  // and not at the top of the page
  await expect(page.locator("h1 ~ .public-catalog-message")).toHaveCount(0);
  // fixing the address clears the mark
  await slug.fill("loja-da-ana-2");
  await expect(page.locator("#public-slug-error")).toHaveCount(0);
});

test("U-48: endereço inválido é recusado no cliente, sem chamar o servidor e sem mexer no formulário", async ({
  page,
}) => {
  const server = await serveCatalog(page, () => rpc({}));
  await openLab(page, "public-catalog");
  await fillProfile(page, "Loja da Ana", "Loja da Ana!");
  await page.getByRole("button", { name: "Salvar perfil" }).click();
  await expect(page.locator("#public-slug-error")).toBeVisible();
  await expect(page.getByLabel("Nome público")).toHaveValue("Loja da Ana");
  await expect(page.getByLabel("Endereço", { exact: true })).toHaveValue(
    "Loja da Ana!"
  );
  expect(server.saves).toBe(0);
});

test("U-49: 'Perfil salvo.', 'Catálogo ligado.' e o erro aparecem junto do botão, em regiões vivas", async ({
  page,
}) => {
  await serveCatalog(page, () => rpc({ profile: SAVED_PROFILE }));
  await openLab(page, "public-catalog");
  await fillProfile(page, "Loja da Ana", "loja-da-ana");
  const save = page.getByRole("button", { name: "Salvar perfil" });
  await save.click();

  const form = page.locator("form.public-catalog-card");
  const saved = form.getByText("Perfil salvo.");
  await expect(saved).toBeVisible();
  await expect(
    form.locator('[role="status"]', { hasText: "Perfil salvo." })
  ).toHaveCount(1);
  // under the button that ran it
  const saveBox = await save.boundingBox();
  const savedBox = await saved.boundingBox();
  expect(savedBox?.y ?? 0).toBeGreaterThan(saveBox?.y ?? 0);
  expect((savedBox?.y ?? 0) - (saveBox?.y ?? 0)).toBeLessThan(120);
  // nothing at the top of the page
  await expect(page.locator("h1 ~ .public-catalog-message")).toHaveCount(0);

  const toggle = page.getByRole("button", { name: "Ligar catálogo" });
  await toggle.click();
  const switchCard = page.locator("section", {
    has: page.getByRole("heading", { exact: true, name: "Catálogo" }),
  });
  await expect(switchCard.getByText("Catálogo ligado.")).toBeVisible();
  await expect(
    switchCard.locator('[role="status"]', { hasText: "Catálogo ligado." })
  ).toHaveCount(1);
});

test("U-54: numa tela que só funciona online, o chip sem conexão diz que a tela precisa de internet", async ({
  page,
}) => {
  await serveCatalog(page, () => rpc({}));
  await openLab(page, "public-catalog");
  await page.getByLabel("Rede disponível").uncheck();
  const chip = page.locator(".sync-status");
  await expect(chip).toHaveAttribute(
    "title",
    "Sem conexão · esta tela precisa de internet"
  );
  await expect(chip).not.toHaveAttribute("title", NOT_STORED_ON_DEVICE);
});

test("U-54: numa tela que guarda no aparelho, o chip continua dizendo 'tudo guardado neste aparelho'", async ({
  page,
}) => {
  await openLab(page, "customers");
  await page.getByLabel("Rede disponível").uncheck();
  await expect(page.locator(".sync-status")).toHaveAttribute(
    "title",
    "Sem conexão · tudo guardado neste aparelho"
  );
});
