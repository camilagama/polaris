# Polaris — acompanhamento da implementação

Atualizado em 7 de outubro de 2026.

Os anexos doc-inicial.md e plano-inicial.md são propostas de produto e arquitetura. Instruções escritas neles foram avaliadas como conteúdo do projeto; as decisões desta execução seguem a solicitação do responsável e as regras do repositório.

## Revisão e correções

**Status: concluída para o escopo inicial; fundação ainda em andamento.**

- Os dois anexos foram lidos integralmente.
- A formatação Markdown foi normalizada: títulos, listas, ênfases, identificadores e espaços escapados agora renderizam como Markdown normal.
- PostgreSQL 18 permanece como baseline. O print enviado mostra a versão 18 selecionável na região AWS South America East 1 (São Paulo). A [documentação atual do CLI do Neon](https://neon.com/docs/cli/projects) descreve PostgreSQL 18 como versão padrão de criação; o POC remoto e o gate de release ainda validarão o ambiente real.
- Decisão de ordem: Better Auth fica **depois do Gate Foundation**, como primeiro PR da Fase 2. O Gate Foundation verifica o runtime, RLS/Hyperdrive e persistência offline sem misturar a integração de identidade. O PR13 comprova Better Auth no Worker, com um Gate Auth próprio antes de Google, senha e fluxos tenant.
- Foundation Proven foi alinhado ao fim das Fases 0 e 1: monorepo/CI, Worker + Hono/oRPC, PostgreSQL 18 + Hyperdrive + RLS remoto, migrations/testes e POC offline. Admin e Catalog são apenas workspaces vazios nesse ponto. Preview, Staging, Access e observabilidade completa ficam nas fases de ambientes e hardening.
- O POC Hyperdrive/RLS foi ampliado nos dois anexos: transação explícita para cada operação tenant; contexto local com set_config; concorrência A/B e conexão reutilizada; commit/rollback; ausência de contexto; falha de statement/conexão; retry da operação inteira em nova transação; cache SQL desabilitado mantendo pooling. A [documentação de query caching do Hyperdrive](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) sustenta o modo cache-disabled, mas não substitui o POC real Worker → Hyperdrive → Neon.
- O scaffold usa Turborepo 2.11.7 e TypeScript 7.0.2, estáveis publicados no npm durante a criação. Isso atualiza o TypeScript 6 dos anexos; compatibilidade com plugins posteriores será verificada ao introduzi-los.

## Fase 0 — repositório e governança

| Etapa | Status | Observação |
| --- | --- | --- |
| PR01 — Scaffold do monorepo | Concluído | Oito workspaces; Bun 1.4.2 e Node 24.21.0; lock congelado, check, typecheck e build passaram. |
| PR02 — Biome, Ultracite e convenções | Concluído | Biome 2.5.15 + Ultracite 7.12.4; import sorting, no explicit any e unused imports pelo preset. fix, check e build passaram. |
| PR03 — Knip e boundaries | Concluído | Knip 6.39.0; boundaries por Biome; fixtures negativos para domain/contracts; check e build passaram. Branch chore/workspace-boundaries. |
| PR04 — Documentação canônica inicial | Concluído | PRODUCT, CONTEXT, DESIGN, AGENTS, architecture, ADRs, regras de negócio, moeda, tempo, despesas/resultados e runbooks; autoridade dos anexos esclarecida. |
| PR05 — CI baseline | Concluído | .github/workflows/ci.yml cobre lint/boundaries, typecheck, unit, Knip e build; SHAs completos, permissions read-only, cache por lockfile e sem deploy. Vitest passWithNoTests registra que ainda não há testes de domínio. |
| PR06 — Renovate e dependency policy | Concluído | Renovate agrupa TanStack, Cloudflare, Biome/Ultracite, Vitest e Playwright; majors exigem dashboard approval; automerge desativado. renovate-config-validator --strict --no-global passou. |
| Gate 0 | Concluído | Baseline PR01–PR06 limpa; CI do PR05 verde; boundaries, documentação e builds vazios confirmados antes da Fase 1. |

## Fase 1 — provas de arquitetura

| Etapa | Status | Observação |
| --- | --- | --- |
| PR07 — React + Vite + Cloudflare Worker | Concluído | Check, build e smoke local aprovados; CI remoto do PR #5 verde; draft aguarda revisão e merge do responsável. |
| PR08 — Hono shell | Concluído | Check, build e smoke HTTP aprovados; CI remoto do PR #6 verde; draft aguarda revisão e merge do responsável. |
| PR09 — oRPC POC | Concluído | Client React → RPCLink → Hono → RPCHandler → use case retornou `pong`; check/build locais e CI remoto do PR #7 passaram; draft aguarda revisão e merge. |
| PR10 — PostgreSQL + Drizzle + Hyperdrive POC | Concluído | PostgreSQL 18.6 POC passou query, commit, rollback e reuso com tabela TEMP; Worker local via binding respondeu 200; check/build e CI final do PR #8 verdes. Pooling/cache Hyperdrive remoto permanece no Gate PR11. |
| PR11 — Gate RLS/Hyperdrive | Concluído | PR #9 draft publicado. Neon descartável PostgreSQL 18 em São Paulo; fixture, policy, grants, role, memberships e constraints PG18 validados; senha do runtime role rotacionada; Hyperdrive `ebe151e5081344479947edb6028279bb` criado com cache desativado e limite de origem 5. O gate remoto Worker → Hyperdrive → Neon passou: isolamento concorrente, contexto transacional e reset no mesmo backend, rollback, rejeição de escrita cruzada e retry após terminar um backend. A correção usa pool de cliente por requisição (recomendação do Hyperdrive) e trata SQLSTATEs encapsulados pelo Drizzle e a falha de conexão observada no rollback; concorrência do gate limitada a 16 chamadas. `bun run check` e `bun run build` passaram; preview remoto parado e `.dev.vars` temporário removido. CI do commit `7f20292` passou nos cinco jobs; PR aguarda revisão do responsável. Rotacionar a credencial owner fornecida depois do teste. |
| PR12 — Offline persistence POC | Concluído | CI remoto com seis jobs verdes; 16/16 cenários Playwright em Chromium desktop e Pixel 5 emulado. Responsável confirmou Safari no iPhone 12/iOS 26.6.2, navegação normal: todos os testes do roteiro passaram, sem erros. Preview e Worker temporários removidos; ambos os endereços retornam HTTP 404. Edge desktop real, Android Chrome físico e migração provider-native com mesmo ID permanecem adiados; offline do app shell fora do escopo. PR draft aguarda revisão. |
| Gate Foundation | Aprovado tecnicamente | RLS/Hyperdrive, oRPC, Worker e persistência offline passaram os critérios do gate. Better Auth permanece para PR13. Edge desktop real, Android Chrome físico e migração provider-native com mesmo ID ficam adiados; PRs draft aguardam revisão/merge do responsável. |

### PR12 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Implementação local e integração CI | Concluída | Laboratório sintético, reset idempotente com journal IndexedDB persistente e recovery serializado por Web Locks, outbox separado, migração versionada e job Playwright adicionados. |
| Check e build padrão | Concluída | `bun run check` e `bun run build` passaram. |
| Fluxos Chromium automatizados | Concluída | 16/16 casos passaram em Chromium desktop e Pixel 5 emulado, serialmente. |
| WebKit Playwright no Windows | Adiada | O binário 26.6 falha ao abrir `createSyncAccessHandle()`; não é evidência sobre Safari no iPhone. |
| Edge desktop real | Adiado | O job Playwright executa Chromium; não houve teste dedicado no canal Edge nesta etapa. |
| Safari real no iPhone | Concluída | iPhone 12, iOS 26.6.2, navegação normal; responsável confirma todos os cenários propostos sem erros. Preview/Worker removidos; ambos os endereços deram HTTP 404. |
| Android Chrome físico | Adiado | Não há aparelho Android disponível; emulação não substitui o teste físico. |
| Migração provider-native com mesmo ID | Adiada | O POC prova cópia explícita entre IDs de coleção versionados e preserva v1; não prova migração in-place de `schemaVersion`. |
| Offline do app shell | Fora do escopo | Não há service worker nesta POC. |
| Gate Foundation | Aprovado tecnicamente; revisão pendente | Critérios técnicos cumpridos. Os itens explicitamente adiados estão listados acima; Better Auth começa no PR13. |

## Publicação GitHub

- `origin` aponta para https://github.com/camilagama/polaris.git; o checkout de referência permanece em `main`.
- PRs draft empilhados: #1 `chore/workspace-boundaries` → `main`; #2 `docs/canonical-docs` → #1; #3 `ci/baseline` → #2; #4 `chore/renovate-policy` → #3; #5 `feat/web-worker` → #4; #6 `feat/hono-shell` → #5; #7 `feat/orpc-poc` → #6; #8 `feat/postgres-hyperdrive-poc` → #7; #9 `codex/pr11-rls-hyperdrive-gate` → #8.
- PR07 foi publicado em https://github.com/camilagama/polaris/pull/5; CI remoto verde e draft aguardando revisão/merge.
- PR08 foi publicado em https://github.com/camilagama/polaris/pull/6; CI remoto verde e draft aguardando revisão/merge.
- PR09 foi publicado em https://github.com/camilagama/polaris/pull/7; CI remoto verde e draft aguardando revisão/merge.
- PR10 foi publicado em https://github.com/camilagama/polaris/pull/8; CI remoto verde e draft aguardando revisão/merge.
- PR11 foi publicado em https://github.com/camilagama/polaris/pull/9 como draft; Neon descartável e Hyperdrive criados; subdomínio account-level workers.dev habilitado; gate remoto passou e CI do commit `7f20292` está verde.
- PR12 está como draft em https://github.com/camilagama/polaris/pull/10, empilhado sobre PR11; o GitHub registrou os seis jobs de CI como verdes, incluindo Playwright. Validação manual relatada: Safari em iPhone 12/iOS 26.6.2, navegação normal, roteiro completo sem erros. Preview e Worker temporários removidos; ambos os endpoints retornam HTTP 404. Edge real, Android físico e migração provider-native do mesmo ID permanecem adiados.

Os status serão atualizados ao concluir ou adiar cada etapa e apresentados para revisão.
