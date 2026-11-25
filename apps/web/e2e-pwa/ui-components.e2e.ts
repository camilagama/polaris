/// <reference lib="dom" />
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { watchCspViolations } from "../e2e/csp-fixture";
import { axeViolations } from "./ui-guardrails/measures";

/**
 * The components the sale uses (ADR 0103, section 8, item 3), in the gallery: each one is found by its role and
 * its label, as the e2e of the sale will find it, and axe finds no violation on the page in each theme. The
 * gallery is served by the static server under the CSP of the build's `_headers`; axe is evaluated through the
 * test channel, not as a script of the page, and the CSP watch stays empty.
 */
const THEMES = [
  { colorScheme: "light", name: "claro", stored: "claro" },
  { colorScheme: "light", name: "escuro", stored: "escuro" },
  { colorScheme: "dark", name: "sistema escuro", stored: null },
] as const;

// the browser resolves `oklch(… / 50%)` to a color with an alpha of 0.5
const HALF_STRENGTH = /\/ 0\.5\)$/;
const ANTICIPATION_HELP = /^É uma intenção registrada na venda/;
const TIPS_HELP = /^Até 3 e-mails nos primeiros 14 dias de uma loja nova\./;

async function openGallery(page: Page, stored: string | null) {
  if (stored) {
    await page.addInitScript((theme) => {
      window.localStorage.setItem("polaris-tema", theme);
    }, stored);
  }
  await page.goto("/ui-galeria");
  await expect(
    page.getByRole("heading", { name: "Galeria da interface" })
  ).toBeVisible();
  // Geist must be in before axe measures contrast and sizes
  await page.evaluate(() => document.fonts.ready);
}

/** The box of a control grown by its touch pseudo-element (the larger of ::before and ::after), in pixels. */
const touchArea = (element: Element) => {
  const box = element.getBoundingClientRect();
  // the touch area is the larger of the two pseudo-elements, resolved to pixels by the browser
  const sizes = (["::before", "::after"] as const).map((pseudo) => {
    const style = getComputedStyle(element, pseudo);
    if (style.content === "none" || style.position !== "absolute") {
      return { height: 0, width: 0 };
    }
    const px = (value: string) => Number.parseFloat(value) || 0;
    return {
      height: box.height - px(style.top) - px(style.bottom),
      width: box.width - px(style.left) - px(style.right),
    };
  });
  return {
    height: Math.max(box.height, ...sizes.map((size) => size.height)),
    width: Math.max(box.width, ...sizes.map((size) => size.width)),
  };
};

