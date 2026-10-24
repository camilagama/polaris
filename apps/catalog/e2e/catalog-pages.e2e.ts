/// <reference lib="dom" />
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  PRODUCT_WITH_LONG_TEXT,
  PRODUCT_WITH_ONE_PHOTO,
  PRODUCT_WITH_PHOTOS,
  PRODUCT_WITHOUT_PHOTO,
} from "./fixtures/public-catalog-reader";
import { servePhotos } from "./photos";

/**
 * The pages of the public catalog as a visitor uses them (v5.1), on the Worker built over fixture stores:
 * no sideways scroll at 360 and 1280 px, a visible focus, the keyboard, the WhatsApp button, the text of a
 * variant without a price and the footer. The CSP side of the same pages is in csp.e2e.ts.
 */
const FIXTURE = "http://127.0.0.1:5176";
const LONG_NAME = "N".repeat(300);
const WA_ME = /wa\.me/;
const CARD = /card/;
const PRICE_IN_TEXT = /49,90|49\.90|R\$/;
const STORE = `${FIXTURE}/loja-horizonte`;
const PRODUCT = `${STORE}/p/${PRODUCT_WITH_PHOTOS}`;
const SIZES = [
  { height: 740, width: 360 },
  { height: 800, width: 1280 },
] as const;
const PAGES = [
  ["a loja", STORE],
  ["a loja sem contato", `${FIXTURE}/sem-contato`],
  ["a loja vazia", `${FIXTURE}/vazia`],
  ["a loja com nome e descrição no limite", `${FIXTURE}/nome-longo`],
  [
    "o produto de loja com nome longo, nome de 300 letras sem espaço e rótulo de 60",
    `${FIXTURE}/nome-longo/p/${PRODUCT_WITH_LONG_TEXT}`,
  ],
  ["o produto com fotos", PRODUCT],
  [
    "o produto com uma foto e nome longo",
    `${STORE}/p/${PRODUCT_WITH_ONE_PHOTO}`,
  ],
  ["o produto sem foto", `${STORE}/p/${PRODUCT_WITHOUT_PHOTO}`],
  ["a raiz", `${FIXTURE}/`],
  ["a página não encontrada", `${FIXTURE}/nao-existe`],
] as const;

async function open(page: Page, url: string) {
  await servePhotos(page);
  await page.goto(url);
  await page.waitForFunction(() => !("$_TSR" in self));
  await expect(page.locator("main.page h1")).toBeVisible();
}

/** Whether the pointer hits the element 21 px above, below, left and right of its center: a touch area of 44 px. */
async function hasTouchArea(page: Page, selector: string) {
  return await page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element) {
      return false;
    }
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return [
      [x, y - 21],
      [x, y + 21],
      [x - 21, y],
      [x + 21, y],
    ].every(([pointX, pointY]) => {
      const hit = document.elementFromPoint(pointX ?? 0, pointY ?? 0);
      return hit === element || element.contains(hit);
    });
  }, selector);
}

