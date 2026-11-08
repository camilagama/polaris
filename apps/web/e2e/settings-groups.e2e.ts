/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { axeFaults } from "../e2e-pwa/ui-guardrails";
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
 * The tabs of Configurações in two named rows from 760 px: "Da loja" and "Da conta". What a person sees does not
 * change (a row with no tab to show is not drawn, nor its name), the addresses open the same tab, and below 760 px
 * there is no strip: a list of the same rows, each opening its tab, with a way back to the list.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  timezone: "America/Sao_Paulo",
};
const rpc = (json: unknown) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

const LIST_ADDRESS = /\/configuracoes$/;
const HEALTH_ADDRESS = /\/health$/;
const PHONE_WIDTH = 760;
const PHONE = { height: 740, width: 360 };

interface Options {
  billingSelfService?: boolean;
  passwordOn?: boolean;
  /** `owner` has every capability; any other role has none. */
  role?: string;
  size?: { height: number; width: number };
}

async function openSettings(
  page: Page,
  path: string,
  {
    billingSelfService = true,
    passwordOn = true,
    role = "owner",
    size = { height: 800, width: 1280 },
  }: Options = {}
) {
  await page.setViewportSize(size);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await page.route("**/api/auth-methods", (route) =>
    route.fulfill({
      body: JSON.stringify({ emailPassword: passwordOn, google: true }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/listMine") {
      return route.fulfill(
        rpc({
          billingSelfService,
          organizations: [{ ...ORGANIZATION, role }],
        })
      );
    }
    if (procedure === "paymentProfile/list") {
      return route.fulfill(rpc({ profiles: [] }));
    }
    return route.abort("internetdisconnected");
  });
  await page.goto(path);
  if (size.width < PHONE_WIDTH) {
    await expect(
      page.getByRole("heading", { level: 1, name: "Configurações" })
    ).toBeVisible();
    return;
  }
  await expect(
    page.getByRole("tablist", { name: "Configurações" })
  ).toBeVisible();
}

const list = (page: Page) =>
  page.getByRole("tablist", { name: "Configurações" });
const tab = (page: Page, name: string) =>
  list(page).getByRole("tab", { exact: true, name });
const label = (page: Page, name: string) =>
  page.locator(`[data-tabs-group="${name}"]`);

const voltar = (page: Page) =>
  page.getByRole("link", { name: "Voltar para Configurações" });
const rows = (page: Page) => page.locator("[data-settings-row]");

async function rowNames(page: Page) {
  return await rows(page).allTextContents();
}

async function tabNames(page: Page) {
  return await list(page).getByRole("tab").allTextContents();
}

test("o dono vê as duas linhas, cada aba na sua, na ordem de antes", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes");
  await expect(label(page, "Da loja")).toBeVisible();
  await expect(label(page, "Da conta")).toBeVisible();
  expect(await tabNames(page)).toEqual([
    "Formas de receber",
    "Catálogo público",
    "Aparelhos",
    "Assinatura",
    "Senha",
    "Seus dados",
  ]);
  const [shop, account] = await Promise.all([
    tab(page, "Catálogo público").boundingBox(),
    tab(page, "Aparelhos").boundingBox(),
  ]);
  expect(account?.y).toBeGreaterThan((shop?.y ?? 0) + (shop?.height ?? 0) - 1);
  const [shopLabel, accountLabel] = await Promise.all([
    label(page, "Da loja").boundingBox(),
    label(page, "Da conta").boundingBox(),
  ]);
  expect(accountLabel?.y).toBeGreaterThan(shopLabel?.y ?? 0);
  expect(accountLabel?.x).toBe(shopLabel?.x);
  await expect(list(page).locator("[role=none]")).not.toHaveCount(0);
});

test("sem capacidade, sem autosserviço e com a senha desligada, a linha da conta só tem Aparelhos (o runtime offline está ligado neste build)", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes", {
    billingSelfService: false,
    passwordOn: false,
    role: "staff",
  });
  await expect(label(page, "Da loja")).toBeVisible();
  await expect(label(page, "Da conta")).toBeVisible();
  expect(await tabNames(page)).toEqual([
    "Formas de receber",
    "Catálogo público",
    "Aparelhos",
  ]);
});

test("as capacidades escondem o que escondiam: Assinatura só com billing:manage e autosserviço, Seus dados só com organization:export, Senha só com a senha ligada", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes", {
    billingSelfService: false,
    passwordOn: true,
  });
  expect(await tabNames(page)).toEqual([
    "Formas de receber",
    "Catálogo público",
    "Aparelhos",
    "Senha",
    "Seus dados",
  ]);
  await expect(label(page, "Da conta")).toBeVisible();
});