test("os componentes da venda têm papel e rótulo", async ({ page }) => {
  await openGallery(page, null);
  const sale = page.getByRole("region", { name: "Componentes da venda" });

  // Badge: text, never only color
  await expect(sale.getByText("Sincronizado", { exact: true })).toBeVisible();
  await expect(sale.getByText("Offline · 3")).toBeVisible();

  // Alert: only the error interrupts (alert); the warning and the information are a polite status
  await expect(
    sale
      .getByRole("alert")
      .filter({ hasText: "Não deu para carregar os perfis." })
  ).toBeVisible();
  await expect(
    sale.getByRole("status").filter({ hasText: "Sem internet." })
  ).toBeVisible();
  await expect(
    sale
      .getByRole("status")
      .filter({ hasText: "Esta venda ainda não foi enviada." })
  ).toBeVisible();

  // The profile hint is a field description tied to the select, not an alert
  await expect(
    sale.getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
  ).toHaveAccessibleDescription(
    "Sem perfil, taxas e prazo ficam como estimativa."
  );

  await expect(
    sale.getByRole("status").filter({ hasText: "Sem perfil, taxas e prazo" })
  ).toHaveCount(0);

  // Card: its title is the heading the screen gives it
  await expect(
    sale.getByRole("heading", { level: 3, name: "Itens" })
  ).toBeVisible();
  await expect(
    sale.getByRole("heading", { level: 3, name: "Pagamento" })
  ).toBeVisible();

  // ButtonGroup: − field +, a named group; the field keeps its own label
  const stepper = sale.getByRole("group", { name: "Quantidade" });
  await expect(
    stepper.getByRole("button", { name: "Diminuir a quantidade" })
  ).toBeVisible();
  await expect(
    stepper.getByRole("button", { name: "Aumentar a quantidade" })
  ).toBeVisible();
  await expect(sale.getByRole("textbox", { name: "Quantidade" })).toHaveValue(
    "2"
  );

  // Field + InputGroup with the "R$" addon: label, description, and a click on "R$" focuses the field
  const price = sale.getByRole("textbox", { name: "Preço cobrado" });
  await expect(price).toHaveAccessibleDescription(
    "Tabela: R$ 50,00 por unidade"
  );
  // the addon lets the pointer through (pointer-events: none), so the click goes to where the person taps
  await price.scrollIntoViewIfNeeded();
  const addon = await sale
    .getByText("R$", { exact: true })
    .first()
    .boundingBox();
  expect(addon).not.toBeNull();
  if (addon) {
    await page.mouse.click(
      addon.x + addon.width / 2,
      addon.y + addon.height / 2
    );
  }
  await expect(price).toBeFocused();

  // FieldError: invalid field, error announced and tied to the field
  const empty = sale.getByRole("textbox", { name: "Preço do segundo item" });
  await expect(empty).toHaveAttribute("aria-invalid", "true");
  await expect(empty).toHaveAccessibleDescription(
    "Informe um preço maior que zero."
  );
  await expect(
    sale
      .getByRole("alert")
      .filter({ hasText: "Informe um preço maior que zero." })
  ).toBeVisible();

  // RadioGroup of choice cards inside a FieldSet: the legend names the group, each card names its radio
  const methods = sale.getByRole("radiogroup", {
    name: "Forma de pagamento",
  });
  await expect(
    sale.getByRole("group", { name: "Forma de pagamento" })
  ).toBeVisible();
  await expect(methods.getByRole("radio")).toHaveCount(6);
  await expect(methods.getByRole("radio", { name: "Pix" })).toBeChecked();
  await sale.getByText("Dinheiro", { exact: true }).click();
  await expect(methods.getByRole("radio", { name: "Dinheiro" })).toBeChecked();
  await expect(methods.getByRole("radio", { name: "Pix" })).not.toBeChecked();
  await page.keyboard.press("ArrowRight");
  const credit = methods.getByRole("radio", { name: "Crédito" });
  await expect(credit).toBeFocused();
  // inside a choice card the card draws the focus outline: the radio adds no 3 px halo of its own
  expect(
    await credit.evaluate((radio) => ({
      card: getComputedStyle(radio.closest("label") as Element).outlineWidth,
      halo: getComputedStyle(radio).boxShadow,
    }))
  ).toEqual({ card: "3px", halo: expect.not.stringContaining("3px") });

  // Checkbox: named by its label, described by its help, toggled by the label
  const anticipation = sale.getByRole("checkbox", {
    name: "Pretendo antecipar este recebimento",
  });
  await expect(anticipation).toHaveAccessibleDescription(ANTICIPATION_HELP);
  await expect(anticipation).not.toBeChecked();
  await sale.getByText("Pretendo antecipar este recebimento").click();
  await expect(anticipation).toBeChecked();
  await anticipation.press("Space");
  await expect(anticipation).not.toBeChecked();

  // Switch: named by its label, described by its help, starts on, toggled by Space
  const tips = sale.getByRole("switch", { name: "Dicas para começar" });
  await expect(tips).toHaveAccessibleDescription(TIPS_HELP);
  await expect(tips).toBeChecked();
  await tips.press("Space");
  await expect(tips).not.toBeChecked();
  await tips.press("Space");
  await expect(tips).toBeChecked();

  // Separator
  await expect(sale.getByRole("separator")).toHaveCount(4);
});

for (const theme of THEMES) {
  test(`tema ${theme.name}: axe não acha violação de WCAG 2.2 AA na galeria`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      colorScheme: theme.colorScheme,
    });
    const page = await context.newPage();
    const csp = await watchCspViolations(page);
    await openGallery(page, theme.stored);
    expect(await axeViolations(page)).toEqual([]);
    expect(csp.violations()).toEqual([]);
    await context.close();
  });
}

