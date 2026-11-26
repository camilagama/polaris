/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { axeFaults } from "../e2e-pwa/ui-guardrails/measures";
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
 * Configurações da loja: one strip of tabs from 760 px (Formas de receber, Catálogo público, and Assinatura and Seus
 * dados by condition), with no group names; below 760 px no strip, a list of the same rows with no group titles, each
 * opening its tab, with a way back to the list. Senha and Aparelhos are Minha conta: their old addresses end there.
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
const AT_ACCOUNT = /\/conta$/;
const AT_ACCOUNT_DEVICES = /\/conta\?aba=aparelhos$/;
const ACCOUNT_WITH_QUERY = /\/conta\?(x=1&aba=aparelhos|aba=aparelhos&x=1)$/;
const TITLE = "Configurações da loja";
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

async function serveSettings(
  page: Page,
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
}

async function openSettings(page: Page, path: string, options: Options = {}) {
  const { size = { height: 800, width: 1280 } } = options;
  await serveSettings(page, options);
  await page.goto(path);
  if (size.width < PHONE_WIDTH) {
    await expect(
      page.getByRole("heading", { level: 1, name: TITLE })
    ).toBeVisible();
    return;
  }
  await expect(page.getByRole("tablist", { name: TITLE })).toBeVisible();
}

const list = (page: Page) => page.getByRole("tablist", { name: TITLE });
const tab = (page: Page, name: string) =>
  list(page).getByRole("tab", { exact: true, name });
const GROUP_LABEL = /^(Da loja|Da conta)$/;
const GROUP_LABEL_IN_TREE = /Da loja|Da conta/;

const voltar = (page: Page) =>
  page.getByRole("link", { name: "Voltar para Configurações" });
const rows = (page: Page) => page.locator("[data-settings-row]");

async function rowNames(page: Page) {
  return await rows(page).allTextContents();
}

async function tabNames(page: Page) {
  return await list(page).getByRole("tab").allTextContents();
}

test("o dono vê uma faixa só, sem nomes de grupo, na ordem de antes e sem Senha nem Aparelhos", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes");
  expect(await tabNames(page)).toEqual([
    "Formas de receber",
    "Catálogo público",
    "Assinatura",
    "Seus dados",
  ]);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE);
  await expect(page.locator("[data-tabs-group]")).toHaveCount(0);
  await expect(list(page).locator("[role=none]")).toHaveCount(0);
  await expect(page.getByText(GROUP_LABEL)).toHaveCount(0);
  const boxes = await Promise.all(
    ["Formas de receber", "Catálogo público", "Assinatura", "Seus dados"].map(
      (name) => tab(page, name).boundingBox()
    )
  );
  const tops = new Set(boxes.map((box) => Math.round(box?.y ?? -1)));
  expect(tops.size).toBe(1);
});

test("sem capacidade e sem autosserviço a faixa só tem Formas de receber e Catálogo público", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes", {
    billingSelfService: false,
    passwordOn: false,
    role: "staff",
  });
  expect(await tabNames(page)).toEqual([
    "Formas de receber",
    "Catálogo público",
  ]);
});

test("as capacidades escondem o que escondiam: Assinatura só com billing:manage e autosserviço, Seus dados só com organization:export; a senha ligada não põe Senha aqui", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes", {
    billingSelfService: false,
    passwordOn: true,
  });
  expect(await tabNames(page)).toEqual([
    "Formas de receber",
    "Catálogo público",
    "Seus dados",
  ]);
});

for (const [address, name] of [
  ["/configuracoes", "Formas de receber"],
  ["/configuracoes?aba=catalogo-publico", "Catálogo público"],
  ["/configuracoes?aba=assinatura", "Assinatura"],
  ["/configuracoes?aba=seus-dados", "Seus dados"],
  ["/subscription", "Assinatura"],
  ["/public-catalog", "Catálogo público"],
  ["/payment-profiles", "Formas de receber"],
] as const) {
  test(`${address} abre a aba ${name}, na faixa`, async ({ page }) => {
    await openSettings(page, address);
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-tabs-group]")).toHaveCount(0);
  });
}

