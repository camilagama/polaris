/// <reference lib="dom" />
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { FORM_VIEWPORTS, touchDay } from "./date-pickers";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The filters of the sales history on the filter bar of src/ui (t391, over the DateRangePicker of t373), in the lab of
 * the screens over the real offline runtime, the list answered by the test: the period is a pill whose editor takes
 * two days (in order, whichever is touched first) or a shortcut, "Limpar" and the X take a pill out, "Limpar tudo"
 * takes them all, and what the server is asked for is what the bar shows.
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

/** Below 760 px the editor is the form Dialog of the whole screen: nothing applies before "Aplicar". */
const onPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 760;

async function apply(page: Page, popup: Locator) {
  if (onPhone(page)) {
    await popup.getByRole("button", { exact: true, name: "Aplicar" }).click();
  }
}

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

/** The editor of the period: the calendar comes on demand. */
async function openPeriod(page: Page) {
  await pill(page, "Período").click();
  const popup = editor(page, "Período");
  await expect(popup.getByRole("grid").first()).toBeVisible();
  return popup;
}

const lastAsked = (asked: ListRequest[]) => asked.at(-1);
const askedWithout = (asked: ListRequest[], key: keyof ListRequest) => {
  const last = lastAsked(asked);
  return last !== undefined && !(key in last);
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
      // no filter yet: the bar is only "Filtrar", with no pill and no "Limpar tudo"
      await expect(pill(page, "Período")).toHaveCount(0);
      await expect(
        bar(page).getByRole("button", { name: "Limpar tudo" })
      ).toHaveCount(0);

      // the later day first: the period is made in order, so there is no "data inicial posterior à final" to show
      const popup = await addFilter(page, "Período");
      await expect(popup.getByRole("grid").first()).toBeVisible();
      await touchDay(popup, "2026-10-12");
      await expect(popup).toBeVisible();
      await touchDay(popup, "2026-10-05");
      await apply(page, popup);
      await expect(popup).toBeHidden();
      await expect(pill(page, "Período")).toHaveAccessibleName(
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
      await apply(page, shortcuts);
      await expect(shortcuts).toBeHidden();
      await expect(pill(page, "Período")).toHaveAccessibleName(
        "Período: 08/10 a 14/10, editar"
      );
      await expect
        .poll(() => lastAsked(asked))
        .toMatchObject({
          occurredFrom: "2026-10-08",
          occurredTo: "2026-10-14",
        });

      // "Limpar" empties the period: the pill goes and the list is asked for with no period
      const clearing = await openPeriod(page);
      await clearing.getByRole("button", { name: "Limpar" }).click();
      await apply(page, clearing);
      await expect(clearing).toBeHidden();
      await expect(pill(page, "Período")).toHaveCount(0);
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
      await apply(page, status);
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

      // the X of one pill takes only that filter out
      await remover(page, "Situação").click();
      await expect(pill(page, "Situação")).toHaveCount(0);
      await expect(pill(page, "Cliente")).toBeVisible();
      await expect.poll(() => askedWithout(asked, "status")).toBe(true);
      await expect(lastAsked(asked)).toMatchObject({ customerQuery: "angela" });

      // with two pills again, "Limpar tudo" takes them all and the list is asked for with no filter
      await addFilter(page, "Situação");
      const confirmed = page.getByRole("dialog", { name: "Situação" });
      await confirmed
        .getByRole("button", { exact: true, name: "Confirmadas" })
        .click();
      await apply(page, confirmed);
      await expect(clearAll).toBeVisible();
      await clearAll.click();
      await expect(bar(page).locator('[data-slot="filter-pill"]')).toHaveCount(
        0
      );
      await expect(clearAll).toHaveCount(0);
      await expect
        .poll(
          () =>
            askedWithout(asked, "status") &&
            askedWithout(asked, "customerQuery") &&
            askedWithout(asked, "occurredFrom")
        )
        .toBe(true);
    });
  });
}