test("com toque, radio, caixa de seleção, botões do contador e campo com R$ têm área de 44 px", async ({
  isMobile,
  page,
}) => {
  test.skip(
    !isMobile,
    "the touch area exists only with touch (pointer: coarse or under 760 px)"
  );
  await openGallery(page, null);
  const sale = page.getByRole("region", { name: "Componentes da venda" });
  const targets = [
    sale.getByRole("radio", { name: "Pix" }),
    sale.getByRole("checkbox", { name: "Pretendo antecipar este recebimento" }),
    sale.getByRole("button", { name: "Diminuir a quantidade" }),
    sale.getByRole("button", { name: "Aumentar a quantidade" }),
    sale.locator("[data-slot=input-group]").filter({ hasText: "R$" }).first(),
  ];
  const areas = await Promise.all(
    targets.map((target) => target.evaluate(touchArea))
  );
  for (const area of areas) {
    expect(area.height).toBeGreaterThanOrEqual(44);
    expect(area.width).toBeGreaterThanOrEqual(44);
  }
});

test("tamanho por papel: comum 32/36, ação principal 36/44, grupo de 24 px a 8 px um do outro, campo 32/44", async ({
  isMobile,
  page,
}) => {
  await openGallery(page, null);
  const roles = page.getByRole("region", { name: "Tamanho por papel" });
  const boxOf = async (locator: Locator) => {
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error("o controle não tem caixa");
    }
    return box;
  };
  const common = await boxOf(roles.getByRole("button", { name: "Cancelar" }));
  expect(common.height).toBeCloseTo(isMobile ? 36 : 32, 1);
  const main = await boxOf(roles.getByRole("button", { name: "Nova venda" }));
  expect(main.height).toBeCloseTo(isMobile ? 44 : 36, 1);
  const inGroup = await Promise.all(
    ["Aumentar", "Diminuir", "Confirmar"].map((name) =>
      boxOf(roles.getByRole("button", { exact: true, name }))
    )
  );
  for (const box of inGroup) {
    expect(box.width).toBeCloseTo(24, 1);
    expect(box.height).toBeCloseTo(24, 1);
  }
  const gaps = inGroup.slice(1).map((box, index) => {
    const before = inGroup[index];
    return before ? box.x - (before.x + before.width) : Number.NaN;
  });
  expect(gaps).toHaveLength(2);
  for (const gap of gaps) {
    expect(gap).toBeCloseTo(8, 1);
  }
  // a control of a group has no touch area of its own: the pseudo-element is off
  const pseudo = await roles
    .getByRole("button", { exact: true, name: "Aumentar" })
    .evaluate((element) => getComputedStyle(element, "::before").content);
  expect(pseudo).toBe("none");
  const fields = roles.locator("[data-slot=input-group]");
  expect(await fields.count()).toBe(1);
  expect((await boxOf(fields.nth(0))).height).toBeCloseTo(
    isMobile ? 44 : 32,
    1
  );
});

test("campo de texto e seletor: 32 com mouse e 44 com toque; o grupo de várias linhas não fica preso a essa altura", async ({
  isMobile,
  page,
}) => {
  await openGallery(page, null);
  const sale = page.getByRole("region", { name: "Componentes da venda" });
  const heightOf = async (locator: Locator) => {
    const box = await locator.boundingBox();
    if (!box) {
      throw new Error("o controle não tem caixa");
    }
    return box.height;
  };
  expect(
    await heightOf(
      sale.getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    )
  ).toBeCloseTo(isMobile ? 44 : 32, 1);
  const group = page
    .locator("[data-slot=input-group]")
    .filter({ has: page.getByLabel("Observação (opcional)") });
  expect(await heightOf(group)).toBeGreaterThan(60);
});

test('o nome do seletor é só o rótulo: o ícone do gatilho sai da leitura e não deixa o "▼" no texto', async ({
  page,
}) => {
  await openGallery(page, null);
  const trigger = page.getByRole("combobox", {
    exact: true,
    name: "Método de pagamento",
  });
  await expect(trigger).toHaveAccessibleName("Método de pagamento");
  // the icon is hidden from the screen reader and is no text of the trigger (Base UI would write a "▼" in it)
  await expect(trigger.locator("> span[aria-hidden]")).toHaveAttribute(
    "aria-hidden",
    "true"
  );
  expect(
    await trigger.evaluate((element) => element.textContent)
  ).not.toContain("▼");
});

