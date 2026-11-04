---
status: accepted
---

# Change log de sincronização com sequência por organização atribuída no commit

## Contexto

O plano (PR51) pede `sync_changes` com sequência monotônica, registrada na mesma transaction do domínio, e `sync.pull(cursor)`. O pull incremental só é correto se um leitor que avançou o cursor até N nunca perder uma mudança de número menor que ainda não tinha feito commit. Um `serial` ou `sequence` do PostgreSQL não garante isso: um valor é alocado no início da transação, e uma transação lenta pode terminar depois de outra que recebeu um número maior, deixando um buraco que o leitor já passou. O [ADR 0003](0003-offline-command-protocol.md) já fixou que o pull usa um cursor de change log mantido pelo servidor.

## Decisão

- **Registro por gatilho, não por código.** Triggers `AFTER INSERT OR UPDATE` nas tabelas de domínio inserem a mudança na transação do escritor, de modo que qualquer caminho de escrita (repositório, SQL manual, função) deixa rastro e nenhum comando esquece de registrar. Entidades: `category`, `product` (inclui as variantes e opções, que mudam junto com a versão do produto), `inventory_balance` (por variante), `customer`, `payment_profile` (perfil e regras) e `sale` (a venda, o cancelamento, as devoluções e o vínculo de cliente).
- **Sequência por organização atribuída no COMMIT.** Um constraint trigger adiado numera as mudanças pendentes da transação, travando a linha do contador da organização (`sync_cursors`) até o fim do commit. A ordem da sequência é, portanto, a ordem de commit: quando um leitor enxerga a mudança N, já enxergou todas as menores, e uma página sempre continua exatamente onde a anterior parou. Sem buracos e sem números consumidos por transações revertidas. Escritores da mesma organização só se serializam no instante do commit.
- **Escrita só por funções `SECURITY DEFINER`.** O runtime de tenant tem somente `SELECT` em `sync_changes` (com RLS pela organização ativa) e nenhum acesso a `sync_cursors`: não pode forjar, editar nem apagar mudanças. Um gatilho torna a mudança append-only mesmo para o dono (a única atualização permitida é a atribuição da sequência).
- **O log carrega chaves, não conteúdo.** Cada mudança diz `(tipo de entidade, id, seq)`. O pull devolve cada entidade uma vez por página, na sua maior sequência, e avança o cursor até a última sequência da página. O conteúdo atual da entidade é buscado pelo cliente (coleções locais, PR50b), o que evita copiar dados para o log e mantém um único modelo de leitura.
- **Cursor.** Inteiro não negativo, trafegado como texto decimal. `sync.getCursor` devolve a última sequência confirmada; o dispositivo a registra **antes** de ler um snapshot e depois faz pull a partir dela: mudanças que chegam durante a leitura são reaplicadas de forma idempotente e nenhuma se perde.
- **Capability `sync:read`** (owner) para `sync.getCursor` e `sync.pull`, dentro de uma transação tenant que já autorizou membership e organização. Páginas de até 500 mudanças (padrão 200).

## Consequências

- O bootstrap (PR50b) pode ser consistente sem congelar o banco: cursor, snapshot por páginas, pull a partir do cursor.
- Cada escrita de domínio ganha uma inserção a mais e, no commit, uma atualização do contador; para o volume de um comércio pequeno o custo é aceitável, e o lock curto no commit é o preço da ordem correta.
- Não há retenção nem compactação do log: crescer sem limite é aceitável antes do lançamento; quando houver podagem será preciso um piso de cursor e a resposta "cursor antigo demais, refaça o bootstrap" (registrado no backlog).
- Tabelas novas de domínio que o dispositivo precisa ver exigem um trigger e uma entrada no `CHECK` de tipos; o gate cobre as atuais.
- Mudanças de outras organizações nunca aparecem: a RLS e o filtro por organização valem para a leitura.

## Alternativas rejeitadas

- **`sequence` global ou por organização via `nextval`:** buracos e ordem diferente do commit; o leitor poderia pular mudanças.
- **Cursor por `xmin`/snapshot (`pg_current_snapshot`):** correto, mas amarra o protocolo a detalhes do PostgreSQL e dificulta paginar de forma estável.
- **Registrar no código dos repositórios:** qualquer escrita nova ou manual poderia esquecer de registrar; o gatilho elimina a classe de erro.
- **Gravar o conteúdo da entidade no log:** duplica dados (inclusive pessoais) e cria um segundo modelo de leitura.

## Emenda: as imagens do produto e a capa (migration 0111)

**Contexto.** O produto passa a levar `coverAssetId`, a imagem `product_media` de menor posição, no modelo de leitura e na cópia do aparelho (corte das miniaturas). A capa não é coluna: a leitura a calcula (`LEFT JOIN LATERAL … ORDER BY position LIMIT 1`, no índice único `(organization_id, product_id, position)`). Enviar, reordenar ou remover uma imagem muda a capa sem escrever em `products`, então o log não ficava sabendo.

**Decisão.**

- **Três gatilhos por comando em `product_media`** (`AFTER INSERT`, `AFTER UPDATE` e `AFTER DELETE`, `FOR EACH STATEMENT`, com as tabelas de transição) chamam `record_product_media_sync_change()` e gravam uma mudança `product` por produto que o comando tocou. O `DELETE` lê a tabela `OLD`. O gatilho por linha de sempre (`record_sync_change`) não serve: ele só lê `NEW` e a reordenação faz dois `UPDATE` em todas as imagens do produto (afastar e assentar), o que daria duas mudanças por imagem.
- **Uma mudança por operação.** O `UPDATE` que só afasta as imagens (toda posição nova em 1.000.000 ou acima, o `REORDER_OFFSET` de `media-repository.ts`) não grava nada: ele mantém a ordem e vem sempre seguido, na mesma transação, do que assenta as posições, que grava a mudança. Envio, reordenação e remoção deixam exatamente uma mudança; um `UPDATE` de posições fora dos comandos grava uma; uma remoção que não remove nada não grava. O purge de uma loja apaga `product_media` num comando só e grava uma mudança por produto, que o próprio purge apaga em seguida com o resto do log.
- **Sem `products.version`.** A capa não soma versão: uma reordenação de imagem não conflita com uma edição do produto feita sem conexão (`expectedVersion` antigo continua valendo).
- **Mesmo dono, nenhum privilégio novo.** A função é `SECURITY DEFINER` do `polaris_sync_owner`, como as outras duas do log ([ADR 0093](0093-funcoes-security-definer-e-privilegios-padrao.md), emenda da 0095), grava o escopo da organização antes de cada inserção e lê só as tabelas de transição, nunca `sync_changes`: o dono continua sem ler a entidade de uma mudança.

**Compatibilidade ([ADR 0096](0096-migrations-compativeis-com-a-versao-anterior-do-worker.md)).** Só expande: uma função e três gatilhos. O Worker anterior escreve `product_media` como antes e o log ganha mudanças `product`, que ele já sabe puxar. O campo é opcional no contrato: um Worker antigo responde sem ele, e o aparelho guarda o que vier.

**Prova.** O gate `product-cover` (`packages/db/scripts/verify-product-cover-gate.ts`, na suíte `ci`).
