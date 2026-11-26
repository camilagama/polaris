import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Achado da área 5 (Conta e loja): o menu "Loja, conta e ajuda" não lista Minha conta e /conta abre o Início.
 * Esperado pelo explorador: o item "Minha conta" no menu. Na pilha local a senha está desligada e o runtime offline
 * não está ligado, e Minha conta só tem as abas Senha e Aparelhos.
 */
const MENU = /^Loja, conta e ajuda: /;
test("o menu da conta lista Minha conta", {
  session: "bb-r4a-achados-2",
  tags: ["r4a"],
}, async ({ app, screen }) => {
  await app.open("/");
  await screen.getByRole("button", { name: MENU }).tap();
  await expect(
    screen.getByRole("menuitem", { name: "Minha conta" })
  ).toBeVisible();
});

test("controle: sem aba de Minha conta, /conta abre o Início e o menu mostra Ajuda e contato", {
  session: "bb-r4a-achados-2",
  tags: ["r4a"],
}, async ({ app, screen }) => {
  await app.open("/conta");
  await expect(screen.getByRole("heading", { name: "Início" })).toBeVisible();
  await screen.getByRole("button", { name: MENU }).tap();
  await expect(
    screen.getByRole("menuitem", { name: "Ajuda e contato" })
  ).toBeVisible();
  await expect(
    screen.getByRole("menuitem", { name: "Minha conta" })
  ).toBeHidden();
});