test("o grupo de rádios marcado como inválido mostra o anel no grupo e a borda nos rádios, sem pintar os cartões", async ({
  page,
}) => {
  await openGallery(page, null);
  const group = page.getByRole("radiogroup", { name: "Forma de pagamento" });
  const read = () =>
    group.evaluate((element) => {
      // the destructive token as the browser resolves it
      const probe = document.createElement("span");
      probe.style.border = "1px solid var(--destructive)";
      document.body.append(probe);
      const destructive = getComputedStyle(probe).borderTopColor;
      probe.remove();
      const radio = element.querySelector("[role=radio]");
      const card = element.querySelector("label");
      if (!(radio && card)) {
        throw new Error("the group has no radio or card");
      }
      return {
        cardBorder: getComputedStyle(card).borderTopColor,
        destructive,
        groupOutlineColor: getComputedStyle(element).outlineColor,
        groupOutlineStyle: getComputedStyle(element).outlineStyle,
        groupOutlineWidth: getComputedStyle(element).outlineWidth,
        radioBorder: getComputedStyle(radio).borderTopColor,
      };
    });
  const valid = await read();
  expect(valid.groupOutlineStyle).toBe("none");
  expect(valid.radioBorder).not.toBe(valid.destructive);

  await group.evaluate((element) =>
    element.setAttribute("aria-invalid", "true")
  );
  // the border of the radio fades to the new color: read it when the transition has ended
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !==
            Number.POSITIVE_INFINITY
        )
        .map((animation) => animation.finished)
    )
  );
  const invalid = await read();
  expect(invalid.groupOutlineStyle).toBe("solid");
  expect(invalid.groupOutlineWidth).toBe("2px");
  // the ring is the destructive token (at half strength): not transparent, not the border color
  expect(invalid.groupOutlineColor).not.toBe(valid.groupOutlineColor);
  expect(invalid.groupOutlineColor).toMatch(HALF_STRENGTH);
  expect(invalid.radioBorder).toBe(invalid.destructive);
  // the cards keep their own border: the message under the group says what is missing, not six red cards
  expect(invalid.cardBorder).toBe(valid.cardBorder);
});

/** The boxes of a frame of the gallery: the frame, its title row and its panel, in pixels. */
async function blockBoxes(page: Page, which: "block" | "reference") {
  return await page
    .locator(`[data-gallery-block="${which}"]`)
    .evaluate((frame) => {
      const box = (element: Element | null) => {
        const { height, width, x, y } = (
          element as Element
        ).getBoundingClientRect();
        return { height, width, x, y };
      };
      const origin = frame.getBoundingClientRect();
      const relative = (element: Element | null) => {
        const found = box(element);
        if (found.width === 0 && found.height === 0) {
          // the foot is `display: none` below 760 px: no box, and the same for both
          return found;
        }
        return {
          height: found.height,
          width: found.width,
          x: found.x - origin.x,
          y: found.y - origin.y,
        };
      };
      return {
        footer: relative(
          frame.querySelector('[data-slot="card-frame-footer"]')
        ),
        frame: { height: origin.height, width: origin.width },
        header: relative(
          frame.querySelector('[data-slot="card-frame-header"]')
        ),
        panel: relative(frame.querySelector('[data-slot="card-frame-panel"]')),
      };
    });
}

for (const size of [
  { height: 800, width: 1280 },
  { height: 740, width: 360 },
]) {
  test(`o Block desenha como o bloco do Início a ${size.width} px: a moldura, o cabeçalho e o painel medem o mesmo`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await openGallery(page, null);
    const reference = await blockBoxes(page, "reference");
    const block = await blockBoxes(page, "block");
    expect(block).toEqual(reference);
    expect(block.panel.height).toBeGreaterThan(0);
    // both are the same frame, so they would also agree on a wrong one: the gap of the panel is pinned too (4 px of
    // frame from 760 px, `md:p-(--frame-gap)`; the 12 px of the plain card below it)
    expect(block.panel.x).toBe(size.width >= 760 ? 4 : 12);
    expect(block.header.x).toBe(size.width >= 760 ? 4 : 12);
  });
}

