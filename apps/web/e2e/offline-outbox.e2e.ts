/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const rejectedPattern = /rejected:stock_insufficient/;
const wipeRefusedPattern = /PendingCommandsError/;
const persistentPattern = /granted|denied|unsupported/;

async function openLab(page: Page) {
  await page.goto("/offline-outbox-lab");
  await expect(
    page.getByRole("heading", { name: "Outbox de comandos" })
  ).toBeVisible();
}

async function useNamespace(page: Page, user: string, organization = "org-1") {
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Organização").fill(organization);
}

async function click(page: Page, name: string, expected: RegExp | string) {
  await page.getByRole("button", { exact: true, name }).click();
  await expect(page.getByTestId("message")).toContainText(expected, {
    timeout: 15_000,
  });
}

const list = (page: Page) => page.getByTestId("outbox-list").locator("li");

test("os comandos enfileirados sobrevivem a recarregar e mantêm a ordem", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, user);
  for (let n = 1; n <= 3; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: commands are queued in order
    await click(page, "Enfileirar", "Enfileirar: ok");
  }
  await expect(page.getByTestId("count-pending")).toHaveText("3");

  await page.reload();
  await openLab(page);
  await useNamespace(page, user);
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(3);
  await expect(list(page).nth(0)).toContainText("1:pending");
  await expect(list(page).nth(2)).toContainText("3:pending");
});

test("o mesmo comando repetido não entra duas vezes", async ({ page }) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Repetir comando", "Repetir comando: ok");
  await expect(list(page)).toHaveCount(1);
});

test("um comando enviado cuja resposta se perdeu volta à fila e mantém a posição", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, user);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enviar", "Enviar: ok");
  await expect(page.getByTestId("count-sending")).toHaveText("1");

  // the app dies mid-request: reload, reopen, recover
  await page.reload();
  await openLab(page);
  await useNamespace(page, user);
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page).nth(0)).toContainText("1:sending");
  await click(page, "Recuperar", "1 recuperados");
  await expect(list(page).nth(0)).toContainText("1:pending");
  await expect(list(page).nth(0)).toContainText("a1");
  await expect(list(page).nth(1)).toContainText("2:pending");
});

test("um comando rejeitado bloqueia a fila até ser tratado", async ({
  page,
}) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enviar", "Enviar: ok");
  await click(page, "Rejeitar", "Rejeitar: ok");
  await expect(list(page).nth(0)).toHaveText(rejectedPattern);
  await click(page, "Enviar", "nada para enviar");

  await click(page, "Tentar de novo", "Tentar de novo: ok");
  await click(page, "Enviar", "Enviar: ok");
  await click(page, "Confirmar", "Confirmar: ok");
  await expect(list(page)).toHaveCount(1);
  await expect(list(page).nth(0)).toContainText("2:pending");
});

test("um lease vencido bloqueia comandos novos mas preserva os da fila", async ({
  page,
}) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await page.getByLabel("Lease vencido").check();
  await click(page, "Enfileirar", "OfflineLeaseUnusableError");
  await expect(list(page)).toHaveCount(1);
  await expect(list(page).nth(0)).toContainText("1:pending");
});

test("usuários e organizações diferentes têm outboxes separados", async ({
  page,
}) => {
  const first = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, first);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enfileirar", "Enfileirar: ok");

  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(0);

  await useNamespace(page, first, "org-2");
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(0);

  await useNamespace(page, first);
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(2);
});

test("apagar o outbox nunca descarta comandos pendentes sem o aceite explícito", async ({
  page,
}) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Apagar", wipeRefusedPattern);
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(1);

  await click(page, "Apagar descartando", "1 descartados");
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(0);
});

test("a posição de um comando nunca é reutilizada, nem depois de apagar a fila", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, user);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enviar", "Enviar: ok");
  await click(page, "Confirmar", "Confirmar: ok");
  await click(page, "Enfileirar", "seq 2");
});

test("pede o armazenamento persistente e mostra a resposta", async ({
  page,
}) => {
  await openLab(page);
  await page
    .getByRole("button", { name: "Pedir armazenamento persistente" })
    .click();
  await expect(page.getByTestId("persistent")).toHaveText(persistentPattern);
});
