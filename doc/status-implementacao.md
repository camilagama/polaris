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

## Fase 2 — identidade e acesso

| Etapa | Status | Observação |
| --- | --- | --- |
| PR13 — Better Auth base | Implementação e gates local/remoto concluídos; draft PR #11 para revisão | Better Auth 1.6.23 no Worker com Drizzle/PostgreSQL, migration para user/account/session/verification; password, OAuth e Organization seguem desligados. Check, build, dois testes Vitest e integração local Worker + Neon passaram. O Gate Auth local e remoto passou; Worker, Hyperdrive, papel de runtime e fixture temporários foram removidos; nenhum segredo foi commitado. |
| Gate Auth | Concluído | O Worker remoto leu e revogou uma sessão persistida via Hyperdrive e Neon PostgreSQL 18; a leitura posterior foi nula. O papel temporário teve CRUD somente nas quatro tabelas Better Auth. Worker, config Hyperdrive, papel e fixture foram removidos. A branch Neon expira em 2026-10-08 às 09:29 (America/Sao_Paulo). |
| PR14 — Login Google | Implementação e testes mock concluídos; draft aguardando revisão | Better Auth 1.6.23 configura OAuth Google server-side com linking desativado; sete testes mock passam. Migration 0003 aplicada à branch Neon descartável; o runtime tem INSERT-only na auditoria. Login Google real e retenção da auditoria ficam adiados conforme credenciais e revisão pré-go-live. |
| PR15 — Email/password | Implementação e testes mock concluídos; Resend integrado; draft aguardando revisão | Better Auth habilita signup/verificação/login/reset com password policy e HIBP; Resend usa templates sem imagens, timeout e idempotência por token. Sem API key nem domínio verificado no Worker; flag `EMAIL_PASSWORD_AUTH_ENABLED` segue `false` até Resend, Turnstile, bindings de abuso e UI estarem configurados. Nenhum email real enviado. Outbox/Queue e webhooks ficam adiados para hardening pré-go-live. |
| PR16 — Turnstile e auth abuse | Implementação concluída; draft PR #14 publicado; 6/6 checks verdes no commit de código; revisão pendente | Siteverify, limites Workers, fail-closed, testes mock e runbook concluídos; nenhuma configuração/secret foi aplicada ao Worker remoto. |
| PR17 — Account linking | Implementação e testes locais concluídos; revisão independente e publicação draft pendentes | Vínculo explícito Google/senha; linking implícito desligado; email local e provider verificados; proteção contra account takeover. |

### PR13 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Better Auth no Worker e route Hono | Concluída | GET/POST em /api/auth/*; configuração ausente responde 503; secret exige pelo menos 32 caracteres. |
| Schema e migration PostgreSQL | Concluída | Migration 0002 cria user, account, session e verification; aplicada com a cadeia Drizzle na branch Neon temporária. |
| Sessão: criar, ler, revogar | Concluída local e remotamente | Dois testes Vitest e integrações local e remota leram sessão persistida, revogaram e confirmaram leitura autoritativa nula. |
| Hyperdrive remoto no Gate Auth | Concluído | A prova Worker → Hyperdrive → Neon passou com o role polaris_pr13_runtime restrito às quatro tabelas de autenticação. A leitura e a revogação de sessão passaram; o role temporário e a config Hyperdrive foram removidos após o teste. |
| Login senha/OAuth/Organization | Fora do escopo | Este PR só prepara o runtime, schema e sessão de fixture; os fluxos previstos ficam nos PRs seguintes. |