/** The boxes that tell where a `ListBlock` of the gallery put its parts, in pixels. */
async function listBoxes(page: Page, name: string) {
  return await page
    .getByRole("region", { exact: true, name })
    .evaluate((region) => {
      const rect = (element: Element | null) => {
        const { bottom, height, left, right, top, width } = (
          element as Element
        ).getBoundingClientRect();
        return { bottom, height, left, right, top, width };
      };
      const all = (selector: string) =>
        [...region.querySelectorAll(selector)].map(rect);
      const one = (selector: string) => {
        const found = region.querySelector(selector);
        return found ? rect(found) : null;
      };
      const scroll = region.querySelector("[data-list-block-scroll]");
      return {
        columnHeader: one("[data-list-block-header]"),
        count: one("[data-list-count]"),
        frame: rect(region),
        header: one('[data-slot="card-frame-header"]'),
        headingTag: region.querySelector("h2")?.tagName ?? null,
        panel: rect(scroll),
        rows: all("[data-list-block-row]"),
        scrollable:
          scroll !== null && scroll.scrollWidth > scroll.clientWidth + 1,
        skeletons: region.querySelectorAll(
          "[aria-hidden='true'] .animate-pulse"
        ).length,
        total: one("[data-list-total]"),
      };
    });
}

const LIST_EXAMPLES = [
  { name: "Produtos com total", state: "rows", total: true },
  { name: "Produtos sem total", state: "rows", total: false },
  { name: "Carregando com total", state: "loading", total: true },
  { name: "Carregando sem total", state: "loading", total: false },
  { name: "Busca com total", state: "filtered-empty", total: true },
  { name: "Busca sem total", state: "filtered-empty", total: false },
] as const;

const ANY_VALUE = /.*/;

const LIST_SIZES = [
  { height: 800, width: 1280 },
  { height: 740, width: 360 },
] as const;

for (const size of LIST_SIZES) {
  for (const example of LIST_EXAMPLES) {
    test(`o ListBlock "${example.name}" a ${size.width} px: cabeçalho de coluna primeiro, linhas de borda a borda, total por último`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openGallery(page, null);
      const boxes = await listBoxes(page, example.name);
      const label = `${example.name} a ${size.width} px`;
      expect(boxes.headingTag, label).toBe("H2");
      expect(boxes.columnHeader, label).not.toBeNull();
      // the column header is the first line of the panel
      expect(boxes.columnHeader?.top, label).toBeCloseTo(boxes.panel.top, 0);
      expect(boxes.columnHeader?.left, label).toBeCloseTo(boxes.panel.left, 0);
      expect(boxes.columnHeader?.width, label).toBeCloseTo(
        boxes.panel.width,
        0
      );
      if (example.state === "rows") {
        expect(boxes.rows, label).toHaveLength(3);
        for (const row of boxes.rows) {
          expect(row.left, label).toBeCloseTo(boxes.panel.left, 0);
          expect(row.width, label).toBeCloseTo(boxes.panel.width, 0);
          expect(row.top, label).toBeGreaterThanOrEqual(
            (boxes.columnHeader?.bottom ?? 0) - 0.5
          );
        }
      } else {
        expect(boxes.rows, label).toHaveLength(0);
      }
      if (example.state === "loading") {
        expect(boxes.skeletons, label).toBeGreaterThan(0);
      }
      if (!example.total) {
        expect(boxes.total, label).toBeNull();
        return;
      }
      // the total is the last line: it ends where the panel ends and nothing of the list is below it
      expect(boxes.total, label).not.toBeNull();
      expect(boxes.total?.bottom, label).toBeCloseTo(boxes.panel.bottom, 0);
      expect(boxes.total?.width, label).toBeCloseTo(boxes.panel.width, 0);
      for (const row of boxes.rows) {
        expect(row.bottom, label).toBeLessThanOrEqual(
          (boxes.total?.top ?? 0) + 0.5
        );
      }
      const lastLine = await page
        .getByRole("region", { exact: true, name: example.name })
        .evaluate(
          (region) =>
            region.querySelector("[data-list-total]")?.parentElement
              ?.nextElementSibling === null
        );
      expect(lastLine, label).toBe(true);
    });
  }
}

