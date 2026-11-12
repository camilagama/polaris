import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Passos que a sessão da área 2 (Produtos) não alcançou: arquivar o Boné e Desfazer no próprio aviso, e arquivar,
 * conferir que Vender não o oferece, e Restaurar pela aba Arquivados.
 */
const MORE = { name: "Mais ações para Boné aba curva" };
const SEARCH = { name: "Produto ou variante" };

const ARCHIVED_NOTICE = /Boné aba curva” arquivado\./;
const RESTORED_NOTICE = /Boné aba curva” restaurado\./;
const CAP = /Boné/;
const SHIRT = /Camiseta/;
test("arquivar o Boné e Desfazer na hora devolve o produto", {
  session: "bb-achados-3",
  tags: ["rodada2"],
}, async ({ app, screen }) => {
  await app.open("/products");
  await screen.getByRole("button", MORE).tap();
  await screen.getByRole("menuitem", { name: "Arquivar" }).tap();
  await expect(screen.getByText(ARCHIVED_NOTICE)).toBeVisible();
  await screen.getByRole("button", { name: "Desfazer" }).tap();
  await expect(screen.getByText(RESTORED_NOTICE)).toBeVisible();
  await expect(
    screen.getByRole("button", { name: "Editar Boné aba curva" })
  ).toBeVisible();

  await app.open("/sales");
  await screen.getByRole("combobox", SEARCH).fill("Boné");
  await expect(screen.getByRole("option", { name: CAP }).first()).toBeVisible();
});

test("arquivado some de Vender e Restaurar pela aba Arquivados devolve", {
  session: "bb-achados-5",
  tags: ["rodada2"],
}, async ({ app, screen }) => {
  await app.open("/products");
  await screen.getByRole("button", MORE).tap();
  await screen.getByRole("menuitem", { name: "Arquivar" }).tap();
  await expect(screen.getByText(ARCHIVED_NOTICE)).toBeVisible();

  await app.open("/sales");
  await screen.getByRole("combobox", SEARCH).fill("a");
  await expect(
    screen.getByRole("option", { name: SHIRT }).first()
  ).toBeVisible();
  await expect(screen.getByRole("option", { name: CAP })).toBeHidden();

  await app.open("/products");
  await screen.getByRole("tab", { name: "Arquivados" }).tap();
  await screen.getByRole("button", MORE).tap();
  await screen.getByRole("menuitem", { name: "Restaurar" }).tap();
  await expect(screen.getByText(RESTORED_NOTICE)).toBeVisible();

  await app.open("/sales");
  await screen.getByRole("combobox", SEARCH).fill("Boné");
  await expect(screen.getByRole("option", { name: CAP }).first()).toBeVisible();
});