A branch Neon descartável pr13-better-auth-gate expira em 2026-10-08 às 09:29 (America/Sao_Paulo). O branch production do PR11 permaneceu intacto. Worker e config Hyperdrive temporários foram removidos após o Gate Auth remoto passar.
### PR14 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| OAuth Google server-side | Concluída com provider mock | Authorization URL, callback, criação de sessão, logout, provider error e callback inválido testados sem credenciais reais. |
| Linking e tokens | Concluída | Account linking está desativado até PR17; login por ID token enviado pelo cliente está desativado; access/refresh tokens cifrados; idToken não persiste, acesso online sem scope offline. |
| Security audit no PostgreSQL | Concluída | Migration 0003 cria audit event com tipo, outcome, provider, actor ID interno, request ID e error code sanitizado. A branch Neon de teste confirma grant INSERT-only ao papel persistente `polaris_pr11_runtime`. Não registra email, query, code, state, token ou provider payload. |
| Login com Google real | Adiado | Exige OAuth Web client ID/secret e redirect URI autorizada. Nenhuma credencial Google foi fornecida ou publicada. O teste live no Worker temporário depende de autorização explícita para guardar client ID/secret como Cloudflare Secrets. |
| Retenção da auditoria | Adiada até pre-go-live | A regra de privacidade exige revisão jurídica/contábil dos prazos antes do lançamento; a migration não apaga eventos automaticamente. |

### PR15 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Política de senha | Concluída | 15–128 pontos de código Unicode após NFC; espaços e Unicode aceitos; sem composição arbitrária ou expiração; HIBP fail-closed antes de armazenar/alterar senha.
| Hash e verify NFC | Concluído | Scrypt mantém os parâmetros e formato salt:key de Better Auth, normalizando NFC; teste confirma que caracteres fullwidth não colapsam para ASCII. |
| Verificação e reset por email | Implementados com mock; envio real adiado | Better Auth exige email verificado antes da sessão de senha; verificação expira em 24h e reset em 1h. Resend é o provider escolhido, mas API key e domínio verificado ainda não estão configurados.
| Signup/login/reset | Concluídos com testes mock | Login antes de verificar é recusado; reset usa resposta anti-enumeração e revoga todas as sessões. As flags do Worker seguem desligadas até widget, secrets, bindings e Resend estarem configurados.
| HIBP | Concluído e testado | SHA-1 calculado no Worker, consulta range com prefixo de 5 caracteres e Add-Padding, comparação local do sufixo; falha externa bloqueia signup/reset/alteração. Senha e hash completo não saem do Worker. Lista complementar de senhas comuns/contextuais fica adiada para decisão pré-go-live conforme NIST. |

### PR16 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Siteverify e cobertura de rotas | Concluídos com testes mock | Signup, login, solicitação/conclusão de reset e reenvio de verificação exigem token de uso único, ação esperada e hostname de `BETTER_AUTH_BASE_URL`. |
| Rate limiting | Implementado; limites remotos aproximados | 10/60s geral por IP e 3/60s para envio de email por IP; HMAC nas chaves. Contadores Cloudflare são por localidade, não globais. |
| Testes, check e build | Concluídos localmente e no CI | 14 testes novos; `bun run check` passou com 37 testes no total; `bun run build` passou. Os seis jobs de CI remoto passaram no commit de código `bb7040e`, incluindo o gate Playwright. Siteverify real não foi chamado. |
| UI Turnstile, segredo e bindings remotos | Adiados | O app ainda não tem UI de autenticação. Nenhum widget/secret foi provisionado; IDs `901016`/`901017` são placeholders e precisam ser confirmados como únicos na conta antes de deploy. |

### PR17 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Configuração Better Auth | Concluída | Linking explícito permitido; linking implícito desligado; `trustedProviders` vazio; emails diferentes não permitidos; perfil local não é sobrescrito. |
| Google → conta de senha | Concluída com provider mock | Sessão local verificada exige OAuth redirect; claim Google precisa ter email verificado igual; tentativa de mover um Google subject já ligado a outra conta é rejeitada. |
| Google → senha | Concluída via API server-only | Worker valida sessão e email verificado, aplica NFC/HIBP antes de `auth.api.setPassword`, e o login por senha retorna o mesmo user ID. |
| Account takeover e auditoria | Concluídas com testes mock | Testados email local/provider não verificado, email diferente, sessão ausente, `idToken` do cliente, linking implícito e subject já vinculado. Callback registra evento de segurança com actor ID interno; `id_token` não persiste e access token não fica em claro. |
| Testes, check e build | Concluídos localmente | 10 testes novos; `bun run check` passou com 47 testes totais; `bun run build` passou. Nenhum OAuth Google real foi executado. |
| OAuth Google real | Adiado | Nenhum client ID/secret Google foi configurado; os fluxos OAuth foram exercitados com provider e token endpoint mock. |
| UI de gerenciamento | Adiada | A UI de autenticação/contas ainda não existe; o endpoint de vínculo está pronto para futura integração. |
| Ativação da senha | Desligada | Habilitar somente quando UI, site key, secret Turnstile, IDs dos bindings, Resend e domínio verificado estiverem prontos. |