for (const size of LIST_SIZES) {
  test(`o ListBlock a ${size.width} px: carregando mantém a altura do cabeçalho e a busca sem resultado diz a frase`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await openGallery(page, null);
    const rows = await listBoxes(page, "Produtos com total");
    const loading = await listBoxes(page, "Carregando com total");
    const search = await listBoxes(page, "Busca com total");
    expect(loading.header?.height).toBeCloseTo(rows.header?.height ?? 0, 0);
    expect(loading.count?.height).toBeCloseTo(rows.count?.height ?? 0, 0);
    expect(search.header?.height).toBeCloseTo(rows.header?.height ?? 0, 0);
    const region = page.getByRole("region", {
      exact: true,
      name: "Busca com total",
    });
    await expect(
      region.getByText("Nenhum produto com essa busca.")
    ).toBeVisible();
    await expect(region.locator("[data-list-count]")).toHaveText("0 produtos");
    await expect(
      page
        .getByRole("region", { exact: true, name: "Carregando com total" })
        .getByRole("status")
    ).toHaveText("Carregando…");
    await expect(
      page
        .getByRole("region", { exact: true, name: "Produtos com total" })
        .locator("[data-list-count]")
    ).toHaveAttribute("aria-live", "polite");
  });

  test(`o ListBlock a ${size.width} px: a tabela larga rola por dentro e a moldura e o título ficam parados`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await openGallery(page, null);
    const name = "Tabela larga";
    const before = await listBoxes(page, name);
    expect(before.frame.right).toBeLessThanOrEqual(size.width + 0.5);
    const wide = before.scrollable;
    if (size.width >= 760) {
      // the 40 rem table fits the 1280 px column: nothing to scroll, and nothing cut
      expect(wide).toBe(false);
      await expect(
        page
          .getByRole("region", { exact: true, name })
          .locator("[data-list-block-scroll]")
      ).not.toHaveAttribute("tabindex", ANY_VALUE);
      return;
    }
    expect(wide).toBe(true);
    // wider than the screen, the box is a stop of the keyboard, named by the title, so it scrolls without a pointer
    await expect(
      page
        .getByRole("region", { exact: true, name })
        .getByRole("group", { name })
    ).toHaveAttribute("tabindex", "0");
    await page
      .getByRole("region", { exact: true, name })
      .locator("[data-list-block-scroll]")
      .evaluate((scroll) => {
        scroll.scrollLeft = 120;
      });
    const after = await listBoxes(page, name);
    expect(after.frame.left).toBeCloseTo(before.frame.left, 0);
    expect(after.frame.width).toBeCloseTo(before.frame.width, 0);
    expect(after.header?.left).toBeCloseTo(before.header?.left ?? 0, 0);
    expect(after.columnHeader?.left).toBeCloseTo(
      (before.columnHeader?.left ?? 0) - 120,
      0
    );
  });
}

const HEADER_ACTION_EXAMPLES = [
  ...LIST_EXAMPLES,
  { name: "Tabela larga", state: "rows", total: true },
] as const;

/** Sub-pixel rounding of the layout: the count may touch the action, never overlap it. */
const SIDE_BY_SIDE_TOLERANCE = 0.5;
/** How far the action may stand from the right edge of the header's content box on a phone. */
const RIGHT_EDGE_TOLERANCE = 1;
/** Count and action share a line: their centers differ by rounding only. */
const SAME_LINE_TOLERANCE = 2;

/** Where the count, the action and the content box of a `ListBlock` header are, in pixels: the padding of a phone (`px-3`) is the block header's, not the frame's. */
async function headerActionBoxes(page: Page, name: string) {
  return await page
    .getByRole("region", { exact: true, name })
    .evaluate((region) => {
      const header = region.querySelector('[data-slot="block-header"]');
      const count = region.querySelector("[data-list-count]");
      const action = [...(header?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Exportar"
      );
      if (!(header && count && action)) {
        return null;
      }
      const box = (element: Element) => {
        const { bottom, left, right, top } = element.getBoundingClientRect();
        return { bottom, centerY: (top + bottom) / 2, left, right, top };
      };
      const headerBox = header.getBoundingClientRect();
      return {
        action: box(action),
        contentRight:
          headerBox.right -
          Number.parseFloat(getComputedStyle(header).paddingRight),
        count: box(count),
      };
    });
}

for (const size of LIST_SIZES) {
  for (const example of HEADER_ACTION_EXAMPLES) {
    test(`o ListBlock "${example.name}" a ${size.width} px: a contagem fica à esquerda da ação do cabeçalho e, no celular, a ação encosta à direita`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openGallery(page, null);
      const label = `${example.name} a ${size.width} px`;
      const boxes = await headerActionBoxes(page, example.name);
      expect(boxes, label).not.toBeNull();
      if (!boxes) {
        return;
      }
      expect(boxes.count.right, label).toBeLessThanOrEqual(
        boxes.action.left + SIDE_BY_SIDE_TOLERANCE
      );
      if (size.width >= 760) {
        expect(boxes.action.right, label).toBeLessThanOrEqual(
          boxes.contentRight + RIGHT_EDGE_TOLERANCE
        );
        return;
      }
      expect(
        Math.abs(boxes.action.right - boxes.contentRight),
        label
      ).toBeLessThanOrEqual(RIGHT_EDGE_TOLERANCE);
      if (example.state === "rows") {
        expect(
          Math.abs(boxes.count.centerY - boxes.action.centerY),
          label
        ).toBeLessThanOrEqual(SAME_LINE_TOLERANCE);
      }
    });
  }
}

