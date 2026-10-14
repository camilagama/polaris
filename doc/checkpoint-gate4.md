# Polaris — checkpoint do Gate 4 (fim da Fase 4)

Este documento é o dossiê para a **revisão completa da implementação, da etapa 1 do plano até aqui**. Ele resume o que existe, o que o projeto decidiu sozinho onde o plano era omisso, o que foi provado e com que evidência, o que ficou de fora e onde estão os riscos. A fonte de verdade continua sendo o código, `docs/business-rules/*`, `doc/plano-inicial.md` e `doc/status-implementacao.md`; este dossiê só aponta para eles.

Nada foi integrado ao `main` nem implantado: todas as etapas continuam em PRs *draft* empilhados.

## 1. Onde estamos

| Fase | PRs | Resultado |
| --- | --- | --- |
| 0 — Repositório e governança | PR01–PR06, Gate 0 | Monorepo (Bun, Turborepo, TypeScript), Biome/Ultracite, Knip e boundaries, documentação canônica, CI, Renovate. |
| 1 — Provas de arquitetura | PR07–PR12, Gate Foundation | Worker + Hono + oRPC, PostgreSQL 18 + Drizzle + Hyperdrive, RLS remoto, POC de persistência offline. |
| 2 — Identidade e acesso | PR13–PR23, Gate Auth, Gate 2 | Better Auth, Google, senha, Turnstile, vínculo de contas, sessões, organizações/memberships, onboarding idempotente, capabilities por papel (só `owner` na V1), transação tenant com RLS, auditoria. |
| 3 — Catálogo, estoque, mídia | PR24–PR35 | Categorias, produtos, variantes, SKU, razão de estoque (custo médio móvel), recebimento, baixa, contagem, arquivar/excluir, mídia privada com derivados e reconciliação. |
| 4 — Clientes e vendas online | PR36–PR47, **Gate 4** | Clientes e possíveis duplicados; agregado de venda; biblioteca de dinheiro; ajustes; pagamentos; perfis de pagamento; **confirmação transacional da venda**; atribuição de cliente; cancelamento; devoluções parciais; datas da venda. |
| 5 — Offline | PR48 em diante | **Não iniciada.** Deve transportar os commands já existentes sem redesenhar o domínio. |

Cadeia de PRs de venda (todos *draft*, cada um sobre o anterior): PR42 `#41` → PR43 `#42` → PR44 `#43` → PR45 `#44` → PR46 `#45` → PR47 `#46`.

## 2. O que o Gate 4 prova

O plano pede: venda atômica, estoque correto, dinheiro correto, cancelamento correto, devoluções corretas e reconciliação de cliente que não altera a economia. A evidência está no runbook [`docs/runbooks/gate-4-sales-core.md`](../docs/runbooks/gate-4-sales-core.md) (mapa propriedade → gate → cenário) e foi gerada em PostgreSQL 18.6 numa branch Neon descartável, com migrations 0000–0038 reaplicadas do zero e fixtures sintéticas:

| Gate | Comando | Resultado |
| --- | --- | --- |
| Agregado de venda | `poc:sales:verify` | ver status |
| Transação de venda (atomicidade, idempotência, concorrência, RLS) | `poc:sales:transaction:verify` | ver status |
| Atribuição de cliente | `poc:sales:customer-link:verify` | ver status |
| Cancelamento | `poc:sales:cancellation:verify` | ver status |
| Devoluções parciais | `poc:sales:return:verify` | ver status |
| Datas da venda | `poc:sales:dates:verify` | ver status |
| **Gate 4 ponta a ponta** | `poc:gate4:verify` | cenário único contra um oráculo independente (centavos inteiros, razão que explica todos os saldos, digests das tabelas econômicas antes/depois, conservação de estoque) |

Os números exatos (execuções, commits, expiração das branches) estão na seção de cada PR em `doc/status-implementacao.md`.

## 3. Decisões que o projeto tomou onde o plano era omisso

O responsável delegou: "decida o melhor para o projeto nas questões em aberto e prossiga". Estas decisões **precisam de revisão humana**; cada uma está registrada em `docs/business-rules/sales.md` ou `inventory.md`.

**Venda (PR43)**
- Um único comando `sale.confirm` confirma tudo (cabeçalho, itens, ajustes, pagamento, movimentos, auditoria) em uma transação; não existe rascunho persistido. O banco, por *triggers* de restrição deferidos, recusa venda parcial mesmo com permissão de INSERT.
- Custo do item e rótulo do produto vêm do servidor sob lock; o cliente só informa variante, quantidade, preço de tabela e preço cobrado.
- Perfil de pagamento é escolha explícita (`{id, expectedVersion}` ou `null`); sem perfil/regra a venda segue com taxas desconhecidas (nunca zero).
- Erros 400/404/409 expõem `data.reason` com um código estável; autorização não expõe motivo.
- Interface: resultado desconhecido (rede/5xx) trava a tentativa; só repete o mesmo `commandId` ou descarta com confirmação.

**Atribuição de cliente (PR44)**
- Histórico versionado e só de acréscimo (`assign`/`reassign`/`unassign`) com `expectedVersion`; nunca altera a economia; cliente arquivado continua associado; capability própria `sale:assign_customer`.

**Cancelamento (PR45)**
- Cancelamento é total, compensatório (registro novo + movimentos `sale_cancellation`), nunca edita a venda. Motivos estruturados (lista V1 própria) com observação obrigatória só para `other`.
- Reposição ao **custo do snapshot do item**; regra da média: custo do snapshot desconhecido deixa a média; saldo vazio adota o custo; saldo positivo com média desconhecida continua desconhecido; senão média ponderada, half-up em 6 casas.
- Produto removido não recebe reposição.

