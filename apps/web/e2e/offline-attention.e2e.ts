/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function openLab(page: Page, user: string) {
  await page.goto("/offline-attention-lab");
  await expect(
    page.getByRole("heading", { name: "Laboratório da atenção" })
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

const forcePattern = /forç/i;
const items = (page: Page) => page.locator("li[data-cause]");

test("uma venda recusada por estoque aparece, bloqueia a fila e sobrevive a recarregar", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page, user);
  await expect(page.getByText("Nada precisa de atenção")).toBeVisible();

  await click(page, "Criar venda recusada por estoque", "Venda recusada: ok");
  await click(page, "Criar venda na fila", "Venda na fila: ok");

  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText("Venda de 1 item");
  await expect(items(page).first()).toContainText("parando a fila");
  await expect(items(page).first()).toContainText("Código: insufficient_stock");
  await expect(
    page.getByText("1 registro recusado · 1 na fila atrás dele")
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reenviar venda" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Descartar…" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(forcePattern);

  await page.reload();
  await openLab(page, user);
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText("Venda de 1 item");
});

test("reenviar a venda a troca por um comando novo e libera a fila", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await click(page, "Criar venda recusada por estoque", "Venda recusada: ok");
  await page.getByRole("button", { name: "Reenviar venda" }).click();
  await expect(page.getByTestId("message")).toContainText("Reenviar: ok", {
    timeout: 15_000,
  });
  await expect(page.getByText("Nada precisa de atenção")).toBeVisible();
});

test("descartar pede confirmação, diz o que se perde e remove o registro", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await click(page, "Criar produto recusado por SKU", "Produto recusado: ok");
  await expect(items(page).first()).toContainText(
    "Outro produto já usa este SKU"
  );
  await expect(
    page.getByRole("button", { name: "Reenviar venda" })
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Descartar…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "serão apagados deste aparelho"
  );
  await page.getByRole("button", { name: "Manter" }).click();
  await expect(items(page)).toHaveCount(1);

  await page.getByRole("button", { name: "Descartar…" }).click();
  await page.getByRole("button", { name: "Confirmar descarte" }).click();
  await expect(page.getByTestId("message")).toContainText("Descartar: ok", {
    timeout: 15_000,
  });
  await expect(page.getByText("Nada precisa de atenção")).toBeVisible();
});

test("uma mudança de direito leva à revisão da conta, sem reenviar nem descartar", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await click(page, "Criar venda recusada por direito", "Direito alterado: ok");
  await expect(items(page).first()).toContainText("plano desta loja");
  await expect(
    page.getByRole("button", { name: "Reenviar venda" })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Descartar…" })).toHaveCount(0);
  await page.getByRole("button", { name: "Revisar acesso e plano" }).click();
  await expect(page.getByTestId("message")).toContainText("Revisar acesso");
});