for (const [address, final] of [
  ["/configuracoes?aba=senha", AT_ACCOUNT],
  ["/configuracoes?aba=aparelhos", AT_ACCOUNT_DEVICES],
  ["/devices", AT_ACCOUNT_DEVICES],
  ["/conta/seguranca", AT_ACCOUNT],
] as const) {
  for (const [where, size] of [
    ["1280 px", { height: 800, width: 1280 }],
    ["360 px", PHONE],
  ] as const) {
    test(`${address} a ${where} termina em Minha conta`, async ({ page }) => {
      await serveSettings(page, { size });
      await page.goto(address);
      await expect(page).toHaveURL(final);
      await expect(
        page.getByRole("heading", { level: 1, name: "Minha conta" })
      ).toBeVisible();
    });
  }
}

test("o resto da consulta vai junto quando Senha ou Aparelhos mudam de tela", async ({
  page,
}) => {
  await serveSettings(page);
  await page.goto("/configuracoes?aba=aparelhos&x=1");
  await expect(page).toHaveURL(ACCOUNT_WITH_QUERY);
});

for (const retorno of ["concluida", "cancelada", "expirada"]) {
  test(`?aba=assinatura&retorno=${retorno} fica em Configurações da loja, na Assinatura`, async ({
    page,
  }) => {
    await openSettings(
      page,
      `/configuracoes?aba=assinatura&retorno=${retorno}`
    );
    await expect(tab(page, "Assinatura")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(new URL(page.url()).pathname).toBe("/configuracoes");
    expect(page.url()).toContain(`retorno=${retorno}`);
  });
}

test("as setas andam pela faixa toda e Enter abre", async ({ page }) => {
  await openSettings(page, "/configuracoes?aba=catalogo-publico");
  await tab(page, "Catálogo público").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Assinatura")).toBeFocused();
  await expect(tab(page, "Assinatura")).toHaveAttribute("tabindex", "0");
  await expect(tab(page, "Catálogo público")).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Enter");
  await expect(tab(page, "Assinatura")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Catálogo público")).toBeFocused();
});

for (const width of [760, 1280]) {
  test(`a faixa de abas não tem violação de axe a ${width} px, e só rola de lado com a sombra que avisa`, async ({
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
    if (width >= 1280) {
      expect(sideways).toBe(false);
    }
    await expect(page.locator('[data-tabs-edge="end"]')).toHaveCount(
      sideways ? 1 : 0
    );
  });
}

test("abaixo de 760 px não há faixa: há a lista, e a 760 px volta a faixa", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes", { size: PHONE });
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Seus dados" })).toBeVisible();
  await page.setViewportSize({ height: 800, width: 760 });
  await expect(list(page)).toBeVisible();
  await expect(tab(page, "Formas de receber")).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.setViewportSize({ height: 800, width: 759 });
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Seus dados" })).toBeVisible();
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
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(voltar(page)).toBeVisible();
  expect(page.url()).toContain("aba=catalogo-publico");
  await page.setViewportSize({ height: 800, width: 1280 });
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

test("a página tem um título só, uma faixa só e nenhum título de grupo", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE);
  await expect(page.getByRole("tablist")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: GROUP_LABEL })).toHaveCount(0);
  const tree = await list(page).ariaSnapshot();
  expect(tree).not.toMatch(GROUP_LABEL_IN_TREE);
});

const FOUR = [
  "Formas de receber",
  "Catálogo público",
  "Assinatura",
  "Seus dados",
];