test("o ListBlock: o título é o único h2 da lista, a contagem não é título e axe não acusa a página", async ({
  page,
}) => {
  await openGallery(page, null);
  const region = page.getByRole("region", {
    exact: true,
    name: "Produtos com total",
  });
  await expect(region.getByRole("heading")).toHaveCount(1);
  await expect(
    region.getByRole("heading", { level: 2, name: "Produtos com total" })
  ).toBeVisible();
  await expect(
    region.getByRole("list", { name: "Produtos com total" })
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

/** The frame and the first line of a `Block variant="plain"` of the gallery. */
test("o Block plain: sem a moldura de fora, com o mesmo cabeçalho do Block", async ({
  page,
}) => {
  await openGallery(page, null);
  const plain = page.getByRole("region", { exact: true, name: "Comprovante" });
  await expect(
    plain.getByRole("heading", { level: 2, name: "Comprovante" })
  ).toBeVisible();
  await expect(plain.locator('[data-slot="card-frame"]')).toHaveCount(0);
  await expect(plain.locator('[data-slot="block-header"]')).toBeVisible();
  const header = await plain
    .locator('[data-slot="block-header"]')
    .evaluate((row) => row.getBoundingClientRect().height);
  expect(header).toBeGreaterThanOrEqual(32);
  await expect(page.getByText("O mesmo bloco sem título.")).toBeVisible();
});

/** The two inner panels, the checkable option and the step tile of the gallery, measured in the browser. */
test("os painéis internos, a opção marcável e a caixa do passo: medidas e clique", async ({
  page,
}) => {
  await openGallery(page, null);
  const inset = page.locator('[data-gallery-panel="inset"]');
  const insetStyle = await inset.evaluate((box) => {
    const style = getComputedStyle(box);
    return {
      border: style.borderTopWidth,
      fill: style.backgroundColor,
      radius: style.borderTopLeftRadius,
    };
  });
  expect(insetStyle.border).toBe("0px");
  expect(insetStyle.fill).not.toBe("rgba(0, 0, 0, 0)");
  expect(Number.parseFloat(insetStyle.radius)).toBeGreaterThan(0);

  const group = page.getByRole("group", { name: "Contato" });
  await expect(group).toHaveAttribute("data-gallery-panel", "group");
  const groupStyle = await group.evaluate((box) => {
    const style = getComputedStyle(box);
    return { border: style.borderTopWidth, fill: style.backgroundColor };
  });
  expect(groupStyle.border).toBe("1px");
  expect(groupStyle.fill).toBe("rgba(0, 0, 0, 0)");

  const steps = page.locator("[data-step-box]");
  await expect(steps).toHaveCount(3);
  const sizes = await steps.evaluateAll((boxes) =>
    boxes.map((box) => {
      const { height, width } = box.getBoundingClientRect();
      return [width, height];
    })
  );
  expect(sizes).toEqual([
    [28, 28],
    [28, 28],
    [28, 28],
  ]);

  const option = page.getByRole("checkbox", { name: "Azul / P" });
  await expect(option).not.toBeChecked();
  await page.getByText("Azul / P", { exact: true }).click();
  await expect(option).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Desligada, sem imagem para enviar" })
  ).toBeDisabled();
  const long = page.locator('[data-slot="checkable-option"]', {
    hasText: "bem comprido",
  });
  await page.setViewportSize({ height: 740, width: 320 });
  expect(await long.evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(
    true
  );
});

test("controle: o axe desta página acusa uma imagem sem texto alternativo", async ({
  page,
}) => {
  await openGallery(page, null);
  await page.evaluate(() => {
    const image = document.createElement("img");
    image.src = "/icons/icon-v2-192.png";
    document.querySelector("main")?.append(image);
  });
  const violations = await axeViolations(page);
  expect(violations.map((violation) => violation.id)).toContain("image-alt");
});
