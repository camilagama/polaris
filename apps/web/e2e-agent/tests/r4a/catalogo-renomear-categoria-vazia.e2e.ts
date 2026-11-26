import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Ao renomear uma categoria e apagar o nome, Salvar não diz nada.
 * Esperado: "Informe o nome da categoria.", como no campo "Nova categoria".
 */
const ADD = /^Adicionar categoria$/;
const MORE = /^Mais ações para Acessórios QA/;
const RENAME_FIELD = /^Novo nome para Acessórios QA/;
const REQUIRED = "Informe o nome da categoria.";
test("renomear a categoria com o nome vazio diz que o nome é obrigatório", {
  session: "bb-r4a-achados-1",
  tags: ["r4a"],
}, async ({ app, screen }) => {
  await app.open("/products?aba=categorias");
  await screen.getByLabel("Nova categoria").fill("Acessórios QA");
  await screen.getByRole("button", { name: ADD }).tap();
  await screen.getByRole("button", { name: MORE }).tap();
  await screen.getByRole("menuitem", { name: "Renomear" }).tap();
  await screen.getByLabel(RENAME_FIELD).clear();
  await screen.getByRole("button", { exact: true, name: "Salvar" }).tap();
  await expect(screen.getByText(REQUIRED)).toBeVisible();
});

test("controle: a criação com o nome vazio diz que o nome é obrigatório", {
  session: "bb-r4a-achados-1",
  tags: ["r4a"],
}, async ({ app, screen }) => {
  await app.open("/products?aba=categorias");
  await screen.getByRole("button", { name: ADD }).tap();
  await expect(screen.getByText(REQUIRED)).toBeVisible();
});
