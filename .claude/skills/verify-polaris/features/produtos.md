# Produtos

Produtos (`/products`) é o catálogo: a lista de produtos (ativos e arquivados), o Dialog "Novo produto", que cria o produto com preço e estoque de abertura num passo só, o Dialog "Importar planilha" (CSV) e a aba Categorias (`/products?aba=categorias`).

## Sub-features

- `produtos-lista` a `list "Produtos"`, cada produto um item `[data-product-id]`, com "Mais ações para <nome>".
- `produtos-vazio` loja sem produto: "Nenhum produto ainda" e o botão "Novo produto" no vazio.
- `produto-criar` Dialog "Novo produto": nome, preço de tabela, quantidade e custo; "Mais detalhes" para categoria e descrição.
- `produto-limite` plano Free no teto de 50 variantes: o Dialog recusa com "Seu plano chegou ao limite de variantes. Nada foi cadastrado."
- `produto-importar` Dialog "Importar planilha", em 4 passos: Arquivo, Prévia, Importando, Resultado.
- `produtos-busca` `searchbox "Buscar produto"`; sem resultado: "Nenhum produto com “…”".
- `categorias` aba Categorias: "Nova categoria", "Adicionar categoria", abas "Ativas", "Arquivadas" e "Removidas".

## How to get to it (user POV)

- Desktop: link `Produtos` do menu "Principal" (grupo "Catálogo").
- Celular: botão "Mais" da barra "Destinos", depois o link `Produtos` dentro do Dialog "Mais".
- Início da loja vazia: "Cadastrar à mão" (`/products?novo=1`, abre o Dialog) e "Importar planilha" (`/products?importar=1`).
- Aba Categorias: `tab "Categorias"` ou `/products?aba=categorias` (a primeira aba, `/products?aba=produtos`, é o mesmo que `/products`).
- O endereço antigo `/categories` abre a aba Categorias.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK. `produto-criar` na loja `vazia`; `produto-importar` na `vendas` (a linha "Caneca esmaltada" do CSV cai em "já existe"); `produto-limite` com `$V seed limite` e `VERIFY_LOJA=limite`.
- Provado: `drives/produtos-criar.verify.ts` (360 e 1280, claro) e `drives/receitas.verify.ts --grep produto-importar`.

- **Chegar pelo menu.** Desktop: `getByRole("navigation", { exact: true, name: "Principal" }).getByRole("link", { exact: true, name: "Produtos" }).click()`. Celular: `getByRole("button", { exact: true, name: "Mais" }).click()` e `getByRole("dialog", { name: "Mais" }).getByRole("link", { exact: true, name: "Produtos" }).click()`. Abre `getByRole("heading", { exact: true, level: 1, name: "Produtos" })` com `tablist "Produtos e categorias"`.
- **Abrir o Dialog.** `getByRole("button", { name: "Novo produto" }).first().click()`; `const dialog = getByRole("dialog", { name: "Novo produto" })`, com "Um passo só: o produto pode nascer com o estoque."
- **Preencher.** `dialog.getByLabel("Nome do produto").fill(...)`, `dialog.getByLabel("Preço de tabela").fill("59,90")`, `dialog.getByLabel("Quantos você tem agora").fill("10")`, `dialog.getByLabel("Custo de cada unidade").fill("12,50")`. Categoria: `getByRole("button", { name: "Mais detalhes" })`, depois o combobox "Categoria" e a opção.
- **Cadastrar.** `dialog.getByRole("button", { name: "Cadastrar produto" }).click()`. O Dialog fecha e `page.locator("[data-product-id]", { hasText: nome })` aparece na lista.
- **Persistência.** `page.reload()` e o mesmo `[data-product-id]` continua lá; `$V sql "SELECT p.name, v.list_price::text, b.quantity FROM products p JOIN product_variants v ON v.product_id = p.id LEFT JOIN inventory_balances b ON b.variant_id = v.id WHERE p.name LIKE 'Camiseta%'"` mostra preço `59.90` e saldo 10.
- **Limite do Free.** Na loja `limite`, o mesmo Dialog com nome "Produto 51" e "Cadastrar produto": `dialog.getByRole("alert")` diz "Seu plano chegou ao limite de variantes. Nada foi cadastrado." e o Dialog fica aberto.
- **Importar.** `getByRole("button", { name: "Importar planilha" }).click()`; `dialog "Importar planilha"` mostra "Passo 1 de 4 · Arquivo" e o foco em "Escolher arquivo". Arquivo: `dialog.locator('input[type="file"]').setInputFiles({ buffer, mimeType: "text/csv", name: "produtos.csv" })` com o cabeçalho `Nome;Preço de tabela;Quantidade;Custo de cada unidade` e linhas como `Boné;39,90;4;10,00`. "Ver a prévia" → "Passo 2 de 4 · Prévia" (contagens "N vão entrar", "1 já existe (fica como está)", "1 com erro (não entra)" e a tabela "Linhas do arquivo: Com erro"). `getByRole("button", { name: /^Importar 1 produto/ })` → `status` "Importamos 1 produto…".
- **Categorias.** `/products?aba=categorias`: `getByLabel("Nova categoria").fill("Camisetas")`, `getByRole("button", { name: "Adicionar categoria" })`, e o `status` "Categoria “Camisetas” criada." (`apps/web/e2e-real/jornadas/produto.e2e.ts`).
- **Prova.** `evidence.shot` antes ("produtos-antes"), com o Dialog preenchido ("produtos-dialog"), depois ("produtos-depois") e depois de recarregar ("produtos-recarregado").

## Gotchas

- O `h1` é "Produtos" (a aba e o `h2` também se chamam "Produtos"): use `exact: true` e `level: 1`.
- Há dois "Novo produto" na loja vazia (o do topo e o do vazio): `.first()`.
- No celular, Produtos não está na barra de baixo: só pelo "Mais" (a barra marca "Estoque" como a área).
- "Importar planilha" fica desligado sem conexão, com o motivo "Importar planilha precisa de conexão.": é `aria-disabled`, e o `click()` do Playwright espera até estourar o tempo; use `click({ force: true })` para provar que nada abre.
- O CSV é gerado no drive; não há planilha de exemplo versionada. Nome que já existe na loja entra como "já existe", não como erro.
- Com o Dialog modal aberto, o resto da página sai da árvore de acessibilidade: `getByRole` de fora do Dialog não acha nada até ele fechar.
