---
status: accepted
---

# Coleções locais por usuário e organização, e bootstrap consistente

## Contexto

O PR50 do plano cria as coleções locais (categorias, produtos, variantes, estoque, clientes e vendas recentes) e o bootstrap inicial, sem mutações offline. O [ADR 0015](0015-offline-persistence-tanstack-db-opfs-indexeddb.md) já escolheu TanStack DB sobre SQLite WASM em OPFS e exige namespace por usuário e organização, falha explícita e nenhum descarte silencioso de dados. O [ADR 0030](0030-change-log-de-sincronizacao.md) entrega o cursor do change log. Faltava decidir o formato dos dados locais, como um snapshot de várias páginas fica consistente e como o namespace é apagado.

## Decisão

- **Uma base OPFS por usuário e organização.** O nome do arquivo e o do coordenador derivam de um hash SHA-256 de `(usuário, organização)` com prefixo de comprimento, nunca dos ids crus. Outro usuário ou outra organização no mesmo navegador abre outra base e não enxerga a anterior. Apagar o namespace remove o arquivo (e os auxiliares `-journal`, `-wal`, `-shm`) depois de fechar a base; é o gancho para o logout e para "sair da organização".
- **Seis coleções, modelos de leitura próprios e menores.** `categories`, `products`, `variants` (com opções e preço de tabela), `inventory` (saldo por variante), `customers` e `recentSales` (as 100 vendas mais recentes, vindas de `sale.list`). Instantes como texto ISO; **nunca** custo médio, dados de auditoria nem o id da organização. Mais uma coleção de metadados (`syncMeta`) guarda `status`, `cursor` e `bootstrappedAt`.
- **Bootstrap em três tempos, idempotente.** (1) registra `sync.getCursor` **antes** de ler qualquer coisa; (2) lê cada coleção por páginas com posição por chave (`sync.bootstrapPage`, páginas de até 500), substitui as linhas locais e apaga as linhas locais que o servidor não tem mais; (3) faz `sync.pull` a partir do cursor registrado e rele só o que mudou. Reaplicar é seguro, então mudanças que chegam durante o snapshot não se perdem. Variantes são relidas **por produto** (uma mudança de produto move as variantes junto); mudanças de `sale` renovam a janela de vendas recentes uma vez; `payment_profile` é ignorado até existir coleção local para ele.
- **Estado explícito e retomável.** O armazenamento fica `bootstrapping` até o fim; uma execução interrompida deixa esse estado, e a próxima começa de novo. Só `ready` com cursor e versão conhecidos conta como pronto. O avanço do cursor é gravado a cada página aplicada.
- **Orquestração desacoplada.** `bootstrapLocalStore` e `pullLocalChanges` falam com duas interfaces pequenas (fonte e escritor), então rodam igual contra o servidor real, o OPFS e os falsos dos testes. Os testes unitários provam páginas, remoção de obsoletos, mudanças durante o snapshot, interrupção, chunks de ids e a renovação única de vendas; um gate no navegador prova o disco.
- **Falha fechada.** Sem contexto seguro ou OPFS o armazenamento não abre (sem queda silenciosa para memória ou `localStorage`); uma incompatibilidade de schema da coleção falha em vez de apagar (`schemaMismatchPolicy: sync-absent-error`).
- **Ainda não está montado no aplicativo.** O módulo e o laboratório existem e estão provados em Chromium (desktop e Pixel 5 emulado); o worker OPFS de cerca de 1,6 MiB só carrega sob demanda, então a montagem no shell fica para a primeira tela offline (a partir do PR52), junto com o logout seguro com comandos pendentes.

## Consequências

- Os PRs seguintes (outbox, `sync.push`, comandos offline) leem das coleções locais sem redesenhar o domínio nem o protocolo.
- O custo de um bootstrap é proporcional ao catálogo: páginas de 200 linhas por padrão; catálogos muito grandes pedirão progresso visível na interface.
- O cursor só avança com dados aplicados; um cursor perdido ou um armazenamento `bootstrapping` força um bootstrap completo, nunca um estado parcial presumido pronto.
- Android Chrome real e Edge real continuam sem prova (ADR 0015): a emulação não substitui o aparelho, e isso bloqueia o PR52.

## Alternativas rejeitadas

- **Uma base única por navegador, com a organização como coluna:** um erro de filtro vazaria dados entre usuários; arquivos separados tornam o isolamento estrutural e o apagamento trivial.
- **Snapshot consistente por transação única no servidor:** exigiria uma resposta enorme ou uma transação longa; o cursor mais o pull idempotente dão a mesma garantia com páginas pequenas.
- **Guardar o conteúdo completo no change log:** ver [ADR 0030](0030-change-log-de-sincronizacao.md).