for (const [address, name] of [
  ["/configuracoes", "Formas de receber"],
  ["/configuracoes?aba=catalogo-publico", "Catálogo público"],
  ["/configuracoes?aba=assinatura", "Assinatura"],
  ["/configuracoes?aba=senha", "Senha"],
  ["/configuracoes?aba=seus-dados", "Seus dados"],
  ["/subscription", "Assinatura"],
  ["/public-catalog", "Catálogo público"],
  ["/payment-profiles", "Formas de receber"],
] as const) {
  test(`${address} abre a aba ${name}, nas linhas`, async ({ page }) => {
    await openSettings(page, address);
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-tabs-group]")).toHaveCount(2);
  });
}

test("as setas andam pela lista toda, de uma linha à outra, e Enter abre", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes?aba=catalogo-publico");
  await tab(page, "Catálogo público").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Aparelhos")).toBeFocused();
  await expect(tab(page, "Aparelhos")).toHaveAttribute("tabindex", "0");
  await expect(tab(page, "Catálogo público")).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Enter");
  await expect(tab(page, "Aparelhos")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Catálogo público")).toBeFocused();
});

for (const width of [760, 1280]) {
  test(`a lista de abas nas linhas não tem violação de axe nem rola de lado a ${width} px`, async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", {
      size: { height: 800, width },
    });
    expect(await axeFaults(page, '[role="tablist"]')).toEqual([]);
    const sideways = await list(page).evaluate((element) => {
      const scroller = element.parentElement as HTMLElement;
      return scroller.scrollWidth > scroller.clientWidth + 1;
    });
    expect(sideways).toBe(false);
  });
}

test("abaixo de 760 px não há faixa nem nomes de linha de aba: há a lista, e a 760 px voltam as linhas", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes", { size: PHONE });
  await expect(page.locator("[data-tabs-group]")).toHaveCount(0);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Seus dados" })).toBeVisible();
  await page.setViewportSize({ height: 800, width: 760 });
  await expect(page.locator("[data-tabs-group]")).toHaveCount(2);
  await expect(tab(page, "Formas de receber")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.setViewportSize({ height: 800, width: 759 });
  await expect(page.locator("[data-tabs-group]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Da loja" })).toBeVisible();
});

test("trocar de 1280 para 400 px e voltar mantém a aba aberta, o endereço e o que foi digitado", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes?aba=formas-de-receber");
  await page.getByRole("button", { name: "Novo perfil" }).click();
  await page.getByLabel("Nome do perfil").fill("Maquininha nova");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await tab(page, "Catálogo público").click();

  await page.setViewportSize({ height: 800, width: 400 });
  await expect(page.locator("[data-tabs-group]")).toHaveCount(0);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(voltar(page)).toBeVisible();
  expect(page.url()).toContain("aba=catalogo-publico");
  await page.setViewportSize({ height: 800, width: 1280 });
  await expect(page.locator("[data-tabs-group]")).toHaveCount(2);
  await expect(tab(page, "Catálogo público")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(page.url()).toContain("aba=catalogo-publico");

  await tab(page, "Formas de receber").click();
  await page.getByRole("button", { name: "Novo perfil" }).click();
  await expect(page.getByLabel("Nome do perfil")).toHaveValue(
    "Maquininha nova"
  );
});

test("o nome da linha é lido e cada aba é anunciada dentro do seu grupo, na lista única", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes");
  expect(await label(page, "Da loja").getAttribute("aria-hidden")).toBeNull();
  const tree = await list(page).ariaSnapshot();
  expect(tree).toContain("Da loja");
  expect(tree).toContain("Da conta");
  await expect(page.getByRole("tablist")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Da loja" })).toHaveCount(0);
  const inGroup = {
    "Da loja": ["Formas de receber", "Catálogo público"],
    "Da conta": ["Aparelhos", "Assinatura", "Senha", "Seus dados"],
  };
  await Promise.all(
    Object.entries(inGroup).flatMap(([group, names]) =>
      names.map((name) =>
        expect(tab(page, name)).toHaveAccessibleDescription(group)
      )
    )
  );
});

const SIX = [
  "Formas de receber",
  "Catálogo público",
  "Aparelhos",
  "Assinatura",
  "Senha",
  "Seus dados",
];

