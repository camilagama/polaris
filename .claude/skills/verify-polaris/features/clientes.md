# Clientes

Clientes (`/customers`) é a lista de clientes da loja (ativos e arquivados) e o Dialog "Novo cliente". Um cliente pode ser associado a uma venda no detalhe dela.

## Sub-features

- `clientes-lista` a lista e as abas "Ativos" e "Arquivados" (`tablist "Estado dos clientes"`).
- `clientes-vazio` "Nenhum cliente ainda. Cadastre o primeiro em “Novo cliente”."
- `cliente-criar` Dialog "Novo cliente": "Nome", "Telefone", "Email", "Observações"; "Cadastrar cliente".
- `cliente-duplicado` telefone ou e-mail já usado: "Encontramos possíveis clientes existentes. Revise antes de criar um novo.", com "Criar mesmo assim" e "Usar existente: <nome>".
- `cliente-arquivar` arquivar, restaurar e anonimizar pelo item da lista.

## How to get to it (user POV)

- Desktop: link `Clientes` do menu "Principal" (grupo "Catálogo").
- Celular: "Mais" e o link `Clientes`.
- Endereço `/customers`.

## Driving it with verify.sh (Playwright)

Preconditions:

- Doctor OK, qualquer loja (a semeadura não cria cliente).
- Provado: `drives/receitas.verify.ts --grep cliente-criar`.

- **Abrir.** `await page.goto("/customers")`. `getByRole("heading", { level: 1, name: "Clientes" })` e, sem cliente, o parágrafo do vazio.
- **Criar.** `getByRole("button", { name: "Novo cliente" }).first().click()`; no `getByRole("dialog", { name: "Novo cliente" })`: `getByLabel("Nome").fill(nome)` e `getByLabel("Telefone").fill("11 9xxxx-xxxx")` (único por execução); `getByRole("button", { name: "Cadastrar cliente" })`. Aparece `getByRole("status").filter({ hasText: "Cliente “<nome>” cadastrado." })`.
- **Prova.** `evidence.shot("cliente-cadastrado", …)`; o cliente aparece também no combobox "Cliente" do detalhe da venda ("Associar cliente").

## Gotchas

- Só o nome não basta: sem telefone nem e-mail, o Dialog mostra o `alert` "Informe ao menos um telefone ou email para o cliente."
- Repetir o mesmo telefone abre o aviso de possível duplicado em vez de cadastrar; o drive pronto gera um telefone novo a cada execução.
- Sem conexão, com escrita offline, a mensagem é outra: "Cliente “<nome>” salvo neste aparelho. Ele será enviado quando a conexão voltar." (não acontece na loja Free).
