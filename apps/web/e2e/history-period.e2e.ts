/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  expectNoTypedDates,
  FORM_VIEWPORTS,
  panelHeight,
  touchDay,
} from "./date-pickers";
import { applyEditor, onPhone } from "./filter-bar-editor";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The filters of the sales history, in the lab of the screens over the real offline runtime, the list answered by the
 * test: the period is the button of the title line, whose picker takes two days (in order, whichever is touched
 * first) or a shortcut and "Limpar" empties it; the other filters are pills of the filter bar of src/ui, the X takes a
 * pill out, "Limpar tudo" takes them all and the period, and what the server is asked for is what the screen shows.
 */
const NOW = "2026-10-14T12:00:00.000Z";

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

interface ListRequest {
  customerQuery?: string;
  occurredFrom?: string;
  occurredTo?: string;
  status?: string;
}

const bar = (page: Page) =>
  page.getByRole("search", { exact: true, name: "Filtrar vendas" });
// by `aria-label`, not by role: under the form Dialog of a phone the page behind is `aria-hidden`, and a hidden element is not found by role and has no name
const pill = (page: Page, field: string) =>
  page.locator(
    `search[aria-label="Filtrar vendas"] button[aria-label^="${field}: "][aria-label$=", editar"]`
  );
const remover = (page: Page, field: string) =>
  bar(page).getByRole("button", {
    includeHidden: true,
    name: `Tirar o filtro ${field}`,
  });
const editor = (page: Page, field: string) =>
  page.getByRole("dialog", { name: field });

/** Chooses a field in the "Filtrar" menu: its pill is added and its editor opens. */
async function addFilter(page: Page, field: string) {
  await bar(page).getByRole("button", { exact: true, name: "Filtrar" }).click();
  await page
    .getByRole("menu", { name: "Filtrar por" })
    .getByRole("menuitem", { name: new RegExp(`^${field}`) })
    .click();
  const popup = editor(page, field);
  await expect(popup).toBeVisible();
  return popup;
}

/** The period of the title line: its name says the range, or that there is none. */
const periodButton = (page: Page) =>
  page.locator('header button[aria-label^="Período"]');

/** The picker of the period: the calendar comes on demand. */
async function openPeriod(page: Page) {
  await periodButton(page).click();
  const popup = editor(page, "Período");
  await expect(popup.getByRole("grid").first()).toBeVisible();
  return popup;
}

const lastAsked = (asked: ListRequest[]) => asked.at(-1);
const askedWithout = (asked: ListRequest[], key: keyof ListRequest) => {
  const last = lastAsked(asked);
  return last !== undefined && !(key in last);
};

const FILTER_KEYS = [
  "customerQuery",
  "occurredFrom",
  "occurredTo",
  "status",
] as const satisfies readonly (keyof ListRequest)[];
const filtersAsked = (asked: ListRequest[]) => {
  const last = lastAsked(asked);
  return FILTER_KEYS.filter((key) => last !== undefined && key in last);
};

