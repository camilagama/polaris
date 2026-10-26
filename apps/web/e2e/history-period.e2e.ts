/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  datePickerButton,
  FORM_VIEWPORTS,
  openDatePicker,
  touchDay,
} from "./date-pickers";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The period of the sales history on the DateRangePicker of src/ui (t373), in the lab of the screens over the real
 * offline runtime, the list answered by the test: two days make the period (in order, whichever is touched first),
 * a shortcut fills it, "Limpar" empties it, and what the server is asked for is the period that was made.
 */
const NOW = "2026-10-14T12:00:00.000Z";
const PERIOD = "Período (data da venda)";

const rpc = (body: unknown) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
});

interface ListRequest {
  occurredFrom?: string;
  occurredTo?: string;
}

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
  // below 760 px the filters are in a panel under "Filtrar"
  const panel = page.getByRole("button", { exact: true, name: "Filtrar" });
  if (await panel.isVisible()) {
    await panel.click();
  }
  await expect(datePickerButton(page, PERIOD)).toBeVisible();
  return asked;
}

for (const viewport of FORM_VIEWPORTS) {
  test(`o período do histórico, a ${viewport.name} px: dois dias em qualquer ordem, atalho, Limpar, e o servidor recebe o período feito`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const asked = await openHistory(page);
    await expect(datePickerButton(page, PERIOD)).toHaveAccessibleName(
      `${PERIOD}, Escolher período`
    );

    // the later day first: the period is made in order, so there is no "data inicial posterior à final" to show
    const popup = await openDatePicker(page, PERIOD);
    await touchDay(popup, "2026-10-12");
    await expect(popup).toBeVisible();
    await touchDay(popup, "2026-10-05");
    await expect(popup).toBeHidden();
    await expect(datePickerButton(page, PERIOD)).toHaveAccessibleName(
      `${PERIOD}, 05/10 a 12/10`
    );
    await expect(page.getByText("posterior à data final")).toHaveCount(0);
    await expect
      .poll(() => asked.at(-1))
      .toMatchObject({ occurredFrom: "2026-10-05", occurredTo: "2026-10-12" });
    await expect(
      page.getByRole("button", { name: "Limpar filtros (1)" })
    ).toBeVisible();

    // a shortcut: "7 dias" is today and the six days before it
    const shortcuts = await openDatePicker(page, PERIOD);
    await shortcuts
      .getByRole("group", { name: "Atalhos do período" })
      .getByRole("button", { exact: true, name: "7 dias" })
      .click();
    await expect(shortcuts).toBeHidden();
    await expect
      .poll(() => asked.at(-1))
      .toMatchObject({ occurredFrom: "2026-10-08", occurredTo: "2026-10-14" });

    // "Limpar" empties the period, and the list is asked for with no period
    const clearing = await openDatePicker(page, PERIOD);
    await clearing.getByRole("button", { name: "Limpar" }).click();
    await expect(clearing).toBeHidden();
    await expect(datePickerButton(page, PERIOD)).toHaveAccessibleName(
      `${PERIOD}, Escolher período`
    );
    await expect
      .poll(() => {
        const last = asked.at(-1);
        return last !== undefined && !("occurredFrom" in last);
      })
      .toBe(true);
  });
}