## Publicação GitHub

- `origin` aponta para https://github.com/camilagama/polaris.git; o checkout de referência permanece em `main`.
- PRs draft empilhados: #1 chore/workspace-boundaries → main; #2 docs/canonical-docs → #1; #3 ci/baseline → #2; #4 chore/renovate-policy → #3; #5 feat/web-worker → #4; #6 feat/hono-shell → #5; #7 feat/orpc-poc → #6; #8 feat/postgres-hyperdrive-poc → #7; #9 codex/pr11-rls-hyperdrive-gate → #8; #10 codex/pr12-offline-persistence → #9; #11 codex/pr13-better-auth → #10; #12 codex/pr14-google → #11; #13 codex/pr15-password → #12; #14 codex/pr16-turnstile → #13.
- PR07 foi publicado em https://github.com/camilagama/polaris/pull/5; CI remoto verde e draft aguardando revisão/merge.
- PR08 foi publicado em https://github.com/camilagama/polaris/pull/6; CI remoto verde e draft aguardando revisão/merge.
- PR09 foi publicado em https://github.com/camilagama/polaris/pull/7; CI remoto verde e draft aguardando revisão/merge.
- PR10 foi publicado em https://github.com/camilagama/polaris/pull/8; CI remoto verde e draft aguardando revisão/merge.
- PR11 foi publicado em https://github.com/camilagama/polaris/pull/9 como draft; Neon descartável e Hyperdrive criados; subdomínio account-level workers.dev habilitado; gate remoto passou e CI do commit `7f20292` está verde.
- PR12 está como draft em https://github.com/camilagama/polaris/pull/10, empilhado sobre PR11; o GitHub registrou os seis jobs de CI como verdes, incluindo Playwright. Validação manual relatada: Safari em iPhone 12/iOS 26.6.2, navegação normal, roteiro completo sem erros. Preview e Worker temporários removidos; ambos os endpoints retornam HTTP 404. Edge real, Android físico e migração provider-native do mesmo ID permanecem adiados.
- PR13 está como draft em https://github.com/camilagama/polaris/pull/11, empilhado sobre PR12. A migration 0002 e as integrações local e remota Worker + PostgreSQL 18 passaram. O Gate Auth remoto via Hyperdrive foi concluído; Worker, config Hyperdrive, role temporário e fixture foram removidos. A branch Neon de teste expira em 2026-10-08 às 09:29 (America/Sao_Paulo).

- PR14 está como draft em https://github.com/camilagama/polaris/pull/12, empilhado sobre PR13. Check completo, sete testes mock e build passaram. A migration 0003 foi aplicada à branch Neon descartável; teste Google real aguarda credenciais e autorização para adicioná-las ao Worker temporário.
- PR15 está como draft em https://github.com/camilagama/polaris/pull/13, empilhado sobre PR14; 23 testes mock, check completo e build local passaram. Nenhuma credencial Resend foi configurada e nenhuma mensagem real foi enviada.
- PR16 está como draft em https://github.com/camilagama/polaris/pull/14, empilhado sobre PR15. Revisão independente sem blockers; check local passou com 37 testes, build passou e os seis jobs remotos passaram no commit de código `bb7040e`. Esta atualização de status é somente documental. Nenhum segredo, widget ou recurso Cloudflare foi provisionado.
Os status serão atualizados ao concluir ou adiar cada etapa e apresentados para revisão.