async function openHistory(page: Page) {
  const asked: ListRequest[] = [];
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/rpc/sale/list", (route: Route) => {
    const body = route.request().postDataJSON() as { json: ListRequest };
    asked.push(body.json);
    return route.fulfill(rpc({ hasMore: false, sales: [] }));
  });
  await serveLabWorker(page);
  await page.goto("/offline-screens-lab?screen=history");
  await page.getByLabel("Usuário").fill(`user-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await expect(page.getByTestId("message")).toContainText(
    "Iniciar: ok (ready)",
    { timeout: 20_000 }
  );
  await expect(
    page.getByRole("heading", { exact: true, name: "Histórico de vendas" })
  ).toBeVisible();
  await expect(bar(page)).toBeVisible();
  return asked;
}

for (const viewport of FORM_VIEWPORTS) {
  test.describe(`a ${viewport.name} px`, () => {
    test.use({ viewport });

    test("o período: dois dias em qualquer ordem, atalho, Limpar, e o servidor recebe o período feito", async ({
      page,
    }) => {
      const asked = await openHistory(page);
      // no filter yet: the bar is only "Filtrar", with no pill and no "Limpar tudo"; the period says it has no range
      await expect(periodButton(page)).toHaveAccessibleName(
        "Período, Escolher período"
      );
      await expect(bar(page).locator('[data-slot="filter-pill"]')).toHaveCount(
        0
      );
      await expect(
        bar(page).getByRole("button", { name: "Limpar tudo" })
      ).toHaveCount(0);

      // the later day first: the period is made in order, so there is no "data inicial posterior à final" to show
      const popup = await openPeriod(page);
      await touchDay(popup, "2026-10-12");
      await expect(popup).toBeVisible();
      await touchDay(popup, "2026-10-05");
      await expect(popup).toBeHidden();
      await expect(periodButton(page)).toHaveAccessibleName(
        "Período: 05/10 a 12/10, editar"
      );
      await expect(page.getByText("posterior à data final")).toHaveCount(0);
      await expect
        .poll(() => lastAsked(asked))
        .toMatchObject({
          occurredFrom: "2026-10-05",
          occurredTo: "2026-10-12",
        });

      // a shortcut: "7 dias" is today and the six days before it
      const shortcuts = await openPeriod(page);
      await shortcuts
        .getByRole("group", { name: "Atalhos do período" })
        .getByRole("button", { exact: true, name: "7 dias" })
        .click();
      await expect(shortcuts).toBeHidden();
      await expect(periodButton(page)).toHaveAccessibleName(
        "Período: 08/10 a 14/10, editar"
      );
      await expect
        .poll(() => lastAsked(asked))
        .toMatchObject({
          occurredFrom: "2026-10-08",
          occurredTo: "2026-10-14",
        });

      // "Este mês" is the calendar month everywhere; the history has no future days, so it is cut at today
      const month = await openPeriod(page);
      await month
        .getByRole("group", { name: "Atalhos do período" })
        .getByRole("button", { exact: true, name: "Este mês" })
        .click();
      await expect(month).toBeHidden();
      await expect(periodButton(page)).toHaveAccessibleName(
        "Período: 01/10 a 14/10, editar"
      );
      await expect
        .poll(() => lastAsked(asked))
        .toMatchObject({
          occurredFrom: "2026-10-01",
          occurredTo: "2026-10-14",
        });
      const pressed = await openPeriod(page);
      await expect(
        pressed
          .getByRole("group", { name: "Atalhos do período" })
          .getByRole("button", { exact: true, name: "Este mês" })
      ).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("Escape");
      await expect(pressed).toBeHidden();

      // "Limpar" empties the period: the button goes back to "Escolher período" and the list is asked for with no period
      const clearing = await openPeriod(page);
      await clearing.getByRole("button", { name: "Limpar" }).click();
      await expect(clearing).toBeHidden();
      await expect(periodButton(page)).toHaveAccessibleName(
        "Período, Escolher período"
      );
      await expect.poll(() => askedWithout(asked, "occurredFrom")).toBe(true);
    });

    test("Situação e Cliente: cada pílula muda a consulta, o X tira uma, e Limpar tudo (só com duas) tira todas", async ({
      page,
    }) => {
      const asked = await openHistory(page);
      const clearAll = bar(page).getByRole("button", { name: "Limpar tudo" });

      const status = await addFilter(page, "Situação");
      await status
        .getByRole("button", { exact: true, name: "Canceladas" })
        .click();
      await applyEditor(page, status);
      await expect(status).toBeHidden();
      await expect(pill(page, "Situação")).toHaveAccessibleName(
        "Situação: Canceladas, editar"
      );
      await expect
        .poll(() => lastAsked(asked))
        .toMatchObject({ status: "cancelled" });
      // one pill: its own X is the same gesture
      await expect(clearAll).toHaveCount(0);

      const customer = await addFilter(page, "Cliente");
      await customer.getByRole("textbox", { name: "Cliente" }).fill("angela");
      await customer
        .getByRole("button", { name: onPhone(page) ? "Aplicar" : "Pronto" })
        .click();
      await expect(customer).toBeHidden();
      await expect(pill(page, "Cliente")).toHaveAccessibleName(
        "Cliente: angela, editar"
      );
      await expect
        .poll(() => lastAsked(asked))
        .toMatchObject({ customerQuery: "angela", status: "cancelled" });
      await expect(clearAll).toBeVisible();

      const shortcuts = await openPeriod(page);
      await shortcuts
        .getByRole("group", { name: "Atalhos do período" })
        .getByRole("button", { exact: true, name: "7 dias" })
        .click();
      await expect(shortcuts).toBeHidden();
      await expect
        .poll(() => lastAsked(asked))
        .toMatchObject({ occurredFrom: "2026-10-08", status: "cancelled" });

      // the X of one pill takes only that filter out, the period stays
      await remover(page, "Situação").click();
      await expect(pill(page, "Situação")).toHaveCount(0);
      await expect(pill(page, "Cliente")).toBeVisible();
      await expect.poll(() => askedWithout(asked, "status")).toBe(true);
      await expect(lastAsked(asked)).toMatchObject({
        customerQuery: "angela",
        occurredFrom: "2026-10-08",
        occurredTo: "2026-10-14",
      });
      // "Limpar tudo" does not show for one pill with a period
      await expect(clearAll).toHaveCount(0);

      // the X of the last pill (Cliente) takes only that filter out: no pill is left, the period stays and the list is asked for with the period alone
      await remover(page, "Cliente").click();
      await expect(bar(page).locator('[data-slot="filter-pill"]')).toHaveCount(
        0
      );
      await expect(periodButton(page)).toHaveAccessibleName(
        "Período: 08/10 a 14/10, editar"
      );
      await expect.poll(() => askedWithout(asked, "customerQuery")).toBe(true);
      expect(lastAsked(asked)).toMatchObject({
        occurredFrom: "2026-10-08",
        occurredTo: "2026-10-14",
      });
      expect(filtersAsked(asked)).toEqual(["occurredFrom", "occurredTo"]);

      // Cliente back, so the phase with two pills below starts as before
      const customerAgain = await addFilter(page, "Cliente");
      await customerAgain
        .getByRole("textbox", { name: "Cliente" })
        .fill("angela");
      await customerAgain
        .getByRole("button", { name: onPhone(page) ? "Aplicar" : "Pronto" })
        .click();
      await expect(customerAgain).toBeHidden();
      await expect
        .poll(() => lastAsked(asked))
        .toMatchObject({ customerQuery: "angela" });

      // with two pills again, "Limpar tudo" takes them all and the period too: the list is asked for with no filter at all
      await addFilter(page, "Situação");
      const confirmed = page.getByRole("dialog", { name: "Situação" });
      await confirmed
        .getByRole("button", { exact: true, name: "Confirmadas" })
        .click();
      await applyEditor(page, confirmed);
      await expect(clearAll).toBeVisible();
      await clearAll.click();
      await expect(bar(page).locator('[data-slot="filter-pill"]')).toHaveCount(
        0
      );
      await expect(clearAll).toHaveCount(0);
      await expect(periodButton(page)).toHaveAccessibleName(
        "Período, Escolher período"
      );
      await expect
        .poll(
          () =>
            askedWithout(asked, "status") &&
            askedWithout(asked, "customerQuery") &&
            askedWithout(asked, "occurredFrom") &&
            askedWithout(asked, "occurredTo")
        )
        .toBe(true);
    });

    test("o painel do período não tem campo de data digitada e mantém a altura ao abrir e ao marcar o início, e o toque do fim fecha o painel", async ({
      page,
    }) => {
      const asked = await openHistory(page);
      const popup = await openPeriod(page);
      await expectNoTypedDates(popup);
      const opened = await panelHeight(popup);

      await touchDay(popup, "2026-10-12");
      await expect(
        popup.getByText("Início 12/10. Escolha o último dia.")
      ).toBeVisible();
      await expectNoTypedDates(popup);
      expect(await panelHeight(popup)).toBeCloseTo(opened, 1);

      await touchDay(popup, "2026-10-14");
      await expect(popup).toBeHidden();
      await expect(periodButton(page)).toHaveAccessibleName(
        "Período: 12/10 a 14/10, editar"
      );
      await expect
        .poll(() => lastAsked(asked))
        .toMatchObject({
          occurredFrom: "2026-10-12",
          occurredTo: "2026-10-14",
        });

      const again = await openPeriod(page);
      await expectNoTypedDates(again);
    });
  });
}
