/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { axeFaults } from "../e2e-pwa/ui-guardrails";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * The tabs of Configurações in two named rows from 760 px: "Da loja" and "Da conta". What a person sees does not
 * change (a row with no tab to show is not drawn, nor its name), the addresses open the same tab, and below 760 px the
 * strip is the one that scrolls, as before.
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

test("abaixo de 760 px a faixa é uma só e rola, como antes, sem nomes de linha", async ({
  page,
}) => {
  await openSettings(page, "/configuracoes", {
    size: { height: 740, width: 359 },
  });
  await expect(page.locator("[data-tabs-group]")).toHaveCount(0);
  expect(await tabNames(page)).toEqual([
    "Formas de receber",
    "Catálogo público",
    "Aparelhos",
    "Assinatura",
    "Senha",
    "Seus dados",
  ]);
  await page.setViewportSize({ height: 800, width: 760 });
  await expect(page.locator("[data-tabs-group]")).toHaveCount(2);
  await page.setViewportSize({ height: 800, width: 759 });
  await expect(page.locator("[data-tabs-group]")).toHaveCount(0);
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

  const onWidth = async (width: number, rows: number) => {
    await page.setViewportSize({ height: 800, width });
    await expect(page.locator("[data-tabs-group]")).toHaveCount(rows);
    await expect(tab(page, "Catálogo público")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(page.url()).toContain("aba=catalogo-publico");
  };
  await onWidth(400, 0);
  await onWidth(1280, 2);

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