test.describe("a lista de Configurações no celular (abaixo de 760 px)", () => {
  test("o dono vê as seis linhas em dois grupos com h2, numa lista, sem faixa e sem rolar de lado", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", { size: PHONE });
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Da loja",
      "Da conta",
    ]);
    expect(await rowNames(page)).toEqual(SIX);
    await expect(page.getByRole("list", { name: "Da loja" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Da conta" })).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Da loja" }).getByRole("listitem")
    ).toHaveCount(2);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.locator("[data-tabs-edge]")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    const box = await rows(page).last().boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
      PHONE.height
    );
  });

  for (const name of SIX) {
    test(`${name} abre em um toque a partir da lista, com o voltar visível, e o voltar devolve o foco à linha`, async ({
      page,
    }) => {
      await openSettings(page, "/configuracoes", { size: PHONE });
      const row = page.getByRole("link", { exact: true, name });
      await row.click();
      await expect(voltar(page)).toBeVisible();
      await expect(voltar(page)).toBeFocused();
      await expect(rows(page)).toHaveCount(0);
      expect(page.url()).toContain("aba=");
      await expect(page.getByRole("tablist")).toHaveCount(0);
      await voltar(page).click();
      await expect(rows(page)).toHaveCount(6);
      expect(new URL(page.url()).search).toBe("");
      await expect(row).toBeFocused();
    });
  }

  for (const name of SIX) {
    test(`${name}: o voltar do navegador, na tela da aba, leva à lista com o foco na linha`, async ({
      page,
    }) => {
      await openSettings(page, "/configuracoes", { size: PHONE });
      const row = page.getByRole("link", { exact: true, name });
      await row.click();
      await expect(voltar(page)).toBeFocused();
      await page.goBack();
      await expect(rows(page)).toHaveCount(6);
      await expect(page).toHaveURL(LIST_ADDRESS);
      await expect(row).toBeFocused();
      await page.goForward();
      await expect(voltar(page)).toBeVisible();
      expect(page.url()).toContain("aba=");
    });
  }

  test("voltar, avançar e voltar de novo: a linha de origem tem o foco nas duas voltas", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", { size: PHONE });
    const row = page.getByRole("link", { exact: true, name: "Assinatura" });
    await row.click();
    await page.goBack();
    await expect(row).toBeFocused();
    await page.goForward();
    await expect(voltar(page)).toBeVisible();
    await page.goBack();
    await expect(rows(page)).toHaveCount(6);
    await expect(row).toBeFocused();
  });

  test("recarregar a tela de uma aba aberta por uma linha e voltar leva à lista com o foco na linha", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", { size: PHONE });
    const row = page.getByRole("link", { exact: true, name: "Assinatura" });
    await row.click();
    await expect(voltar(page)).toBeVisible();
    await page.reload();
    await expect(voltar(page)).toBeVisible();
    await page.goBack();
    await expect(rows(page)).toHaveCount(6);
    await expect(page).toHaveURL(LIST_ADDRESS);
    await expect(row).toBeFocused();
  });

  test("o Voltar da tela gasta um passo só: depois dele o voltar do navegador sai de Configurações", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", { size: PHONE });
    await page.goto("/health");
    await page.goto("/configuracoes");
    await expect(rows(page)).toHaveCount(6);
    await page.getByRole("link", { exact: true, name: "Senha" }).click();
    await voltar(page).click();
    await expect(rows(page)).toHaveCount(6);
    await expect(page).toHaveURL(LIST_ADDRESS);
    await page.goBack();
    await expect(page).toHaveURL(HEALTH_ADDRESS);
  });

  test("uma aba aberta direto pelo endereço não tem lista antes: o voltar do navegador sai de Configurações", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes?aba=senha", { size: PHONE });
    await page.goto("/health");
    await page.goto("/configuracoes?aba=senha");
    await expect(voltar(page)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(HEALTH_ADDRESS);
  });

  test("uma aba aberta direto pelo endereço: o Voltar da tela abre a lista no lugar, sem gastar o passo anterior", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes?aba=senha", { size: PHONE });
    await page.goto("/health");
    await page.goto("/configuracoes?aba=senha");
    await voltar(page).click();
    await expect(rows(page)).toHaveCount(6);
    await expect(page).toHaveURL(LIST_ADDRESS);
    await expect(
      page.getByRole("link", { exact: true, name: "Senha" })
    ).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(HEALTH_ADDRESS);
  });

  for (const [address, name] of [
    ["/configuracoes?aba=formas-de-receber", "Formas de receber"],
    ["/configuracoes?aba=catalogo-publico", "Catálogo público"],
    ["/configuracoes?aba=assinatura", "Assinatura"],
    ["/configuracoes?aba=senha", "Senha"],
    ["/configuracoes?aba=seus-dados", "Seus dados"],
    ["/subscription", "Assinatura"],
    ["/public-catalog", "Catálogo público"],
    ["/payment-profiles", "Formas de receber"],
  ] as const) {
    test(`${address} abre a aba ${name} com o voltar à lista`, async ({
      page,
    }) => {
      await openSettings(page, address, { size: PHONE });
      await expect(voltar(page)).toBeVisible();
      await expect(rows(page)).toHaveCount(0);
      await expect(page.getByRole("heading", { name })).toBeVisible();
      await voltar(page).click();
      await expect(rows(page)).toHaveCount(6);
    });
  }

  test("uma aba que o endereço não conhece abre a lista, sem trocar o endereço por outra aba", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes?aba=nenhuma", { size: PHONE });
    await expect(rows(page)).toHaveCount(6);
    expect(page.url()).toContain("aba=nenhuma");
  });

  test("o que foi digitado numa tela não se perde ao voltar à lista e abrir outra", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", { size: PHONE });
    await page
      .getByRole("link", { exact: true, name: "Formas de receber" })
      .click();
    await page.getByRole("button", { name: "Novo perfil" }).click();
    await page.getByLabel("Nome do perfil").fill("Maquininha nova");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await voltar(page).click();
    await page
      .getByRole("link", { exact: true, name: "Catálogo público" })
      .click();
    await voltar(page).click();
    await page
      .getByRole("link", { exact: true, name: "Formas de receber" })
      .click();
    await page.getByRole("button", { name: "Novo perfil" }).click();
    await expect(page.getByLabel("Nome do perfil")).toHaveValue(
      "Maquininha nova"
    );
  });

  test("quem vê o quê não muda: sem capacidade e com a senha desligada, a lista só tem o que a pessoa tem (o runtime offline está ligado neste build, então Aparelhos fica e a linha Da conta não some)", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", {
      billingSelfService: false,
      passwordOn: false,
      role: "staff",
      size: PHONE,
    });
    await expect(rows(page)).toHaveCount(3);
    expect(await rowNames(page)).toEqual([
      "Formas de receber",
      "Catálogo público",
      "Aparelhos",
    ]);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Da loja",
      "Da conta",
    ]);
  });

  test("a lista e uma tela aberta com o voltar não têm violação de axe", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", { size: PHONE });
    expect(await axeFaults(page)).toEqual([]);
    await page
      .getByRole("link", { exact: true, name: "Catálogo público" })
      .click();
    await expect(voltar(page)).toBeVisible();
    expect(await axeFaults(page)).toEqual([]);
  });

  test("o link de uma linha abre em outra aba pelo endereço certo", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", { size: PHONE });
    await expect(
      page.getByRole("link", { exact: true, name: "Senha" })
    ).toHaveAttribute("href", "/configuracoes?aba=senha");
    await expect(
      page.getByRole("link", { exact: true, name: "Formas de receber" })
    ).toHaveAttribute("href", "/configuracoes?aba=formas-de-receber");
  });

  test("Ctrl e clique numa linha não é tomado pela tela: o navegador o trata como link e a lista fica onde está", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", { size: PHONE });
    const prevented = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          document.addEventListener(
            "click",
            (event) => {
              resolve(event.defaultPrevented);
              event.preventDefault();
            },
            { once: true }
          );
          document.querySelector('[data-settings-row="senha"]')?.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              button: 0,
              cancelable: true,
              ctrlKey: true,
            })
          );
        })
    );
    expect(prevented).toBe(false);
    await expect(page).toHaveURL(LIST_ADDRESS);
    await expect(rows(page)).not.toHaveCount(0);
    await expect(voltar(page)).toHaveCount(0);
  });
});

skipOutsideChromium();

for (const fontPixels of [20, 24]) {
  reflowTest(
    `a lista de Configurações a 320 px com letra de ${fontPixels} px não corta nada nem rola de lado`,
    async ({ page }) => {
      await openReflowViewport(page, { fontPixels });
      await openSettings(page, "/configuracoes", {
        size: { height: 740, width: 320 },
      });
      await expectReflowFont(page, fontPixels);
      await expect(rows(page)).toHaveCount(6);
      await assertNothingClipped(page.locator("main"));
      await assertNoPageScroll(page);
    }
  );
}