test.describe("a lista de Configurações no celular (abaixo de 760 px)", () => {
  test("o dono vê as quatro linhas numa lista só, sem títulos de grupo, sem faixa e sem rolar de lado", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", { size: PHONE });
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
    expect(await rowNames(page)).toEqual(FOUR);
    await expect(page.getByRole("list")).toHaveCount(1);
    await expect(page.getByRole("list", { name: TITLE })).toBeVisible();
    await expect(
      page.getByRole("list", { name: TITLE }).getByRole("listitem")
    ).toHaveCount(4);
    await expect(page.getByText(GROUP_LABEL)).toHaveCount(0);
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

  for (const name of FOUR) {
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
      await expect(rows(page)).toHaveCount(4);
      expect(new URL(page.url()).search).toBe("");
      await expect(row).toBeFocused();
    });
  }

  for (const name of FOUR) {
    test(`${name}: o voltar do navegador, na tela da aba, leva à lista com o foco na linha`, async ({
      page,
    }) => {
      await openSettings(page, "/configuracoes", { size: PHONE });
      const row = page.getByRole("link", { exact: true, name });
      await row.click();
      await expect(voltar(page)).toBeFocused();
      await page.goBack();
      await expect(rows(page)).toHaveCount(4);
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
    await expect(rows(page)).toHaveCount(4);
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
    await expect(rows(page)).toHaveCount(4);
    await expect(page).toHaveURL(LIST_ADDRESS);
    await expect(row).toBeFocused();
  });

  test("o Voltar da tela gasta um passo só: depois dele o voltar do navegador sai de Configurações", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", { size: PHONE });
    await page.goto("/health");
    await page.goto("/configuracoes");
    await expect(rows(page)).toHaveCount(4);
    await page.getByRole("link", { exact: true, name: "Seus dados" }).click();
    await voltar(page).click();
    await expect(rows(page)).toHaveCount(4);
    await expect(page).toHaveURL(LIST_ADDRESS);
    await page.goBack();
    await expect(page).toHaveURL(HEALTH_ADDRESS);
  });

  test("uma aba aberta direto pelo endereço não tem lista antes: o voltar do navegador sai de Configurações", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes?aba=seus-dados", { size: PHONE });
    await page.goto("/health");
    await page.goto("/configuracoes?aba=seus-dados");
    await expect(voltar(page)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(HEALTH_ADDRESS);
  });

  test("uma aba aberta direto pelo endereço: o Voltar da tela abre a lista no lugar, sem gastar o passo anterior", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes?aba=seus-dados", { size: PHONE });
    await page.goto("/health");
    await page.goto("/configuracoes?aba=seus-dados");
    await voltar(page).click();
    await expect(rows(page)).toHaveCount(4);
    await expect(page).toHaveURL(LIST_ADDRESS);
    await expect(
      page.getByRole("link", { exact: true, name: "Seus dados" })
    ).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(HEALTH_ADDRESS);
  });

  for (const [address, name] of [
    ["/configuracoes?aba=formas-de-receber", "Formas de receber"],
    ["/configuracoes?aba=catalogo-publico", "Catálogo público"],
    ["/configuracoes?aba=assinatura", "Assinatura"],
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
      await expect(rows(page)).toHaveCount(4);
    });
  }

  test("uma aba que o endereço não conhece abre a lista, sem trocar o endereço por outra aba", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes?aba=nenhuma", { size: PHONE });
    await expect(rows(page)).toHaveCount(4);
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

  test("quem vê o quê não muda: sem capacidade, a lista só tem o que a pessoa tem", async ({
    page,
  }) => {
    await openSettings(page, "/configuracoes", {
      billingSelfService: false,
      passwordOn: false,
      role: "staff",
      size: PHONE,
    });
    await expect(rows(page)).toHaveCount(2);
    expect(await rowNames(page)).toEqual([
      "Formas de receber",
      "Catálogo público",
    ]);
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
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
      page.getByRole("link", { exact: true, name: "Seus dados" })
    ).toHaveAttribute("href", "/configuracoes?aba=seus-dados");
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
          document
            .querySelector('[data-settings-row="seus-dados"]')
            ?.dispatchEvent(
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
    `a lista de Configurações da loja a 320 px com letra de ${fontPixels} px não corta nada nem rola de lado`,
    async ({ page }) => {
      await openReflowViewport(page, { fontPixels });
      await openSettings(page, "/configuracoes", {
        size: { height: 740, width: 320 },
      });
      await expectReflowFont(page, fontPixels);
      await expect(rows(page)).toHaveCount(4);
      await assertNothingClipped(page.locator("main"));
      await assertNoPageScroll(page);
    }
  );
}
