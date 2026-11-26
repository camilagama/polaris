/// <reference lib="dom" />
// Only types from Playwright: `ui-screens.ts` is read under Vitest by the source rules.
import type { Page, Route } from "@playwright/test";
import {
  DETAIL_SALE_ID,
  fixSaleDetailClock,
  openSaleAction,
  saleDetailAnswers,
} from "./sale-detail-fixture";
import { showScreenAlone } from "./show-screen-alone";
import { serveLabWorker, WORKER_MARK } from "./worker-mark";

/**
 * The states of the sale detail and of the customer page the interface guardrails measure: the screens in the
 * lab of the screens (`/offline-screens-lab?screen=sale-detail&saleId=…`), with the sale, its customer link and the
 * customers answered by the test (`page.route`), synthetic data only. Four states, as few as cover the parts: each
 * one starts the runtime of the lab in every context of the map. The lab's own controls are hidden at the end of
 * each state, so what is measured is the screen alone.
 */
const RPC_PREFIX = /^.*\/rpc\//;

async function serveSale(
  page: Page,
  withReturn: boolean,
  hold = false,
  withFee = false
) {
  const answers = saleDetailAnswers({ withFee, withReturn });
  await page.route("**/rpc/{sale,customer}/**", (route: Route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      RPC_PREFIX,
      ""
    );
    if (hold && procedure === "sale/get") {
      // the server never answers: the detail stays loading
      return new Promise<void>(() => undefined);
    }
    const answer = answers[procedure];
    return answer === undefined
      ? route.abort("internetdisconnected")
      : route.fulfill({
          body: JSON.stringify({ json: answer, meta: [] }),
          contentType: "application/json",
          headers: { ...WORKER_MARK },
        });
  });
}

/** Starts the lab's runtime on one of the two screens and waits for its heading. */
async function openSaleLab(
  page: Page,
  screen: "sale-detail",
  heading: string,
  withReturn = true,
  hold = false,
  withFee = false
) {
  await fixSaleDetailClock(page);
  await serveSale(page, withReturn, hold, withFee);
  await serveLabWorker(page);
  await page.goto(
    `/offline-screens-lab?screen=${screen}&saleId=${DETAIL_SALE_ID}`
  );
  await page.getByLabel("Usuário").fill(`guardrails-${crypto.randomUUID()}`);
  await page.getByRole("button", { exact: true, name: "Iniciar" }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "Iniciar: ok (ready)" })
    .waitFor({ timeout: 20_000 });
  await page
    .getByRole("heading", { exact: true, level: 1, name: heading })
    .waitFor();
  if (!hold) {
    // the customer is read: its name is on the line of the receipt
    await page.getByText("Ângela Souza").first().waitFor();
  }
}

const openDetail = (page: Page, withReturn = true, withFee = false) =>
  openSaleLab(
    page,
    "sale-detail",
    "Detalhe da venda",
    withReturn,
    false,
    withFee
  );

export const saleDetailStates = {
  /** The cancellation reviewed: the reason, the effect in a neutral notice and the one destructive button. */
  async cancelReview(page: Page) {
    await openDetail(page, false);
    await openSaleAction(page, "Cancelar venda");
    await page.getByRole("button", { name: "Revisar cancelamento" }).click();
    await page
      .getByRole("button", { name: "Confirmar cancelamento" })
      .waitFor();
    await showScreenAlone(page);
  },

  /** The customer of the sale, in the detail: the line of the receipt with the name and the summary, and the history. */
  async customer(page: Page) {
    await openDetail(page);
    await page.locator("[data-sale-customer]").waitFor();
    await showScreenAlone(page);
    await page.locator("[data-sale-customer]").scrollIntoViewIfNeeded();
  },

  /** The form dialog of "Trocar cliente", open: the list of customers and the button that sends the choice, off. */
  async customerChoose(page: Page) {
    await openDetail(page);
    await openSaleAction(page, "Trocar cliente");
    await page.getByRole("dialog", { name: "Trocar cliente" }).waitFor();
    await showScreenAlone(page);
  },
  /** The detail with a processing fee recorded on the payment, to read the amount of the fee on screen. */
  async detailWithFee(page: Page) {
    await openDetail(page, true, true);
    await page.getByRole("button", { exact: true, name: "Ações" }).waitFor();
    await showScreenAlone(page);
  },

  /** The detail as it opens: the receipt with the customer line, the return made, the menu of the title closed and the note on why the sale cannot be cancelled. */
  async detail(page: Page) {
    await openDetail(page);
    await page.getByRole("button", { exact: true, name: "Ações" }).waitFor();
    await showScreenAlone(page);
  },

  /** The read of the sale does not answer: the line for the screen reader and the skeleton of the receipt. */
  async loading(page: Page) {
    await openSaleLab(page, "sale-detail", "Detalhe da venda", true, true);
    await page
      .getByRole("status")
      .getByText("Carregando venda…")
      .waitFor({ state: "attached" });
    await showScreenAlone(page);
  },

  /** The return open, with a quantity over what is left: the table (cards in a card narrower than 48rem) and the field errors. */
  async returnError(page: Page) {
    await openDetail(page);
    await openSaleAction(page, "Registrar devolução");
    await page.getByLabel("Devolvido: Calça jeans — 42 (até 1)").fill("5");
    await page.getByRole("button", { name: "Revisar devolução" }).click();
    await page.getByText("Só resta 1 para devolver.").waitFor();
    await showScreenAlone(page);
  },
};
