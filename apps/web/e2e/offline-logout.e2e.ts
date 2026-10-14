/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const forcePattern = /sair assim mesmo|forç/i;

async function openLab(page: Page, user: string) {
  await page.goto("/offline-logout-lab");
  await expect(
    page.getByRole("heading", { name: "Laboratório da saída" })
  ).toBeVisible();
  await page.getByLabel("Usuário").fill(user);
  await page.getByRole("button", { exact: true, name: "Abrir" }).click();
  await expect(page.getByTestId("message")).toContainText("Abrir: ok", {
    timeout: 15_000,
  });
}

async function click(page: Page, name: string, expected: string) {
  await page.getByRole("button", { exact: true, name }).click();
  await expect(page.getByTestId("message")).toContainText(expected, {
    timeout: 15_000,
  });
}

const queue = async (page: Page, count: number) => {
  for (let n = 1; n <= count; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: operations are queued in order
    await click(page, "Enfileirar operação", `${n} na fila`);
  }
};

test("sem nada na fila, sair apaga os dados locais na hora", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await click(page, "Sair", "Sair: ok");
  await expect(page.getByTestId("logged-out")).toBeVisible();
  await click(page, "Conferir dados", "0 operações guardadas");
});

test("com operações na fila e rede, sair envia primeiro e só então apaga", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await queue(page, 2);
  await click(page, "Sair", "sessão encerrada");
  await expect(page.getByTestId("logged-out")).toBeVisible();
  await click(page, "Conferir dados", "0 operações guardadas");
});

test("sem rede, sair é bloqueado, nada se perde e a pessoa pode ficar conectada", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page, user);
  await queue(page, 2);
  await page.getByLabel("Rede disponível").uncheck();

  await click(page, "Sair", "bloqueado");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("2 operações");
  await expect(dialog).toContainText("sem conexão com o servidor");
  await expect(page.getByTestId("logged-out")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(forcePattern);

  await page.getByRole("button", { name: "Ficar conectado" }).click();
  await expect(page.getByTestId("message")).toContainText("Sair: cancelado");
  await click(page, "Conferir dados", "2 operações guardadas");

  // the data also survives a reload
  await page.reload();
  await openLab(page, user);
  await click(page, "Conferir dados", "2 operações guardadas");
});

test("voltando a rede, tentar de novo envia a fila e conclui a saída", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await queue(page, 1);
  await page.getByLabel("Rede disponível").uncheck();
  await click(page, "Sair", "bloqueado");

  await page.getByLabel("Rede disponível").check();
  await page.getByRole("button", { name: "Tentar enviar de novo" }).click();
  await expect(page.getByTestId("logged-out")).toBeVisible({ timeout: 15_000 });
  await click(page, "Conferir dados", "0 operações guardadas");
});

test("uma recusa do servidor bloqueia a saída e oferece ver o que precisa de atenção", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await queue(page, 2);
  await page.getByLabel("Servidor recusa").check();
  await click(page, "Sair", "bloqueado");

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("O servidor recusou operações");
  await page
    .getByRole("button", { name: "Ver o que precisa de atenção" })
    .click();
  await expect(page.getByTestId("message")).toContainText("Atenção:");
  await click(page, "Conferir dados", "2 operações guardadas");
});

test("descartar para sair pede confirmação em duas etapas e só então apaga", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await queue(page, 2);
  await page.getByLabel("Rede disponível").uncheck();
  await click(page, "Sair", "bloqueado");

  await page.getByRole("button", { name: "Descartar e sair…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Isto apaga 2 operações deste aparelho"
  );
  await page.getByRole("button", { name: "Voltar" }).click();
  await expect(page.getByTestId("logged-out")).toHaveCount(0);
  await click(page, "Conferir dados", "2 operações guardadas");

  await page.getByRole("button", { name: "Descartar e sair…" }).click();
  await page
    .getByRole("button", { exact: true, name: "Descartar e sair" })
    .click();
  await expect(page.getByTestId("message")).toContainText("2 descartadas", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("logged-out")).toBeVisible();
  await click(page, "Conferir dados", "0 operações guardadas");
});
