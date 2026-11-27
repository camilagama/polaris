# Produtos

Produtos (`/products`) é o catálogo: a lista de produtos (ativos e arquivados), o Dialog "Novo produto", que cria o produto com preço e estoque de abertura num passo só, o Dialog "Importar planilha" (CSV) e a aba Categorias (`/products?aba=categorias`).

## Sub-features

- `produtos-lista` a `list "Produtos cadastrados"` (o `h2` da moldura nomeia a lista), cada produto um item `[data-product-id]`: a linha é o botão "Editar <nome>" (`[data-row-open]`, abre o produto em Dados) e, ao lado, "Mais ações para <nome>" (Variantes, Imagens, Arquivar; no arquivado, Variantes, Restaurar e, em grupo separado, Excluir…). Ao lado do título da moldura, a contagem ("1.248 produtos", `[data-list-count]`); com mais de 50, "Carregar mais" abaixo da moldura. Carregando, a moldura fica com linhas-esqueleto e "Carregando…" só para o leitor de tela.
- `produtos-vazio` loja sem produto: "Nenhum produto ainda", só a frase no vazio; o "Novo produto" único está na linha do título.
- `produto-ver-estoque` no rodapé do diálogo de um produto que existe, o link "Ver estoque" (só com `inventory:read`) fecha o diálogo (o que foi digitado fica guardado, como no Esc) e abre o [Estoque](estoque.md) sem recarregar a página, com a busca já com o nome do produto. O diálogo abre também por `/products?produto=<id>`, e com `&variante=<id>` o campo "SKU · <variante>" da aba Variantes recebe o foco; é o caminho de volta do nome do produto na linha do Estoque.
- `produto-excluir` aba "Arquivados", menu "Mais ações para <nome>" → "Excluir…" (só no arquivado; sem conexão fica desligado): o diálogo "Excluir produto “<nome>”?" pede o nome em "Digite o nome do produto para confirmar" (sem diferenciar maiúsculas nem espaços repetidos) e só então "Excluir produto" age; "Manter arquivado", Esc e clicar fora fecham sem excluir. Recusas dentro do diálogo: saldo ("ainda tem N em estoque", link "Ir ao Estoque"), teto de 50 por hora (a hora de tentar de novo; o drive o simula com `page.route` porque 50 exclusões não cabem na pilha local) e produto mudado. Sucesso: aviso "Produto “<nome>” excluído." e a vaga volta. Prova: `apps/web/e2e-real/jornadas/excluir-produto-arquivado.e2e.ts`.
- `produto-criar` Dialog "Novo produto": nome, preço de tabela, quantidade e custo; "Mais detalhes" para categoria e descrição.
- `produto-limite` plano Free no teto de 50 variantes: o Dialog recusa com "Seu plano chegou ao limite de variantes. Nada foi cadastrado."
- `produto-aviso-limite` plano Free a partir de 90% do limite (45 de 50): linha de texto de apoio `[data-near-limit]` no fim da lista de Produtos, abaixo dos botões do formulário de variantes e abaixo de "Enviar imagem" ("Você usa 47 de 50 variantes no plano Free." + "Conhecer o Pro"; no limite, "Você chegou ao limite de 50 variantes do plano Free."). Só o dono, só online; nunca junto da recusa. Com arquivados sem estoque (`usage.freeable.products > 0`), um segundo parágrafo `[data-near-limit-freeable]` no aviso de variantes: "Você tem N produtos arquivados sem estoque. Excluir libera vaga." com o link "Ver arquivados" (`/products?arquivados=1`: abre Produtos já em Arquivados, com o foco na aba, sem recarregar; dentro do diálogo de variantes ele fecha o diálogo antes); em Arquivados a linha vem sem o link.
- `produto-importar` Dialog "Importar planilha", em 4 passos: Arquivo, Prévia, Importando, Resultado.
- `produtos-busca` `searchbox "Buscar produto"`; sem resultado: "Nenhum produto com “…”".
- `categorias` aba Categorias (a lista na moldura "Categorias cadastradas"): "Nova categoria", "Adicionar categoria", abas "Ativas", "Arquivadas" e "Removidas".

## How to get to it (user POV)

- Desktop: link `Produtos` do menu "Principal" (grupo "Catálogo").
- Celular: botão "Mais" da barra "Destinos", depois o link `Produtos` dentro do Dialog "Mais".
- Início da loja vazia: "Cadastrar à mão" (`/products?novo=1`, abre o Dialog) e "Importar planilha" (`/products?importar=1`).
- Aba Categorias: `tab "Categorias"` ou `/products?aba=categorias` (a primeira aba, `/products?aba=produtos`, é o mesmo que `/products`).
- Pelo link "Ver arquivados" do aviso de limite (`/products?arquivados=1`, a lista já na aba "Arquivados").
- Pelo nome do produto na linha do Estoque (`/products?produto=<id>`, e `&variante=<id>` para a linha de uma variante).
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
- A importação vai a uma linha a cada 7 s: use poucas linhas por drive. A pausa do regime do plano Free ("O servidor está ocupado. A importação continua sozinha às HH:MM.", com "Parar a importação") não acontece no workerd local: responda a uma chamada de `product/importBatch` com a página da plataforma (`page.route`, 503 com `cf-ray`, sem a marca do Worker) e diga isso na evidência.
- O CSV é gerado no drive; não há planilha de exemplo versionada. Nome que já existe na loja entra como "já existe", não como erro.
- Com o Dialog modal aberto, o resto da página sai da árvore de acessibilidade: `getByRole` de fora do Dialog não acha nada até ele fechar.
