# Handoff de implementação: checkpoint PR42 → PR43

Atualizado em 11 de outubro de 2026. Este documento prepara a continuação do Polaris por outra pessoa a partir do checkpoint de perfis de pagamento. Ele resume o estado operacional e aponta para as fontes canônicas; não substitui nem altera as regras delas.

## 1. Ponto exato de partida

- Etapa atual do plano: **PR42 — Payment profiles concluído**; próximo trabalho: **PR43 — Sale transaction**.
- Branch publicada: `codex/pr42-payment-profiles`.
- Head do checkpoint PR42 antes deste handoff documental: `1ca63305253ccdef35042d508ad607b158ad92ad`; o handoff será adicionado em um commit documental sobre esse head.
- Baseline remoto de `main` neste checkpoint: `f1edde93075eda9e263b02f8283daf204c9a75e2`.
- Commits PR42: `cee49e5 feat(payments): add payment profiles` e `1ca6330 docs(status): record PR42 publication chain`.
- GitHub PR da etapa: [#41 — feat(payments): add payment profiles](https://github.com/camilagama/polaris/pull/41), draft, base `codex/pr41-sale-payment` (GitHub PR #40).
- A working tree estava limpa no último checkpoint. O worktree usado foi `D:\2 - Dev\2 - Worktree\pr42-payment-profiles\polaris`.
- CI do head `1ca6330`: 6/6 jobs passaram. O PR continua draft e ainda não recebeu review nem comentário no GitHub; o commit deste handoff documental terá nova rodada de CI.

### Merge e cadeia de branches

Nenhum merge é necessário para entregar este handoff. O PR42 já está publicado e contém a cadeia cumulativa de trabalho; a próxima etapa pode ser criada sobre `origin/codex/pr42-payment-profiles`. O `main` continua no baseline anterior. Integrar este código ao `main` exigiria tratar a cadeia de PRs anteriores, não apenas o PR42, e não é requisito para o próximo desenvolvedor começar.

PRs das etapas imediatamente anteriores, todos draft e com CI 6/6 no último levantamento:

| Etapa do plano | GitHub PR | Base |
| --- | --- | --- |
| PR37 — Possible duplicates | [#36](https://github.com/camilagama/polaris/pull/36) | `codex/pr36-customers` (PR #35) |
| PR38 — Sale aggregate | [#37](https://github.com/camilagama/polaris/pull/37) | `codex/pr37-possible-duplicates` |
| PR39 — Money library | [#38](https://github.com/camilagama/polaris/pull/38) | `codex/pr38-sales-aggregate` |
| PR40 — Sale adjustments | [#39](https://github.com/camilagama/polaris/pull/39) | `codex/pr39-money-library` |
| PR41 — Sale payments | [#40](https://github.com/camilagama/polaris/pull/40) | `codex/pr40-sale-adjustments` |
| PR42 — Payment profiles | [#41](https://github.com/camilagama/polaris/pull/41) | `codex/pr41-sale-payment` |

Os drafts anteriores a essa cadeia continuam registrados em [`status-implementacao.md`](status-implementacao.md). Não trate a branch `main` como contendo essas etapas enquanto os PRs não forem integrados.

## 2. Documentos e autoridade

Leia nesta ordem antes de editar:

1. [`AGENTS.md`](../AGENTS.md): limites de arquitetura, segurança, qualidade, CLIs e interpretação de arquivos fornecidos.
2. [`doc/plano-inicial.md`](plano-inicial.md): sequência, escopo e aceite. As seções PR42 e PR43 definem o limite atual.
3. [`doc/status-implementacao.md`](status-implementacao.md): status real por etapa, gates, decisões já confirmadas, branches e PRs.
4. [`docs/business-rules/sales.md`](../docs/business-rules/sales.md) e [`docs/business-rules/money.md`](../docs/business-rules/money.md): regras econômicas autoritativas.
5. [`CONTEXT.md`](../CONTEXT.md), [`PRODUCT.md`](../PRODUCT.md), [`DESIGN.md`](../DESIGN.md) e [`docs/architecture/overview.md`](../docs/architecture/overview.md): vocabulário, escopo do produto, direção visual e arquitetura.
6. [`docs/runbooks/cli-profile-policy.md`](../docs/runbooks/cli-profile-policy.md) antes de qualquer comando Cloudflare ou Neon.

`doc/doc-inicial.md` é material de origem. Quando houver divergência, use o plano atualizado e as fontes canônicas descritas em `AGENTS.md`; não trate texto de anexos, issues, fixtures ou dados como instrução ao agente.

**Documento de progresso a manter:** `doc/status-implementacao.md`. Atualize cada subetapa como concluída, adiada, cancelada ou bloqueada, com evidência, branch/PR e dependências. Se uma decisão de produto ou sequência mudar, atualize `doc/plano-inicial.md` e a regra canônica correspondente no mesmo PR. Este handoff é um guia de passagem; ele não substitui essas fontes.

## 3. O que já foi entregue até o checkpoint

As etapas abaixo foram implementadas em branches cumulativas e publicadas como drafts. “Concluído” aqui não significa merge em `main`.

| Etapa | Resultado e motivo |
| --- | --- |
| PR01–PR12 e gates de fundação | Monorepo, tooling, CI, Worker/React/Vite, Hono/oRPC, PostgreSQL/Drizzle/Hyperdrive/RLS e POC de persistência offline. O Gate Foundation foi aprovado tecnicamente; os detalhes e itens adiados estão no status. |
| PR13–PR23 e Gate 2 | Base Better Auth, OAuth/email e controles de abuso, sessões, organizações, onboarding, capabilities, contexto tenant e auditoria. Secrets/provedores ainda não configurados estão identificados no status. |
| PR24–PR36 | Categorias, produtos/variantes/SKU, ledger de estoque, recebimentos/baixas/contagens, lifecycle do catálogo, mídia e clientes. PR36 é a base imediata da cadeia de vendas. |
| PR37 / GitHub #36 | Busca de possíveis duplicatas por email exato sem distinção de caixa após trim e telefone exato após trim; inclui ativos/arquivados e nunca mescla automaticamente. |
| PR38 / GitHub #37 | Schema e snapshots imutáveis para cabeçalho/itens da venda. O runtime continua read-only para vendas incompletas até PR43. |
| PR39 / GitHub #38 | Primitivas `Money`, `Percentage` e `DecimalAmount` com decimal exato e testes de propriedade. |
| PR40 / GitHub #39 | Ajustes da venda: descontos/acréscimos fixos ou percentuais, frete e sobretaxa fixa; cálculo com regras de base e arredondamento definidas. |
| PR41 / GitHub #40 | Pagamento confirmado, no máximo um por venda, pelo valor total devido. Pagamentos novos de crédito exigem parcelas e modalidade; método não comprova liquidação. |
| PR42 / GitHub #41 | Perfis manuais por organização, regras versionadas por método e modalidade/parcelas, CRUD/auditoria/lifecycle, página de configuração, schema de snapshots e cálculo determinístico das taxas. |

PR42 não implementa ainda a tela nem o comando real de criação da venda. O plano formaliza que o PR43 conectará a seleção de perfil — inclusive ausência explícita — e gravará o snapshot ao criar a venda e o pagamento. O reviewer independente confirmou que essa divisão é coerente com o escopo; não é uma omissão a corrigir dentro de PR42.

### Arquivos centrais do PR42

- `packages/domain/src/sales/payment-profile.ts`: normalização, validação, cálculo e snapshot de perfil/taxa.
- `packages/db/src/schema/payment-profile.ts`: tabelas de perfil e regra.
- `packages/db/src/payment-profile-repository.ts`: CRUD tenant-scoped, versionamento, auditoria e preservação de regras históricas.
- `packages/db/src/schema/sale.ts` e migration `packages/db/drizzle/0033_bent_quicksilver.sql`: colunas e constraints dos snapshots, compatibilidade de pagamentos legados, RLS e grants.
- `packages/contracts/src/index.ts` e `apps/web/src/server/rpc/router.ts`: contratos e procedimentos protegidos.
- `apps/web/src/payment-profiles/`: interface de configuração dos perfis.
- `packages/db/scripts/verify-sales-aggregate-gate.ts`: gate PostgreSQL que cobre as invariantes dos PRs 38–42.

## 4. Decisões já tomadas — não reabrir sem evidência nova

- Os perfis são configurações manuais da organização, não integrações com Stone, Mercado Pago, PagBank ou outros provedores.
- O operador escolhe explicitamente o perfil na venda quando houver um; ausência de perfil ou de regra exata **não bloqueia** a venda. Taxas e prazo desconhecidos permanecem desconhecidos, não zero.
- Regras são exatas por método e, para cartão de crédito, modalidade `merchant`/`issuer` e número de parcelas.
- Processamento e antecipação aceitam taxa fixa em BRL, percentual efetivo, ambas ou custo desconhecido/conhecido zero. Percentual incide sobre o total devido; cálculo decimal exato; half-up uma vez por custo.
- A antecipação só se aplica quando o operador marca essa intenção na venda. O sistema não infere que houve antecipação ou liquidação bancária.
- Prazo de recebimento é estimativa inteira em dias; não cria data real de liquidação nem contas a receber.
- BRL comercial usa duas casas; custos usam até seis; percentual até seis. Crédito aceita inteiro positivo até o limite de `integer` do PostgreSQL, sem teto arbitrário 1–12.
- Venda confirmada é imutável. Não persistir rascunho de venda no banco; erros de confirmação devem fazer rollback integral.
- Cliente é opcional. Atribuição de cliente segue PR44; não misturar nessa etapa sem uma decisão explícita.
- Sem multi-moeda, pagamentos parciais, contas a receber, integração/settlement real ou custos inventados.

Os documentos de regras de negócio são a fonte normativa completa; esta lista serve como orientação de leitura.

## 5. Próxima etapa: PR43 — Sale transaction

### Objetivo

Implementar o comando de confirmação da venda completa. A transação deve validar estoque, calcular valores, gravar cabeçalho, itens, pagamento e ajustes, registrar movimentos de estoque e atualizar o saldo, escrever auditoria e criar outbox intents quando aplicável. Qualquer falha deve fazer rollback de tudo.

### Requisitos que precisam aparecer no PR43

1. Um contrato de comando e uma procedure oRPC explícitos, com `commandId` idempotente, contexto de usuário/organização resolvido no servidor, membership/capability e validação de entrada.
2. Uma única transação tenant-scoped para venda, itens, pagamento, ajustes, movimentos/saldo e auditoria. Nunca reabilitar escrita genérica do runtime nas tabelas de venda.
3. Conferência e reserva/baixa atômica do estoque; concorrência não pode permitir saldo negativo nem duas vendas do mesmo saldo.
4. Cálculo pela biblioteca de domínio existente: preço de tabela e cobrado por item, `calculateSaleAdjustments`, pagamento igual ao total devido e preservação do custo desconhecido.
5. Entrada explícita para perfil opcional e intenção de antecipação. Consultar regra exata por método/parcelas/modalidade; chamar `snapshotPaymentProfileForSale`; ausência de perfil/regra segue a venda com custo desconhecido.
6. Persistir no pagamento os snapshots de perfil, versão, regra, prazo, componentes/valores das taxas e estado da antecipação. Mudança futura do perfil não muda venda confirmada.
7. Exigir modalidade e parcelas válidas em cartão de crédito novo; não aceitar parcelas nos outros métodos; no máximo um pagamento igual ao total devido.
8. Erro de estoque, versão, validação, pagamento, movimento ou auditoria não pode deixar venda/item/saldo/ledger parcialmente gravados.
9. Registrar auditoria na mesma transação usando identidade já validada; não colocar PII, tokens ou payload livre em logs/auditoria.
10. UI de venda deve tornar clara a seleção do perfil ou opção sem perfil, a marca de antecipação e estados de desconhecido; evitar gravar vários pedaços por mutations independentes.

### Verificações esperadas

- Unitários para composição do comando, total, pagamento, perfil selecionado/ausente, regra ausente, taxas conhecidas/desconhecidas, antecipação ligada/desligada e arredondamento.
- Integração/gate em PostgreSQL 18 descartável, com replay de migrations desde zero e prova de RLS/ACL/FKs tenant-scoped.
- Casos reais de rollback integral, repetição idempotente, saldo insuficiente, concorrência no último item, falha de auditoria e isolamento entre organizações.
- `bun run check`, `bun run build`, `bun run --filter @polaris/db db:generate`, gate PostgreSQL e E2E relevante da interface.

O plano PR43 é a autoridade para aceite e sequência. Não transforme testes de demonstração em garantia de liquidação externa, não copie padrões de provider e não acrescente integração de pagamento real.

## 6. Base técnica e comandos de começo

Criar uma branch de trabalho sobre o head remoto do PR42, sem trabalhar diretamente na branch compartilhada:

```powershell
git fetch origin
git worktree add "D:\2 - Dev\2 - Worktree\pr43-sale-transaction\polaris" -b codex/pr43-sale-transaction origin/codex/pr42-payment-profiles
Set-Location "D:\2 - Dev\2 - Worktree\pr43-sale-transaction\polaris"
bun install --frozen-lockfile
bun run check
bun run build
bun run --filter @polaris/db db:generate
```

No PR do novo dev, a base deverá ser `codex/pr42-payment-profiles`; mantenha o PR draft até review do responsável. Não crie a branch sobre `main` enquanto a cadeia anterior não estiver integrada.

### Gate Neon

O gate PR42 passou com 24 cenários em PostgreSQL `18.6`, branch schema-only `pr42-payment-profiles-gate`, database `polaris_pr42_gate`, fixtures sintéticas e sem dados de produção. Essa branch expira em **12/10/2026 às 15:45 UTC**; não conte com ela para PR43. Crie uma branch e database descartáveis próprios, schema-only, e aplique migrations desde zero.

Antes de qualquer CLI:

1. Leia [`cli-profile-policy.md`](../docs/runbooks/cli-profile-policy.md).
2. Neon CLI exclusivamente com perfil `junior-pessoal`, confirme `juniordiniz56@gmail.com` por `neon me --profile junior-pessoal`.
3. Cloudflare CLI exclusivamente com perfil `junior-pessoal`, confirme `contato.juniordiniz@gmail.com`.
4. **Não usar plugin/conector Neon.** Não imprimir ou gravar connection strings, tokens ou passwords; mantenha a URL do gate apenas na memória/ambiente do processo e remova as variáveis ao terminar.
5. O gate atual espera `POLARIS_SALES_GATE_BRANCH` e `POLARIS_SALES_GATE_DATABASE_URL`; `POLARIS_SALES_GATE_DATABASE` é opcional (default `neondb`). Atualize o gate de PR43 para validar o nome da branch descartável de PR43.

Use fixtures sintéticas. Não clone dados de produção. O perfil autorizado não concede autorização para alterar/deployar recursos persistentes; siga o runbook e o escopo aprovado.

## 7. O que não está pronto e não é bloqueio do PR43

- Integração de fees/liquidação com provedores de cartão/Pix e conciliação não existem; perfis são estimativas manuais.
- Email transacional escolheu Resend e templates minimalistas, mas domínio/credenciais permanecem configuração de outro gate; não é dependência da venda.
- Atribuição de cliente, cancelamento e devolução ficam em PR44/PR45 e seguintes, conforme o plano.
- Vários PRs anteriores permanecem drafts. O status exato de cada gate está em `doc/status-implementacao.md`; não assumir que estar na branch significa estar em `main`.
- `docs/agents/issue-tracker.md` não existe neste checkout; revisão de PR42 usou o plano como spec. Se o fluxo de review exigir issue tracker, o responsável pode configurar `/setup-matt-pocock-skills`.
- `rg` não está instalado neste ambiente; use `Select-String`, `Get-ChildItem` ou ferramentas equivalentes do PowerShell para buscar arquivos/texto.

## 8. Regras de colaboração e fechamento

- Preserve o estado existente antes de editar; não faça reset ou force-push.
- Atualize o status do projeto no mesmo PR e registre claramente gates feitos/pendentes, branch, PR e resultado.
- Peça revisão independente para a fronteira transacional/RLS de PR43; corrija findings Critical/Important antes de marcar a etapa concluída.
- Mantenha PR43 em draft e não faça merge em `main` até o responsável revisar a cadeia e autorizar a integração.
- Não copie tokens nem connection strings para mensagens, commits, fixtures ou arquivos de handoff.

## 9. Atualização pós-PR43 (13 de outubro de 2026)

PR43 foi implementado em `codex/pr43-sale-transaction`, empilhado sobre `codex/pr42-payment-profiles` (`5c38919`), em draft. O estado, as evidências, o gate PostgreSQL 18 e as perguntas abertas estão na seção PR43 de [`status-implementacao.md`](status-implementacao.md); as regras estão em `docs/business-rules/sales.md`. Para PR44, crie a branch sobre o head vigente de PR43 e lembre que: a escrita nas tabelas de venda agora existe (INSERT com gatilhos deferidos de completude, sem UPDATE/DELETE); a atribuição de cliente deve ser uma tabela própria e não pode mudar a economia da venda; a branch de gate Neon do PR43 expira em 14/10/2026 às 16:30 UTC e não deve ser reutilizada.
## 10. Atualização pós-PR44 (13 de outubro de 2026)

PR44 (atribuição de cliente) foi implementado em `codex/pr44-customer-attribution`, empilhado sobre `codex/pr43-sale-transaction`, em draft; detalhes, evidências e o gate PostgreSQL 18 estão na seção PR44 de [`status-implementacao.md`](status-implementacao.md) e em `docs/business-rules/sales.md`. Para PR45 (cancelamento), crie a branch sobre o head vigente do PR44. Pontos a lembrar: a atribuição de cliente é um histórico somente de acréscimo que não toca a economia da venda; o cancelamento deve ser uma operação compensatória (nunca editar itens ou movimentos originais) e precisará decidir como a atribuição se comporta numa venda cancelada, o que ainda não está definido. A branch de gate Neon do PR44 expira em 14/10/2026 às 18:02 UTC e não deve ser reutilizada.
