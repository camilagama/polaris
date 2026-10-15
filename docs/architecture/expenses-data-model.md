# Modelo de dados de despesas

Autoridade: este documento descreve as tabelas, os vínculos e os fluxos de despesas. As regras de negócio vivem em [expenses-and-results.md](../business-rules/expenses-and-results.md) e a razão das escolhas, no [ADR 0051](../adr/0051-despesas-categorias-e-lancamentos.md).

## Tabelas

`expense_categories`: as categorias de despesa da organização.

| Coluna | Observação |
| --- | --- |
| `id` | UUIDv7 gerado pelo banco. |
| `organization_id` | Dono do registro; `ON DELETE CASCADE`. |
| `group_key` | Um de `commercial`, `operational`, `financial`, `taxes`, `other`. Não muda. |
| `name` | 1 a 100 caracteres. Único por organização sem diferenciar caixa (índice em `lower(name)`). |
| `system_key` | Preenchida só nas categorias padrão; única por organização quando presente. |
| `archived_at` | Categoria arquivada não aceita despesa nova; nunca há exclusão. |
| `version`, `created_at`, `updated_at` | Concorrência otimista e carimbos. |

`expenses`: uma despesa por competência.

| Coluna | Observação |
| --- | --- |
| `id`, `organization_id` | Como acima. |
| `category_id` | Obrigatória; chave composta `(organization_id, category_id)` para `expense_categories`, `ON DELETE RESTRICT`. |
| `amount` | `numeric` maior que zero, no máximo duas casas e abaixo de 10¹⁸ (CHECK). |
| `competence_on` | `date` no calendário da organização, a partir de 2000-01-01 (CHECK). |
| `description`, `payee` | Texto de 1 a 200 e de 1 a 120 caracteres (CHECK); `payee` é opcional. |
| `sale_id` | Opcional; chave composta `(organization_id, sale_id)` para `sales`, `ON DELETE RESTRICT`. |
| `voided_at` | Anulada quando preenchida; sai das listas e dos totais por padrão. |
| `version`, `created_at`, `updated_at` | Como acima. |

Índices: `(organization_id, competence_on, id)` para a lista, `(organization_id, category_id)` e `(organization_id, sale_id)` parcial.

## Segurança

Ambas têm RLS e `FORCE RLS` com a política padrão de tenant ativo (organização e vínculo `active` com organização `active`) para `SELECT`, `INSERT` e `UPDATE`; não há política nem permissão de `DELETE`. O papel de runtime recebe `UPDATE` só nas colunas que os repositórios alteram (`name`, `archived_at`, `updated_at`, `version` nas categorias; `amount`, `category_id`, `competence_on`, `description`, `payee`, `sale_id`, `voided_at`, `updated_at`, `version` nas despesas).

## Fluxos

- **Primeira leitura de uma organização.** Sem nenhuma linha em `expense_categories`, a listagem (ou a criação de uma categoria ou despesa) insere as categorias padrão com `ON CONFLICT DO NOTHING`; duas chamadas simultâneas convergem num só conjunto pelo índice de nome único.
- **Lançar.** Normaliza o valor e o texto no domínio, confere a competência contra o "hoje" da organização, exige categoria ativa e, se houver, venda da organização; insere e grava `expense.created`.
- **Editar.** Bloqueia a linha (`FOR UPDATE`), confere a versão e recusa despesa anulada; se nada mudou, devolve sem mexer; revalida só categoria, competência e venda que mudaram; incrementa a versão e grava `expense.updated`.
- **Anular e reativar.** Mesma trava e versão; repetir não muda nada; gravam `expense.voided` e `expense.restored`.
- **Listar.** Filtra por período, categoria e estado, ordena por competência decrescente e ID decrescente, pagina por cursor `(competence_on, id)` e soma no banco o filtro inteiro (`total` como texto decimal exato).

## Contrato

Procedimentos `expense.*` em `packages/contracts`: `listCategories`, `createCategory`, `renameCategory`, `archiveCategory`, `restoreCategory`, `list`, `create`, `update`, `void`, `restore`. Valores monetários trafegam como texto decimal; datas de competência como `YYYY-MM-DD`; erros de negócio viram `BAD_REQUEST`, `CONFLICT` ou `NOT_FOUND` com o código estável do domínio.