**Devoluções (PR46)**
- Itens identificados pela posição; várias devoluções até esgotar o disponível; só as unidades **repostas** geram movimento; motivo estruturado opcional; **cancelamento e devolução se excluem** (lock por venda + verificação repetida no commit); **sem valor monetário nem reembolso** (a especificação diz que o impacto em vendas líquidas pertence ao motor de métricas).

**Datas (PR47)**
- `recorded_at` substitui `client_created_at` (nome do plano); `occurred_on` (data comercial no calendário da organização) é nova coluna obrigatória e é a data do razão.
- Janela retroativa: 30 dias de calendário no fuso da organização para o `owner`; papel desconhecido = 0 dias; futuro: 5 minutos; replay responde antes da janela.

**Transversais**
- Contas e valores: BRL 2 casas, custos/percentuais 6, half-up uma vez por valor; percentual em pontos percentuais.
- Capabilities: tudo hoje é `owner`; cada operação tem capability própria, checada de novo no repositório.

## 4. Pontos que peço atenção na revisão

1. **Estrutura em camadas de segurança.** Cada escrita de venda passa por: sessão → membership → capability → GUCs de RLS → repositório (que repete a capability e usa organização/ator da identidade) → *triggers* deferidos no commit. Vale conferir se há duplicação demais ou lacuna.
2. **Compensação, não edição** ([ADR 0005](../docs/adr/0005-corrigir-vendas-confirmadas-com-registros-compensatorios.md)). O runtime só tem SELECT+INSERT nas tabelas de venda. Pergunta: aceitamos a ausência de "desfazer cancelamento" e de devolução com valor?
3. **Ordem de locks.** Produtos por id, depois saldos; lock consultivo por venda para cancelamento/devolução; *triggers* também travam pela mesma chave. Os gates incluem corridas e dueto de escritores diretos.
4. **Colunas `timestamp` sem fuso.** O projeto grava UTC em `timestamp` (sem `with time zone`) e o driver do Drizzle interpreta como UTC; leituras diretas com `pg` interpretam no fuso da máquina (isso apareceu num gate e foi corrigido lendo `AT TIME ZONE 'UTC'`). Vale decidir se migramos para `timestamptz`.
5. **Rename `client_created_at` → `recorded_at`** quebra clientes antigos em cache (o campo é descartado e um retry de venda já com evidência vira conflito). Aceitável antes do lançamento; precisa de nota de release depois.
6. **Papéis.** Só `owner` existe; a janela retroativa por papel, as capabilities finas e a UI por papel não foram exercidas além dele.
7. **Lista de motivos** de cancelamento e devolução foi decidida pelo projeto (não consta do plano).
8. **Venda retroativa na UI** compara a data comercial com o dia local do dispositivo (a organização não expõe o fuso ao navegador): perto da meia-noite, ou com fuso diferente, o rótulo "Venda retroativa" pode errar.
9. **Lista de vendas** ainda mostra `occurred_at`; só o detalhe mostra as três datas.

## 5. Lacunas e dívida técnica conhecidas

- **Interface sem verificação ponta a ponta.** Modelos de visão têm testes unitários; houve verificação manual no navegador embutido (com servidor `/rpc` simulado) só para PR43 e PR44. PR45–PR47 não foram clicados em navegador, nem testados em 360 px. Gate mobile/iPhone fica para depois.
- **Gate não prova o replay após a janela por envelhecimento natural** (impossível sem editar linhas imutáveis): o gate envelhece a linha como dono da tabela e prova que o replay vence a janela.
- **Backfill da migration 0038** nunca encontra vendas antigas em nenhum ambiente real (não existem vendas fora dos gates); o gate prova que a expressão do backfill coincide com a data que a aplicação grava, em dois fusos, e que o papel de migração enxerga `organizations` sob FORCE RLS.
- **Sem outbox transacional** (PR108) e sem consumidores da venda; sem liquidação, multimoeda nem provedores de pagamento (explicitamente fora do escopo).
- **Cadeia de PRs longa e não integrada.** cerca de 22 PRs empilhados (#25–#46) sem merge; a estratégia de integração (merge sequencial, squash por fase ou rebase) precisa de decisão antes de avançar muito mais.
- **Higiene de ferramenta.** `bun install` faz o Turborepo alterar `AGENTS.md` (revertido a cada vez); o Biome reordena imports de arquivos antigos quando roda sobre diretórios inteiros (revertido para manter os diffs enxutos); gates não podem rodar em paralelo no mesmo banco.
- **Limite de branches Neon.** O plano limita branches raiz; só apaguei branches de gate criadas por mim e já concluídas.

## 6. Como reproduzir

Ver [`docs/runbooks/gate-4-sales-core.md`](../docs/runbooks/gate-4-sales-core.md). Resumo: branch Neon nova e descartável (perfil `junior-pessoal`), `db:migrate` do zero, gates em sequência, limpar variáveis do processo, apagar a branch própria. Nenhuma connection string é registrada.

## 7. Próximos passos sugeridos (após a revisão)

1. Resolver as perguntas da seção 4 e a estratégia de integração da cadeia.
2. Verificação de interface (navegador, 360 px, iPhone) das telas de venda, cancelamento, devolução e datas.
3. Fase 5 — Offline (PR48: modelo de dispositivo), transportando os commands existentes sem redesenhá-los.