for (const size of SIZES) {
  test.describe(`a ${size.width} px`, () => {
    test.use({ viewport: size });

    for (const [name, url] of PAGES) {
      test(`${name} não rola de lado e mostra o rodapé do Polaris`, async ({
        page,
      }) => {
        await open(page, url);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        );
        expect(overflow).toBeLessThanOrEqual(0);
        await expect(page.locator("footer.foot")).toContainText(
          "Catálogo feito com Polaris"
        );
        const link = page.locator("footer.foot a");
        await expect(link).toHaveAttribute("href", "https://polaris.example/");
        await expect(link).toHaveAttribute("rel", "noopener noreferrer");
        await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
      });
    }

    test("o foco aparece e o teclado percorre a loja até o produto", async ({
      page,
    }) => {
      await open(page, STORE);
      await page.keyboard.press("Tab");
      const focused = page.locator(":focus");
      await expect(focused).toHaveAttribute("href", WA_ME);
      const outline = await focused.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          style: style.outlineStyle,
          width: Number.parseFloat(style.outlineWidth),
        };
      });
      expect(outline.style).not.toBe("none");
      expect(outline.width).toBeGreaterThanOrEqual(3);
      await page.keyboard.press("Tab"); // Instagram
      await page.keyboard.press("Tab"); // the first card
      await expect(page.locator(":focus")).toHaveClass(CARD);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/p/${PRODUCT_WITH_PHOTOS}$`));
      await expect(page.locator("h1")).toHaveText("Camiseta básica");
    });

    test("o botão do WhatsApp do produto leva o nome e o endereço, e tem 44 px de toque", async ({
      page,
    }) => {
      await open(page, PRODUCT);
      const button = page.getByRole("link", { name: "Perguntar no WhatsApp" });
      await expect(button).toHaveAttribute("target", "_blank");
      await expect(button).toHaveAttribute("rel", "noopener noreferrer");
      const href = (await button.getAttribute("href")) ?? "";
      const url = new URL(href);
      expect(url.origin + url.pathname).toBe("https://wa.me/5511000000000");
      const text = url.searchParams.get("text") ?? "";
      expect(text).toContain("Camiseta básica");
      expect(text).toContain(
        `http://127.0.0.1:5176/loja-horizonte/p/${PRODUCT_WITH_PHOTOS}`
      );
      expect(text).not.toMatch(PRICE_IN_TEXT);
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
      // the touch area (the ::before of the button) reaches 44 px even where the button is 36
      expect(await hasTouchArea(page, "a.btn[target=_blank]")).toBe(true);
    });

    test("o nome de 300 letras sem espaço fica em 3 linhas na grade e inteiro no DOM", async ({
      page,
    }) => {
      await open(page, STORE);
      const names = page.locator(".card-name");
      const long = names.filter({ hasText: LONG_NAME });
      await expect(long).toHaveText(LONG_NAME);
      const lineHeight = await long.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).lineHeight)
      );
      const cardHeight = async (name: Locator) =>
        (await name.locator("xpath=ancestor::a[1]").boundingBox())?.height ?? 0;
      const short = names.filter({ hasText: "Camiseta básica" });
      // a card with a short name (1 line) and 2 more lines of name is the most any name may take
      const limit = (await cardHeight(short)) + 2 * lineHeight;
      expect(await cardHeight(long)).toBeLessThanOrEqual(limit + 1);
      expect(
        await long.evaluate((element) => element.clientHeight)
      ).toBeLessThanOrEqual(3 * lineHeight + 1);
    });

    test("na página do produto o título de 300 letras continua inteiro", async ({
      page,
    }) => {
      await open(page, `${FIXTURE}/nome-longo/p/${PRODUCT_WITH_LONG_TEXT}`);
      await expect(page.locator("main h1")).toHaveText(LONG_NAME);
    });

    test("o rodapé tem área de toque de 44 px", async ({ page }) => {
      await open(page, `${FIXTURE}/`);
      expect(await hasTouchArea(page, "footer.foot a")).toBe(true);
    });

    test("a variante sem preço diz 'Preço sob consulta' e a loja sem contato, 'Preço não informado'", async ({
      page,
    }) => {
      await open(page, PRODUCT);
      await expect(page.locator(".variants .unknown")).toHaveText(
        "Preço sob consulta"
      );
      await expect(page.locator(".variants .price").first()).toHaveText(
        "R$49,90"
      );
      await expect(page.locator(".variants")).not.toContainText("0,00");

      await open(page, `${FIXTURE}/sem-contato`);
      await expect(
        page.locator(".card-price", { hasText: "Preço não informado" })
      ).toHaveCount(1);
    });

    test("o produto de loja sem contato não mostra botão nem espaço do WhatsApp", async ({
      page,
    }) => {
      await open(page, `${FIXTURE}/sem-contato/p/${PRODUCT_WITH_PHOTOS}`);
      await expect(
        page.getByRole("link", { name: "Perguntar no WhatsApp" })
      ).toHaveCount(0);
      await expect(page.locator(".contacts")).toHaveCount(0);
      await expect(page.locator(".variants .unknown")).toHaveText(
        "Preço não informado"
      );
    });
  });
}

test("o endereço do site do Polaris não aparece em outra resposta", async ({
  request,
}) => {
  const paths = [
    "/robots.txt",
    "/loja-horizonte/m/a/b",
    "/loja-horizonte/m/x/y?s=320",
  ];
  const answers = await Promise.all(
    paths.map(async (path) => {
      const response = await request.get(`${FIXTURE}${path}`);
      return {
        body: await response.text(),
        headers: Object.values(response.headers()),
        path,
      };
    })
  );
  for (const { body, headers, path } of answers) {
    expect(body, path).not.toContain("polaris.example");
    for (const value of headers) {
      expect(value, path).not.toContain("polaris.example");
    }
  }
});

test("o catálogo nunca define cookie, em nenhuma rota pública", async ({
  request,
}) => {
  // catalogo.araute.app é irmão do web em araute.app e serve conteúdo vindo das lojas (ADR 0097)
  const paths = [
    "/",
    "/robots.txt",
    "/loja-horizonte",
    `/loja-horizonte/p/${PRODUCT_WITH_PHOTOS}`,
    "/loja-horizonte/p/inexistente",
    "/loja-horizonte/m/a/b",
    "/nao-existe",
  ];
  for (const path of paths) {
    // biome-ignore lint/performance/noAwaitInLoops: one path at a time, for a readable failure
    const response = await request.get(`${FIXTURE}${path}`, {
      maxRedirects: 0,
    });
    const cookies = response
      .headersArray()
      .filter(({ name }) => name.toLowerCase() === "set-cookie");
    expect(cookies, path).toEqual([]);
  }
});
