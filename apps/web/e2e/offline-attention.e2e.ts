/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SUPPORT_ADDRESS } from "./support-address";

async function openLab(page: Page, user: string, query = "") {
  await page.goto(`/offline-attention-lab${query}`);
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
const saleTitle = /Venda de R\$ \d+,\d{2} · \d{2}\/\d{2} \d{2}:\d{2}/;

test("uma venda recusada por estoque aparece, bloqueia a fila e sobrevive a recarregar", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page, user);
  await expect(page.getByText("Nenhuma pendência de envio")).toBeVisible();

  await click(page, "Criar venda recusada por estoque", "Venda recusada: ok");
  await click(page, "Criar venda na fila", "Venda na fila: ok");

  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText(saleTitle);
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
  await expect(items(page).first()).toContainText(saleTitle);
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
  await expect(page.getByText("Nenhuma pendência de envio")).toBeVisible();
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
  await expect(page.getByText("Nenhuma pendência de envio")).toBeVisible();
});

test("sem a aba Assinatura, a mudança de direito não oferece o link e diz para falar com o suporte", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`, "?assinatura=off");
  await click(page, "Criar venda recusada por direito", "Direito alterado: ok");
  await expect(items(page).first()).toContainText(
    `Regularize o plano com o suporte (${SUPPORT_ADDRESS}) e toque em Tentar novamente.`
  );
  await expect(page.getByRole("link", { name: "Ver Assinatura" })).toHaveCount(
    0
  );
  await expect(
    page.getByRole("button", { name: "Tentar novamente" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Descartar…" })).toHaveCount(0);
});

test("um acesso revogado oferece Sair e entrar de novo, com o valor e a data no título", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await click(page, "Criar venda recusada por acesso", "Acesso revogado: ok");
  await expect(items(page).first()).toContainText(saleTitle);
  await expect(items(page).first()).toContainText("use Sair e entrar de novo");
  await expect(
    page.getByRole("button", { name: "Revisar acesso e plano" })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Descartar…" })).toBeVisible();
  await page.getByRole("button", { name: "Sair e entrar de novo" }).click();
  await expect(page.getByTestId("message")).toContainText("Sair e entrar");
});

test("uma mudança de direito leva à Assinatura por um link, sem descartar", async ({
  page,
}) => {
  await openLab(page, `user-${crypto.randomUUID()}`);
  await click(page, "Criar venda recusada por direito", "Direito alterado: ok");
  await expect(items(page).first()).toContainText("plano desta loja");
  await expect(
    page.getByRole("button", { name: "Reenviar venda" })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Descartar…" })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Ver Assinatura" })
  ).toHaveAttribute("href", "/configuracoes?aba=assinatura");
});
