/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { axeFaults } from "../e2e-pwa/ui-guardrails/measures";
import { openPreferenceScreen, rpc } from "./email-preference-stub";

/**
 * The card "E-mails que você recebe" in Seus dados, in the real route with the API answered by the test: the owner
 * sees it before "Pedir cópia", turns the tips off and on with one touch each, reads "Salvo." or the inline refusal,
 * and with no connection the switch is off and says why. Whoever is not the owner does not see it. The two doors of the
 * preference (the screen and the link of the e-mail) meet in `e2e-real/jornadas/dicas-por-duas-portas.e2e.ts`.
 */
const CARD = "E-mails que você recebe";
const FORBIDDEN_WORDS =
  /descadastr|cancelar inscri|opt-out|série|ativação|trial/i;

const CARD_SELECTOR = '[aria-labelledby="email-preference-title"]';
const TIPS_HELP = /Até 3 e-mails nos primeiros 14 dias/;
const SENT_LINE = /Enviados até agora/;
const OFFLINE_REASON = /connection-required-text/;

const card = (page: Page) =>
  page.getByRole("region", { exact: true, name: CARD });
const tips = (page: Page) =>
  page.getByRole("switch", { exact: true, name: "Dicas para começar" });

test("o dono vê o cartão antes de Pedir cópia, com os textos do corte e sem o jargão (AC-8b.2, AC-8b.5)", async ({
  page,
}) => {
  await openPreferenceScreen(page, { state: { sent: 0, tips: true } });
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText("Avisos da conta e da cobrança");
  await expect(card(page)).toContainText(
    "Sempre enviados: fazem parte do serviço."
  );
  await expect(card(page)).toContainText(
    "Até 3 e-mails nos primeiros 14 dias de uma loja nova, para ajudar a fazer a primeira venda. Vale para todas as suas lojas."
  );
  await expect(tips(page)).toBeChecked();
  await expect(card(page).getByRole("switch")).toHaveCount(1);
  await expect(card(page).getByRole("button")).toHaveCount(0);
  await expect(card(page).getByText(SENT_LINE)).toHaveCount(0);
  expect(await card(page).innerText()).not.toMatch(FORBIDDEN_WORDS);

  const cardBox = await card(page).boundingBox();
  const requestBox = await page
    .getByRole("region", { exact: true, name: "Pedir cópia" })
    .boundingBox();
  expect(cardBox?.y ?? 0).toBeLessThan(requestBox?.y ?? 0);
});

test("a linha do que já saiu só existe com envio, e o número é o do servidor (AC-8b.3)", async ({
  page,
}) => {
  await openPreferenceScreen(page, { state: { sent: 2, tips: false } });
  await expect(tips(page)).not.toBeChecked();
  await expect(card(page)).toContainText("Enviados até agora: 2 de 3.");
});

test("tocar desliga e liga, grava ao tocar e diz Salvo. numa região de status (AC-8b.1, AC-8b.7)", async ({
  page,
}) => {
  const server = await openPreferenceScreen(page);
  await tips(page).click();
  await expect(tips(page)).not.toBeChecked();
  await expect(card(page).getByRole("status")).toHaveText("Salvo.");
  expect(server.writes).toEqual([
    { on: false, organizationId: "0199c2d0-0000-7000-8000-00000000a001" },
  ]);
  await tips(page).click();
  await expect(tips(page)).toBeChecked();
  expect(server.writes.map((write) => write.on)).toEqual([false, true]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("se não gravou, o cartão mantém o estado e diz inline, sem aviso flutuante", async ({
  page,
}) => {
  await openPreferenceScreen(page, {
    setTips: (route) =>
      route.fulfill(
        rpc(
          {
            code: "INTERNAL_SERVER_ERROR",
            defined: false,
            message: "x",
            status: 500,
          },
          500
        )
      ),
  });
  await tips(page).click();
  await expect(card(page).getByRole("alert")).toHaveText(
    "Não deu para salvar. Tente de novo."
  );
  await expect(tips(page)).toBeChecked();
  await expect(card(page).getByRole("status")).toHaveText("");
  await expect(page.getByRole("region", { name: "Notifications" })).toHaveCount(
    0
  );
});

test("sem internet o controle fica aria-disabled, descrito pela faixa, e nada sai", async ({
  page,
}) => {
  const server = await openPreferenceScreen(page);
  await expect(tips(page)).toBeVisible();
  await page.context().setOffline(true);
  await expect(page.getByText("Sem internet.")).toHaveCount(1);
  await expect(tips(page)).toHaveAttribute("aria-disabled", "true");
  await expect(tips(page)).toHaveAttribute("aria-describedby", OFFLINE_REASON);
  await tips(page).click({ force: true });
  expect(server.writes).toEqual([]);
  await expect(tips(page)).toBeChecked();
  await page.context().setOffline(false);
  await expect(tips(page)).not.toHaveAttribute("aria-disabled", "true");
});

test("quem não é dono não vê o cartão nem lê a preferência (AC-8b.4)", async ({
  page,
}) => {
  const server = await openPreferenceScreen(page, { role: "cashier" });
  await expect(
    page.getByText("Só o dono da loja pode pedir e baixar a cópia dos dados.")
  ).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(tips(page)).toHaveCount(0);
  expect(server.reads).toBe(0);
  expect(server.writes).toEqual([]);
});

test("sem violação de axe, com o nome do controle e a ordem de foco: o interruptor antes do pedido da cópia (AC-8b.7)", async ({
  page,
}) => {
  await openPreferenceScreen(page, { state: { sent: 2, tips: true } });
  await expect(tips(page)).toBeVisible();
  expect(await axeFaults(page, CARD_SELECTOR)).toEqual([]);
  await expect(tips(page)).toHaveAccessibleName("Dicas para começar");
  await expect(tips(page)).toHaveAccessibleDescription(TIPS_HELP);

  await tips(page).focus();
  await page.keyboard.press("Tab");
  await expect(
    page
      .getByRole("region", { exact: true, name: "Pedir cópia" })
      .locator(":focus")
  ).toHaveCount(1);

  await tips(page).focus();
  await page.keyboard.press("Space");
  await expect(tips(page)).not.toBeChecked();
  await expect(card(page).getByRole("status")).toHaveText("Salvo.");
  expect(await axeFaults(page, CARD_SELECTOR)).toEqual([]);
});
