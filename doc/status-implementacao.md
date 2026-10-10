# Polaris — acompanhamento da implementação

Atualizado em 10 de outubro de 2026.

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
| PR17 — Account linking | Implementação concluída; PR #15 draft publicado; CI 6/6 verde; usuário autorizou seguir para PR18 | Vínculo explícito Google/senha; linking implícito desligado; email local e provider verificados; proteção contra account takeover. |
| PR18 — Sessões | PR #16 draft publicado; implementação e gate PostgreSQL 18 concluídos; CI 6/6 verde; continuidade para PR19 autorizada; revisão/merge pendentes | Idle 7d, absoluto 30d, múltiplas sessões, listagem/revogação, logout e reset de senha revogando todas. |
| PR19 — Organizations e memberships | Draft PR #17 publicado; gate PostgreSQL 18, check/build locais e CI 6/6 remotos verdes; continuidade para PR20 autorizada; revisão/merge pendentes | Migration e constraints verificadas em branch Neon descartável; onboarding idempotente permanece no PR20. |
| PR20 — Onboarding idempotente | Draft PR #18 publicado; gate Neon PG18, check (58 testes), build (8 workspaces) e CI 6/6 verdes; continuidade para PR21 autorizada; revisão/merge pendentes | Sem rota HTTP, grants ou policies RLS; integração com autorização/tenant permanece em PR21/22. |
| PR21 — Capabilities tenant | Draft PR #19 publicado; mapa V1, review independente sem blockers, check (62 testes), build (8 workspaces) e CI remoto 6/6 concluídos; aguardando revisão do usuário | Mapa puro owner→capability; autenticação/membership/status e enforcement permanecem no PR22. |

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
| Revisão independente | Concluída | Nenhum blocker confirmado no diff de implementação. |
| Draft PR e CI remoto | Concluídos | [PR #15](https://github.com/camilagama/polaris/pull/15), draft empilhado sobre #14; seis checks, incluindo Playwright browser gate, passaram no commit de código a5fdbff. |
| Revisão do usuário | Continuidade autorizada | Usuário respondeu “prossiga”; PR #15 permanece draft aberto e não foi mergeado. |
| OAuth Google real | Adiado | Nenhum client ID/secret Google foi configurado; os fluxos OAuth foram exercitados com provider e token endpoint mock. |
| UI de gerenciamento | Adiada | A UI de autenticação/contas ainda não existe; o endpoint de vínculo está pronto para futura integração. |
| Ativação da senha | Desligada | Habilitar somente quando UI, site key, secret Turnstile, IDs dos bindings, Resend e domínio verificado estiverem prontos. |

### PR18 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| TTL idle | Concluído | Better Auth usa 7 dias de expiração, refresh a cada 24 horas no uso autenticado e cookie cache desativado. |
| TTL absoluto | Concluído | Worker revoga sessão ao atingir 30 dias; migration cria trigger PostgreSQL que limita `expires_at`, mantém criação imutável e ajusta sessões antigas. |
| Múltiplas sessões, listagem e revogação | Concluídas com testes | Duas sessões simultâneas listadas; revogação remove apenas a sessão alvo; usuário diferente não lista nem revoga sessão alheia. Token cru não autentica sem cookie assinado. |
| Logout e reset de senha | Concluídos com testes | Logout invalida a sessão atual; reset de senha revoga duas sessões ativas do mesmo usuário. |
| Migration PostgreSQL 18 | Concluída em branch Neon descartável | `pr18-sessions-gate`, auto-delete em 2026-10-08 às 21:30 (America/Sao_Paulo). Backfill, INSERT e UPDATE foram testados; ambos os registros ficaram com TTL máximo de 30 dias e `created_at` não pôde ser movido. A branch production permaneceu intacta. |
| Check e build | Concluídos localmente | `bun run check` e `bun run build` passaram; 54 testes totais. |
| Draft PR e CI remoto | Concluídos | [PR #16](https://github.com/camilagama/polaris/pull/16), draft empilhado sobre #15; seis checks passaram no commit de código dcf42ab. |
| UI de gerenciamento | Adiada | A UI de autenticação ainda não existe; endpoints server-side Better Auth estão disponíveis. |
| Revisão independente | Concluída | Nenhum blocker; revisão confirmou que o token listado não autentica sem cookie assinado e que revogação confere o proprietário. |
| Revisão do usuário | Continuidade autorizada; revisão/merge pendentes | Usuário autorizou PR19; PR #16 continua draft aberto e sem merge. |

### PR19 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Schema e migrations | Concluídos | Drizzle criou `organizations` e `memberships`, PK composta, FKs, checks, índice e snapshots; `db:generate` repetido não produziu mudanças. |
| Gate PostgreSQL 18 | Concluído em branch Neon descartável | Checks de moeda/status, `owner`/`active`, chave composta e FKs passaram. Dois memberships do mesmo usuário em organizações distintas foram aceitos; exclusão física da organização removeu memberships em cascade; exclusão física do usuário foi bloqueada por `RESTRICT`. Branch `pr18-sessions-gate` expira automaticamente em 2026-10-08 às 21:30 (America/Sao_Paulo). |
| Segurança do runtime | Concluída para escopo schema-only | `polaris_pr11_runtime` continua sem `SELECT` nas novas tabelas; este PR não adicionou grants, policies RLS ou rotas tenant. Production não foi alterada. |
| Check e build | Concluídos localmente | `bun run check` passou com 54 testes; `bun run build` passou nos oito workspaces. |
| Revisão independente | Concluída | Sem blockers após documentar o cascade e proteger os valores iniciais de membership com checks. |
| Draft PR e CI remoto | Concluídos | [PR #17](https://github.com/camilagama/polaris/pull/17), draft empilhado sobre #16; 6/6 checks passaram no commit `8ba60ad`, incluindo o browser gate Playwright (16/16 testes desktop e mobile emulado). |
| Onboarding e limite V1 | Adiados para PR20 | Criação transacional e idempotente; email verificado e timezone IANA validados no servidor; lock transacional por usuário para duas requests concorrentes com chaves distintas. |
| RLS, grants e rotas tenant | Adiados para PR21/22 | Devem ser ligados com capabilities e contexto tenant antes de expor operações tenant. |
| Exclusão física | Limitação para decisão de domínio | Usuário não pode ser apagado com membership; organização removida fisicamente apaga memberships, mas transferência, retenção e exclusão ainda não têm fluxo definido. `closed` não significa apagar. |
| Revisão do usuário | Continuidade autorizada | Usuário respondeu “prossiga” em 8 de outubro; PR #17 permanece draft aberto e sem merge. |
### PR20 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Use case e adapter DB | Concluídos localmente | `apps/web` normaliza a entrada; `packages/db` executa a transação e o lock, sem dependência Drizzle direta no Worker. |
| Identidade e validação | Concluídas no use case | Email verificado vem de `public.user.email_verified` sob row lock; nome é trimmed e timezone IANA é validado/canonicalizado antes da transação. |
| Atomicidade e concorrência | Concluídas | Advisory transaction lock por usuário; criação de organization e membership owner/active ocorre na mesma transação `READ COMMITTED`. Retry retorna o existente sem alterar nome/timezone; membership múltiplo preexistente falha fechado. |
| Defaults | Concluídos com schema existente | BRL, organization active e membership owner/active. Não há categorias/produtos seed definidos pelas regras do produto. Nenhuma migration adicional foi necessária. |
| Gate Neon PostgreSQL 18 | Concluído em branch descartável | Criação, retry, concorrência, email não verificado, usuário ausente, timezone inválido e memberships múltiplos testados. Runtime role continua sem SELECT/INSERT/UPDATE/DELETE; fixtures foram removidas e a checagem não encontrou resíduos. Branch `pr18-sessions-gate` expira em 2026-10-08 às 21:30 (America/Sao_Paulo). |
| Check e build | Concluídos localmente | `bun run check` passou com 58 testes; `bun run build` passou nos oito workspaces. |
| Rota e acesso runtime | Adiados para PR21/22 | O use case permanece interno; não expõe HTTP nem concede grants/RLS antes dos controles de capabilities e contexto tenant. |
| Revisão independente | Concluída | Sem blockers após os ajustes do gate de privilégios e da validação do ID autenticado. |
| Draft PR e CI remoto | Concluídos | [PR #18](https://github.com/camilagama/polaris/pull/18), draft empilhado sobre #17; 6/6 checks verdes no commit `51ddeda`, incluindo o browser gate Playwright. |
| Revisão do usuário | Continuidade autorizada | Usuário respondeu “prossiga” em 8 de outubro; PR #18 permanece draft aberto e sem merge. |

### PR21 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Mapa domain owner→capability | Concluído localmente | owner mapeia para as oito capabilities do plano; role ou capability desconhecido falha fechado. |
| Autenticação, membership e status | Adiados para PR22 | O helper de domínio não é autorização completa; esse gate depende do request context server-side. |
| Rota tenant, grants e RLS | Adiados para PR22 | Nenhuma rota ou acesso runtime deve ser exposto neste PR. |
| Testes, check e build | Concluídos localmente | bun run check passou com 62 testes; bun run build passou nos oito workspaces. |
| Revisão independente | Concluída | Sem blockers; confirmação de fail-closed para roles/capabilities desconhecidos, mapa owner exato e subpath exportado. |
| Draft PR e CI remoto | Concluídos | PR #19, draft empilhado sobre #18; 6/6 checks passaram no commit 99d1860. |
| Revisão do usuário | Continuidade autorizada | O usuário respondeu “prossiga” em 8 de outubro; PR #19 segue draft aberto e sem merge. |

### PR22 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Escopo, documentação e baseline | Concluídos | Plano/ADRs/runbook lidos; branch codex/pr22-tenant-context baseada no PR21; install congelado, baseline check/build passaram. |
| Compositor Better Auth → tenant | Concluído | Sessão Better Auth resolvida antes da transação; user ID vem somente da sessão; a organização enviada é contexto não confiável; nenhuma rota tenant neste PR. |
| Membership, capability e status | Concluídos | Uma transação valida membership active, capability central e organização active antes do callback tenant; GUC de organização só é setado após membership/capability. |
| RLS, grants e migration | Concluídos após correção de segurança | Migrations 0007/0008 deixam ENABLE/FORCE RLS, duas policies de SELECT e grant SELECT-only; runtime não tem INSERT/UPDATE/DELETE em organizations/memberships, mesmo com GUCs falsificados. |
| Onboarding gravável pelo runtime | Adiado | O use case interno continua idempotente, mas exige conexão privilegiada separadamente controlada; foi validado com owner BYPASSRLS. Sem rota HTTP ou INSERT grant para runtime até existir writer controlado. |
| Reconciliação do fixture PR11 | Concluída | A URL descartável tinha somente a fixture RLS sintética, role runtime e journal vazio. Preflight validou tabela/policy/grants e duas sementes, mais uma única retry UUID conhecida; a tabela foi recriada pela cadeia Drizzle e as sementes-base foram restauradas. Nenhum outro objeto público foi alterado. |
| Gate Neon PostgreSQL | Concluído | `server_version` 18.6 (gate exige major 18); polaris_pr11_runtime NOBYPASSRLS e sem ownership; conexão owner BYPASSRLS; duas policies SELECT; leituras próprias e isolamento cross-tenant passaram; INSERT runtime negado mesmo com GUCs falsificados; onboarding/retry pelo owner, rollback e reuso do mesmo backend passaram; revoke temporário foi verificado. |
| Rota de produto / gate Worker específico | Adiados | Conforme plano PR22, nenhuma rota tenant foi exposta. O gate PR11 Worker → Hyperdrive → Neon continua como prova de pooling/contexto; uma rota tenant exige gate próprio antes de feature de produto. |
| Check e build final | Concluídos | Após as correções: `bun run check` passou (72 testes em 10 arquivos, lint, format, typecheck, boundaries e Knip); `bun run build` passou nos oito workspaces. |
| Revisão independente | Concluída sem blockers | A primeira revisão encontrou INSERT persistente autorizável por GUC forgeável e cleanup frágil; correções foram aplicadas; o follow-up não encontrou achados Critical, Important ou Minor. |
| Draft PR e CI remoto | Concluídos | Draft PR [#20](https://github.com/camilagama/polaris/pull/20) publicado sobre PR #19; CI 6/6 verde no commit de código `17dff66`. |
| Revisão do usuário | Continuidade autorizada | O usuário respondeu “prossiga” para a próxima etapa; PR #20 continua draft e sem merge enquanto PR23 é implementado sobre ele. |

### Gate 2 — aprovado tecnicamente

| Critério | Status | Evidência / trabalho restante |
| --- | --- | --- |
| Autenticação | Gate aprovado; integrações externas adiadas | O Worker validou sessão Better Auth e email verificado. OAuth Google, email/Resend, Turnstile e credenciais reais continuam pré-go-live. |
| Organização inicial | Concluída | RPC deriva o ator da sessão; função SECURITY DEFINER usa `ONBOARDING_HYPERDRIVE` e role dedicada. Gate PostgreSQL e Worker passaram com onboarding idempotente e auditado. |
| Contexto e tenancy | Concluídos | Worker local passou autenticação, `category.list/create`, capability server-side e negação de acesso cross-tenant. |
| RLS em entidade de negócio | Concluído | Migration 0012 aplicada à branch descartável Neon PostgreSQL 18.6. `categories` tem ENABLE/FORCE RLS, grants mínimos, isolamento e negação de DML forjado confirmados. |
| Capabilities | Concluídas | `catalog:read` e `category:create` foram exercitadas pelos procedimentos do Worker; auditoria da criação passou. |
| Gate PostgreSQL + Worker | Concluídos | Gates passaram na branch `gate2-runtime-proof`, região São Paulo, PostgreSQL 18.6. O database gate confirmou roles, grants, SECURITY DEFINER, rollback e cascade; o Worker confirmou onboarding, retry, isolamento e auditoria. Branch é descartável e expira automaticamente. |
| Revisão independente | Concluída, sem achados Critical/Important | Um achado Minor sobre registro incremental de fixtures foi corrigido; revisão final recomendou seguir. |
| Check e build finais | Concluídos | `bun run check`: lint, formato, typecheck, boundaries, Knip e 79 testes em 13 arquivos passaram. `bun run build` passou nos oito workspaces. |
| Draft PR e CI | Concluídos no commit de implementação | Draft PR [#22](https://github.com/camilagama/polaris/pull/22) publicado sobre `codex/pr23-tenant-audit`; CI 6/6 verde no commit `a1de720`. Continua draft e sem merge. |
| Próxima etapa | PR24 em andamento | O responsável autorizou avançar antes da revisão humana do PR #22. PR24 fica empilhado sobre o PR22 draft; ambos permanecem sem merge até revisão. |
### PR23 — checkpoint para revisão

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Plano, escopo e worktree | Concluídos | PR23 autorizado por “prossiga”; branch codex/pr23-tenant-audit baseada no HEAD do PR22. Leitura de histórico e rota ficam fora do escopo. |
| Modelo e privacidade | Concluídos | Stream tenant separado do auth audit; organização, ator interno, tipo/alvo, request ID UUID opcional e timestamp; sem payload livre, snapshots ou secrets. Retenção legal permanece pré-go-live. |
| Schema, RLS e writer | Concluídos | Migration 0009 cria tenant_audit_event com ENABLE/FORCE RLS e INSERT-only; migrations 0010/0011 limitam códigos e exigem entity ID UUID. Runtime não recebe SELECT/UPDATE/DELETE; writer usa a transação e identidade existentes. |
| Mutação transacional | Concluída | organization.created é auditado junto com organização e membership no onboarding owner-only; retry idempotente não duplica o evento. |
| Gate Neon PostgreSQL | Concluído após hardening | PostgreSQL 18.6 descartável: onboarding, INSERT autorizado, cross-tenant negado, runtime SELECT negado, email em entity ID rejeitado, rollback conjunto e cascade de purge passaram; runtime NOBYPASSRLS/não-owner. Uma execução inicial retornou `timeout expired`; probe read-only confirmou DB/migration 0011 e gates subsequentes passaram; causa inicial não confirmada. |
| Check e build | Concluídos após hardening | `bun run check` passou com 75 testes em 11 arquivos; `bun run build` passou nos oito workspaces. |
| Revisão independente | Concluída sem achados | A revisão final não encontrou Critical/Important/Minor; ID opaco UUID e cleanup independente corrigiram os dois minors. Um timeout inicial do gate não se reproduziu nas verificações posteriores; causa não confirmada. |
| Draft PR e CI remoto | Concluídos | [GitHub PR #21](https://github.com/camilagama/polaris/pull/21), draft empilhado sobre PR #20; os seis checks passaram no commit bab4ce7, incluindo o gate de navegador offline. |
| Revisão do usuário | Pendente | PR #21 aguarda sua revisão; nenhum merge foi feito. |
| Retenção e histórico de audit | Adiados | Sem expiração automática ou leitor de eventos; decidir retenção/legal hold e autorização de leitura antes do go-live. |

### PR24 — Categories (em andamento; revisão humana pendente)

| Subetapa | Status | Evidência / trabalho restante |
| --- | --- | --- |
| Sequência e worktree | Concluídos | Por autorização do responsável (“prossiga”), branch `codex/pr24-categories` foi criada sobre o head `afe056d` do PR22 antes da revisão humana. PR22 segue draft; PR24 será empilhado nele e nenhum dos dois será mesclado nesta etapa. |
| Regras de catálogo | Definidas | Nomes únicos por organização ignorando caixa/espaços externos conforme resposta do responsável; rename em ativos/arquivados; archive reversível; tombstone terminal sem hard-delete. Produtos ainda não existem; PR25 deverá bloquear remoção com referência ativa. |
| Schema e RPC | Implementados e aplicados à branch de teste | Migration 0013 adiciona lifecycle, índice único, policy/grant UPDATE sem DELETE físico; procedures create/list/rename/archive/restore/delete registram auditoria transacional. Aplicada na branch descartável `gate2-runtime-proof`, PostgreSQL 18.6. |
| Read contract e UI | Implementados localmente | DTO estável com UUID, organização, nome, estado e timestamps serializados; tela de gestão responsiva com temas claro/escuro. Cache, comandos e sync offline e UI de login permanecem adiados. |
| Verificação local | Concluída | `bun run check`: lint, format, types, boundaries, Knip e 91 testes em 14 arquivos passaram. `bun run build` passou nos oito workspaces; `db:generate` não encontrou mudanças adicionais. |
| Gate Neon PostgreSQL + Worker | Concluído | O gate PostgreSQL passou em 18.6: RLS/grants, isolamento cross-tenant, unicidade dentro da organização e nome repetido permitido entre organizações, lifecycle, auditoria, rollback e cascade. O gate Worker local passou autenticação, onboarding idempotente, capabilities, conflito/rename, lifecycle, leitura e auditoria. Produção não foi tocada. Uma primeira fixture de rename usou outra organização e foi corrigida; a falha inicial do Worker não se reproduziu no gate completo posterior. |
| Cleanup da branch Neon | Pendente de expiração automática | Não restaram categorias, organizações ou memberships dos gates, nem roles temporárias `polaris_g2_*`. Um registro de usuário de teste `Gate 2 unverified` permanece sem memberships, sessões ou accounts, após uma execução anterior com falha de cleanup; a branch descartável expira automaticamente. Nenhum dado de produção foi alterado. |
| Revisão independente | Concluída após correção | A revisão identificou que `maxLength` do HTML limita unidades UTF-16 e poderia truncar nomes com emojis. A documentação Zod 4.6.5 confirma que `.max()` conta code points; o contrato e a UI agora usam validação/contador explícitos alinhados ao domínio. Regressão RPC confirma 100 emojis aceitos e 101 rejeitados. Nenhum outro achado concreto foi reportado. |
| Draft PR e CI | Concluídos no commit de implementação | [PR #23](https://github.com/camilagama/polaris/pull/23), draft empilhado sobre PR #22. Commit `3b387f5` publicado; GitHub Actions 6/6 passaram, incluindo o gate Playwright. PR permanece draft, sem conflito e sem merge. |

### PR25 — Products (draft publicado; revisão do usuário pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Sequência e regra de variantes | Concluídas | PR25 adiciona a estrutura mínima de product_variants e cria a variante padrão na mesma transação do produto. PR26 foi atualizado para ampliar essa tabela e trocar a variante padrão por combinações atomicamente. Nomes repetidos são permitidos conforme decisão do responsável; não foi inventado limite de comprimento. |
| Schema e migrations 0014/0015 | Concluídas | Migration 0014 cria products/product_variants com FKs compostas; migration 0015 adiciona índice `(organization_id, category_id)` para o guard de tombstone. Ambas aplicadas somente à branch Neon descartável PostgreSQL 18.6. |
| Invariantes e RLS | Concluídos | RLS habilitado/forçado, policies e grants restritos; trigger diferido exige variante; categoria arquivada não recebe novos vínculos; tombstone é bloqueado enquanto produtos a referenciam. Gate PostgreSQL 18.6 passou após 0015; `pg_indexes` confirmou o novo índice; isolamento, UUIDv7, lifecycle/version, auditoria, rollback e cascade passaram. |
| RPC, domínio e UI | Concluídos | Criar/listar/editar/arquivar/restaurar com capabilities, optimistic version e auditoria; página de produtos com criação, edição, categorias, status, loading/vazio/erro. Estoque, custo, preço, SKU, opções, mídia, escrita offline e exclusão de produto ficam adiados. |
| Gate Worker | Concluído em branch descartável | Worker local autenticado provou onboarding, categorias e produtos, duplicatas, variante default, isolamento, lifecycle/version, bloqueio do tombstone e auditoria. A emulação local de Hyperdrive aponta timeout de conexão no SELECT de sessão; o harness usa override de 30 s, enquanto o default fora do gate permanece 5 s. |
| Verificação local | Concluída após 0015 | `bun run check`: 101 testes em 17 arquivos; lint, format, typecheck, boundaries e Knip passaram. `bun run build` passou nos oito workspaces. `db:generate` não encontrou drift. |
| Revisão independente | Concluída | A revisão apontou ausência de índice para o predicado do guard de tombstone. Migration 0015 corrigiu o caminho; a revisão focada do follow-up não encontrou achados. |
| Draft PR e CI | Concluídos | [PR #24](https://github.com/camilagama/polaris/pull/24) está como draft, empilhado sobre [PR #23](https://github.com/camilagama/polaris/pull/23); CI 6/6 passou no commit `cb60ef7`, incluindo o gate Playwright. Permanece sem merge e aguarda revisão do responsável. |
| Branch Neon descartável | Expiração automática | `gate2-runtime-proof` (`br-autumn-resonance-b6jkwg2y`) está no projeto `polaris-pr11-rls-gate`, PostgreSQL 18.6, São Paulo, e expira em 2026-10-09 13:02 (America/Sao_Paulo). Migrations 0014/0015 permanecem apenas nessa branch de teste. |

### PR26 — Variants (implementado; publicação pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Regras de domínio | Concluídas | O responsável confirmou subconjuntos de Modelo/Cor/Tamanho; valores aparados, não vazios, preservando caixa e únicos por opção sem distinção de caixa; combinação completa e única; teto 50 no estado final da transação. PR26 configura uma vez; reconfiguração/remoção aguardam regras de preservação dos IDs para SKU/estoque. |
| Worktree e baseline | Concluídos | Branch `codex/pr26-variants` criada sobre o head `8230577` do PR25. `bun install --frozen-lockfile`, `bun run check` (101 testes) e `bun run build` dos oito workspaces passaram antes da implementação. |
| Domínio | Concluído | Normalização valida subconjuntos, valores únicos e combinações completas e não repetidas; 7 testes red-first passaram. Configuração inicial versionada e auditada; edição posterior está adiada. |
| Schema, repositório e migration 0016 | Concluídos em branch descartável | Novas tabelas com FKs compostas tenant/product, RLS/grants mínimos, UUIDv7, posições estáveis e constraints diferidas. Migration aplicada somente à branch Neon `gate2-runtime-proof` (PostgreSQL 18.6). |
| Contratos e RPC | Concluídos | `product.getVariants` exige `catalog:read`; `product.configureVariants` exige `product:update`, `expectedVersion` e audita a troca inicial do default. Testes RPC confirmam capabilities, versões e erros. |
| UI | Concluída | Painel acessível seleciona opções, cadastra valores e combinações manualmente e lista variantes após configuração. Sem geração cartesiana; edição posterior adiada por preservação dos IDs. |
| Verificação local | Concluída | `bun run check`: 111 testes em 18 arquivos; lint, format, typecheck, boundaries, Knip passaram. `bun run build` passou nos oito workspaces; `db:generate` não encontrou drift. |
| Gate Neon PostgreSQL 18 | Concluído | PostgreSQL 18.6 após a correção de leitura: RLS/grants, incluindo `FOR SHARE` com o papel runtime, e isolamento; troca default→combinações explícitas (3 de 4 possíveis); UUIDv7 e audit; configuração única; concorrência com um vencedor; teto final 50 aceito e 51 rejeitado; lifecycle, rollback e cascade. |
| Gate Worker | Concluído | Runtime local autenticado passou onboarding e RPC de variantes: criação, configuração, releitura, audit, negação cross-tenant e conflito ao tentar reconfigurar. Fixtures temporárias limpas. |
| Revisão independente | Concluída | Revisão sem blockers. O revisor identificou uma corrida entre a leitura do marcador e as consultas das variantes; `getProductVariants` agora trava a linha do produto com `FOR SHARE`, serializando a resposta com a configuração `FOR UPDATE`. O follow-up confirmou grants/RLS, compatibilidade com `READ COMMITTED` e efeito de espera breve sobre alterações concorrentes no produto. |
| Draft PR e CI | Concluídos | [GitHub PR #25](https://github.com/camilagama/polaris/pull/25) publicado como draft, empilhado sobre PR #24; CI 6/6 verde no commit de código `e9f9f5a`; sem merge. |
| Branch Neon descartável | Expiração automática | `gate2-runtime-proof` (`br-autumn-resonance-b6jkwg2y`) no projeto `polaris-pr11-rls-gate`, PostgreSQL 18.6, São Paulo, expira em 2026-10-09 13:02 (America/Sao_Paulo). Migration 0016 e fixtures de gate permanecem apenas nessa branch. |

## Publicação GitHub

- `origin` aponta para https://github.com/camilagama/polaris.git; o checkout de referência permanece em `main`.
- PRs draft empilhados: #1 chore/workspace-boundaries → main; #2 docs/canonical-docs → #1; #3 ci/baseline → #2; #4 chore/renovate-policy → #3; #5 feat/web-worker → #4; #6 feat/hono-shell → #5; #7 feat/orpc-poc → #6; #8 feat/postgres-hyperdrive-poc → #7; #9 codex/pr11-rls-hyperdrive-gate → #8; #10 codex/pr12-offline-persistence → #9; #11 codex/pr13-better-auth → #10; #12 codex/pr14-google → #11; #13 codex/pr15-password → #12; #14 codex/pr16-turnstile → #13; #15 codex/pr17-account-linking → #14; #16 codex/pr18-sessions → #15; #17 codex/pr19-organizations → #16; #18 codex/pr20-onboarding → #17; #19 codex/pr21-capabilities → #18; #20 codex/pr22-tenant-context → #19; #21 codex/pr23-tenant-audit → #20.
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
- PR17 está como draft em https://github.com/camilagama/polaris/pull/15, empilhado sobre PR16. Implementação passou bun run check (47 testes, 10 novos) e bun run build; revisão independente sem blockers; os seis checks remotos, incluindo Playwright, passaram no commit de código a5fdbff. OAuth Google real e UI de gerenciamento permanecem adiados; nenhuma credencial ou recurso externo foi configurado.
- PR18 está como draft em https://github.com/camilagama/polaris/pull/16, empilhado sobre PR17. 54 testes, check e build passaram; o gate de sessão PostgreSQL 18 passou na branch Neon descartável; revisão independente sem blockers; CI 6/6 verde no commit de código dcf42ab. UI de gerenciamento permanece adiada; a branch de teste expira automaticamente em 2026-10-08 às 21:30 (America/Sao_Paulo).
- PR19 está como draft em https://github.com/camilagama/polaris/pull/17, empilhado sobre PR18. `bun run check` passou com 54 testes; `bun run build` passou nos oito workspaces; CI remoto 6/6 verde, incluindo 16/16 testes Playwright desktop/mobile emulado. Gate PostgreSQL 18 em branch Neon descartável passou; revisão independente sem blockers. PR20 foi autorizado pelo usuário em 8 de outubro; PR21 foi autorizado pelo usuário em 8 de outubro; o mapa local de capabilities foi implementado e revisado sem blockers na branch codex/pr21-capabilities.
- PR20 está como draft em https://github.com/camilagama/polaris/pull/18, empilhado sobre PR19. `bun run check` passou com 58 testes; `bun run build` passou nos oito workspaces; CI remoto 6/6 verde no commit `f6e3cda`. O gate PG18 descartável verificou criação, retry idempotente, concorrência, email/timezone, privilégios runtime e limpeza. Revisão independente sem blockers. PR21 foi autorizado pelo usuário em 8 de outubro; o mapa local foi implementado e revisado sem blockers, com draft PR/CI pendentes.
- PR21 está como draft em https://github.com/camilagama/polaris/pull/19, empilhado sobre PR20. O mapa owner→capabilities está centralizado no package domain; roles/capabilities desconhecidos falham fechado. `bun run check` passou com 62 testes; build dos oito workspaces passou; CI remoto 6/6 verde no commit `99d1860`; revisão independente sem blockers. PR22 foi implementado na branch `codex/pr22-tenant-context`; gate Neon PostgreSQL 18.6 e check/build locais passaram. O review encontrou e levou à remoção do INSERT runtime baseado em GUC; follow-up sem achados; draft PR #20 publicado e CI 6/6 verde no commit `17dff66`; revisão do usuário pendente. PR #19 permanece draft sem merge.
- A etapa PR23 está como draft no [GitHub PR #21](https://github.com/camilagama/polaris/pull/21), empilhada sobre PR #20; bun run check (75 testes), build em oito workspaces, gate Neon PostgreSQL 18.6 e revisão independente passaram; CI remoto 6/6 passou no commit de código bab4ce7. Retenção/legal hold e leitor do histórico de audit permanecem adiados até antes do go-live; revisão do usuário pendente, sem merge.
- PR25 Products está publicado como [GitHub PR #24](https://github.com/camilagama/polaris/pull/24), draft empilhado sobre PR #23; migration 0015, gate PostgreSQL 18.6 e revisão independente passaram; CI remoto 6/6 passou no commit `cb60ef7`. O PR aguarda revisão e segue sem merge.
- PR26 Variants está publicado como [GitHub PR #25](https://github.com/camilagama/polaris/pull/25), draft empilhado sobre PR #24. `bun run check` passou com 111 testes; build dos oito workspaces, gate Neon PostgreSQL 18.6, gate Worker local e revisão independente passaram. CI remoto 6/6 verde no commit de código `e9f9f5a`. Configuração é inicial; edição/remoção aguardam decisão sobre referências de SKU/estoque. O PR segue sem merge.

### PR27 — SKU (regras confirmadas; implementação em andamento)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Escopo documentado | Concluído | PR27 adiciona SKU opcional à variante, único por organização; o mesmo valor em organizações diferentes é permitido. Código de barras segue fora da V1. |
| Normalização | Concluída | O responsável confirmou aparar espaços, tratar vazio como ausência, preservar a grafia e comparar sem distinção de caixa dentro da organização, sem limite inventado de tamanho/formato. |
| Worktree e baseline | Concluídos | Branch `codex/pr27-sku` criada sobre o head `3633d3f` do PR26. `bun install --frozen-lockfile`, `bun run check` (111 testes) e `bun run build` nos oito workspaces passaram sem mudanças de código. |
| Troca/limpeza de SKU | Concluída | O responsável confirmou atribuir, trocar ou limpar o SKU em uma variante existente; mudanças reais usam `expectedVersion` do produto, incrementam a versão, gravam auditoria e preservam o UUID da variante. |
| SKU na variante padrão | Concluído | O responsável confirmou bloquear configuração de opções enquanto a variante padrão tiver SKU; ele deve ser limpo e atribuído à combinação correta após configurar. A camada de domínio e o banco rejeitam a exclusão que perderia esse SKU. |
| Implementação | Concluída | Migration 0017, normalização, índice tenant-scoped case-insensitive, update column-level sob RLS, mutation versionada/auditada e edição dos SKUs no painel. Configuração da variante padrão é bloqueada enquanto houver SKU; o SKU precisa ser limpo antes de a configuração inicial substituí-la. |
| Verificação local | Concluída | `bun run check`: 117 testes em 19 arquivos; lint, formatação, tipos, boundaries e Knip passaram. `bun run build` passou nos oito workspaces; `db:generate` não encontrou drift. |
| Gate Neon PostgreSQL 18 | Concluído em branch descartável | A branch antiga `gate2-runtime-proof` expirou. Criada `pr27-sku-gate` no projeto `polaris-pr11-rls-gate`, região São Paulo, PostgreSQL 18.6, com auto-expiração em 2026-10-10 17:37 (America/Sao_Paulo). Migrations 0012–0017 foram aplicadas pelo SQL Editor e registradas no journal Drizzle. `poc:gate2:verify` passou: RLS/grants, onboarding, categorias, lifecycle, variantes, SKU, auditoria, concorrência, limite, rollback e cascade. Provas SQL adicionais passaram; fixtures, logins temporários e SKUs foram removidos, e a membership temporária foi revogada/restaurada. |
| Gate Worker | Concluído localmente | `test:gate2-worker` terminou com exit code 0 na branch descartável. Passaram autenticação, onboarding, isolamento, categorias, produtos, variantes, SKU (normalização, conflito, troca/limpeza e auditoria) e lifecycle. Logins/fixtures temporários foram limpos; produção e recursos Cloudflare remotos não foram alterados. |
| Revisão independente | Concluída | Revisão do commit `464d1c1` sem achados; o revisor confirmou consistência da migration/RLS, versionamento e auditoria atômicos, conflitos de unicidade, limpeza/reuso e bloqueio de perda do SKU padrão. |
| Draft PR e CI | Concluídos | [PR #26](https://github.com/camilagama/polaris/pull/26) publicado em draft, empilhado sobre PR #25. CI remoto passou 6/6 nos commits `d1d945b` e `bc74545`; sem merge. |

### PR28 — Inventory ledger (implementação e gates concluídos; draft PR #27 aberto; revisão do usuário pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Regras confirmadas | Concluídas | O responsável confirmou um saldo por organização e variante, sem locais/depósitos; variante sem movimentos lê como quantidade zero. Também confirmou bloquear a configuração inicial depois de qualquer movimento na variante padrão, preservando UUID e histórico sem transferência presumida. |
| Worktree e baseline | Concluídos | Branch `codex/pr28-inventory` criada sobre `codex/pr27-sku`; `bun install --frozen-lockfile`, `bun run check` (117 testes) e `bun run build` nos oito workspaces passaram antes das mudanças. |
| Modelo e implementação | Concluídos | Schema, migration 0018, RLS/grants, projeção lazy e primitivo interno de movimento+saldo+audit em transação tenant-scoped; sem UI/RPC nem command genérico. Os commands `receiveStock`, `writeOffStock` e `inventoryCount` seguem para PR29–31; custo médio e rounding para PR29. |
| Verificação local | Concluída | `bun run check`: 122 testes, lint, formato, typecheck, boundaries e Knip passaram; `bun run build`: oito workspaces passaram. |
| Gate Neon PostgreSQL 18 | Concluído | Migration aplicada e gate passou em PostgreSQL 18.6 na branch descartável `pr28-inventory-gate`; verificou RLS/grants, rollback atômico, concorrência, saldo não negativo, isolamento, ledger append-only e bloqueio da variante padrão mesmo após saldo voltar a zero. A branch expira automaticamente em 2026-10-10 18:47 BRT; as fixtures são sintéticas e ficam nela até expirar. |
| Purge físico com histórico | Adiado | ON DELETE RESTRICT e ledger append-only bloqueiam purge físico de organização com movimentos. PR107 precisa definir e validar um caminho privilegiado compatível com retenção/deletion ledger antes do go-live. |
| Revisão independente | Concluída | Revisor independente sem achados; confirmou as transações, RLS, grants, proteção de histórico, gate PostgreSQL 18 e a dependência de purge registrada para PR107. |
| Draft PR e CI remoto | Concluídos | [PR #27](https://github.com/camilagama/polaris/pull/27), draft empilhado sobre PR #26; CI remoto 6/6 passou no commit `5043a51`; sem merge. |
| Revisão do usuário | Pendente | PR #27 aguarda revisão; não será mergeado sem autorização. |

### PR29 — Receive stock (implementação, gates e CI concluídos; PR #28 draft; revisão pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base isolada | Concluída | Branch local codex/pr29-recovery baseada no head c9f94a1 do PR #27; alterações de PR29 isoladas da branch principal. |
| Política monetária e data de ocorrência | Concluída | Custo unitário/médio com até 18 dígitos inteiros e 6 casas, aritmética decimal exata e half-up após cada recebimento; occurredOn é data de calendário e a média segue a ordem de confirmação no servidor. ADR 0008 registra a escolha. |
| Compatibilidade de histórico anterior | Concluída | PR28 podia criar receipts internos sem custo; a migration 0020 usa CHECK NOT VALID para preservar linhas append-only existentes sem inventar valoração. PostgreSQL ainda aplica a constraint aos novos writes. ADR 0009 documenta o comportamento. |
| Implementação | Concluída | receiveStock valida data/custo/quantidade, calcula custo médio exato, persiste custo e metadados idempotentes, grava ledger+saldo+audit na mesma transação e exige inventory:adjust. O writer genérico rejeita receipts; migrations 0019–0020 acrescentam campos e constraints. |
| Verificação local | Concluída | bun run check: lint, formato, typecheck nos oito workspaces, boundaries, Knip e 135 testes passaram. bun run build: oito workspaces passaram; Wrangler emitiu aviso EPERM ao gravar log local, mas o build terminou com exit code 0. |
| Revisão independente | Concluída | A revisão encontrou risco de compatibilidade com receipts PR28 sem custo; migration 0020 foi alterada para NOT VALID e o gate agora prova compatibilidade do histórico e rejeição de novos receipts inválidos. Revisor não encontrou outros achados críticos/importantes. |
| Gate Neon PostgreSQL 18 | Concluído | O gate passou em PostgreSQL 18.6 na branch descartável `pr28-inventory-gate`; migrations 0019–0020 aplicadas e 19 verificações passaram, incluindo RLS/grants, rollback atômico, idempotência, custo médio half-up, concorrência sem saldo negativo, append-only, proteção de variantes com histórico e auditoria. O resultado reportou 15 movimentos; fixtures sintéticas permanecem até a expiração automática da branch em 2026-10-10 18:47 BRT. A branch schema-only `pr29-receive-stock-gate`, sem dados, também permanece até 2026-10-10 23:58 BRT e não foi usada neste gate. |
| Saldo positivo com custo desconhecido | Adiada | receiveStock bloqueia o recebimento se o saldo for positivo e o custo médio nulo. PR31 deve definir a valoração da contagem inicial; nenhum custo histórico é presumido. |
| Push e PR draft | Concluídos | Branch `codex/pr29-receive-stock` publicada e [PR #28](https://github.com/camilagama/polaris/pull/28) aberto em draft contra `codex/pr28-inventory` (PR #27); os dois commits locais estão no PR. Nenhum merge foi feito. |
| CI remoto | Concluído | GitHub Actions run #70 passou 6/6 no commit `d3113cc`: build, Knip, lint/boundaries, typecheck, 135 unit tests e offline persistence browser gate. |
| Revisão do usuário | Pendente | PR #28 segue em draft e aguarda revisão; nenhum merge será feito sem autorização. |

### PR30 — Write-off stock (implementação, gate remoto e CI concluídos; revisão do usuário pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Worktree e baseline | Concluídos | Worktree isolado `D:\2 - Dev\2 - Worktree\pr30-write-off\polaris`, branch `codex/pr30-write-off-stock` baseada no commit `5ed1f5d` do PR #28; dependências instaladas do lockfile. O CI de base passou 6/6. |
| Motivo estruturado | Concluído | Usuário confirmou a lista fechada `damaged`, `expired`, `lost`, `stolen`, `internal_use`, `other`, com nota obrigatória para `other`. |
| Data de ocorrência | Concluída | Usuário confirmou `occurredOn` obrigatório como data de calendário da organização, seguindo `receiveStock`. |
| Valoração da baixa | Proposta para revisão | Implementação proposta preserva a média móvel, captura o snapshot unitário quando conhecido, permite baixar saldo sem custo conhecido com snapshot nulo e não cria lançamento de despesa. Decisão está em ADR 0010. |
| Implementação | Concluída | `writeOffStock` nomeado grava ledger, saldo, audit e metadados na transação tenant-scoped; writer genérico rejeita write-offs. Contrato RPC, validação/versionamento, idempotência, motivo estruturado, snapshot de custo e compatibilidade append-only estão cobertos. Migration 0021 adiciona motivo/nota e constraint `NOT VALID`, preservando baixas históricas sem metadados. |
| Revisão independente | Concluída | Sem achados restantes após fechar limite de nota em 500 pontos de código, equivalência do trimming Unicode entre JS e PostgreSQL e status proposto da valoração no ADR. |
| Verificação local | Concluída | `bun run db:generate` não encontrou drift; `bun run check` passou com 144 testes; `bun run build` passou nos oito workspaces. O build foi repetido isoladamente após uma corrida transitória com a fixture temporária de boundaries do check. |
| Gate Neon PostgreSQL 18 | Concluído | Migration 0021 aplicada; gate passou em PostgreSQL 18.6 na branch descartável `pr28-inventory-gate`. Verificou RLS/grants, motivo/data/nota, limite e trimming Unicode, snapshot de custo, replay/conflito, saldo não negativo, custo desconhecido, concorrência, isolamento e audit. Resultado: 18 movimentos; fixtures sintéticas permanecem até a expiração automática da branch em 2026-10-10 18:47 BRT. |
| Push e PR draft | Concluídos | Branch `codex/pr30-write-off-stock` publicada; [PR #29](https://github.com/camilagama/polaris/pull/29) aberto em draft, empilhado sobre PR #28. |
| CI remoto | Concluído na revisão atual | GitHub Actions passou 6/6 no commit `8826a63` (build, Knip, lint/boundaries, typecheck, testes unitários e offline browser gate). |
| Revisão do usuário | Pendente | Revisar a proposta de valoração em ADR 0010 e o PR draft; decisão sobre custo permanece proposta, não aprovada. |

### PR31 — Inventory count (implementação e publicação concluídas; CI passou; gate remoto e revisão pendentes)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base isolada | Concluída | Branch `codex/pr31-inventory-count` criada em clone isolado; a branch principal permaneceu intacta. |
| Contrato e concorrência | Concluídos | `inventory.getBalance` expõe a versão do saldo; `inventoryCount` exige `expectedVersion`, quantidade física absoluta e identidade idempotente. A checagem ocorre sob lock da variante; versões antigas conflitam. |
| Evento de contagem sem diferença | Concluído | Delta zero é persistido como `inventory_count`, auditado e incrementa a versão do saldo; replay compara quantidade absoluta e versão originais, inclusive após comandos posteriores. |
| Valoração | Proposta para revisão | Custo conhecido é preservado; custo desconhecido permanece `NULL` salvo `valuationUnitCost` explícito em uma contagem positiva. Custo zero não é presumido; recebimentos continuam bloqueados com saldo positivo sem valoração. Decisão está no ADR 0011, proposto. |
| Migration 0022 | Implementada localmente | Armazena quantidade física, versão esperada e input de valoração explícita separado do snapshot efetivo; CHECKs `NOT VALID` preservam movimentos `inventory_count` históricos append-only e impedem valoração explícita com quantidade física zero. Aplicação em Neon ainda pendente. |
| Revisão independente | Concluída | O revisor encontrou replay que podia omitir uma valoração explícita; input separado e comparação idempotente foram adicionados. Também identificou e verificou a constraint DB contra valuation explícita com quantidade zero; sem achados restantes no follow-up. |
| Verificação local | Concluída | `bun run check` passou: lint, formatação, typecheck nos oito workspaces, boundaries, Knip e 154 testes em 25 arquivos. |
| Build local | Concluído | `bun run build` passou nos oito workspaces após a implementação. Wrangler exibiu `EPERM` ao gravar log local, mas o build terminou com exit code 0. |
| Perfis de CLI | Corrigidos | A política separa as identidades: Cloudflare `junior-pessoal` → `contato.juniordiniz@gmail.com`; Neon `junior-pessoal` → `juniordiniz56@gmail.com`. O runbook em `docs/runbooks/cli-profile-policy.md` é a fonte autoritativa; Neon plugin conectado continua fora de uso. |
| Gate Neon PostgreSQL 18 | Pendente | Migration 0022 ainda não foi aplicada. A URL de conexão anterior não foi reutilizada; para provar migration, RLS, idempotência e concorrência é necessária uma branch descartável acessível. O caminho pelo console Neon não ficou disponível nesta sessão. |
| UI de contagem | Adiada | O PR31 no plano define o command e os dados, mas não especifica fluxo/tela de contagem; não inventar interação visual sem critério de aceite. |
| Push e PR draft | Concluídos | Branch `codex/pr31-inventory-count` publicada e [PR #30](https://github.com/camilagama/polaris/pull/30) aberto em draft contra `main`. Nenhum merge foi feito. |
| CI remoto | Concluído | GitHub Actions passou 6/6 no commit `95dbc20`: build, Knip, lint/boundaries, typecheck, testes unitários e offline persistence browser gate. O PR está limpo e mergeable, mas permanece draft. |
| Revisão do usuário | Pendente | Revisar o PR #30 e ADR 0011, especialmente a proposta de `valuationUnitCost` opcional. Nenhum merge será feito sem autorização. |

### PR32 — Archive/delete catalog (implementação, revisão estática, verificações locais e remotas, publicação e CI concluídos; revisão do usuário pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base isolada | Concluída | Branch codex/pr32-archive-catalog criada sobre o head 95dbc20 do PR31; branch principal e PR31 permaneceram intactos. |
| Correção da identidade Neon | Concluída | O perfil `junior-pessoal` usa `juniordiniz56@gmail.com`, confirmado por `neon me` antes do gate. As operações de banco ficaram restritas à branch descartável `pr32-archive-catalog-gate`. |
| Regra de tombstone | Confirmada | Usuário aprovou tombstone terminal com saldo agregado zero, mesmo havendo movimentos históricos; preservar variantes, UUIDs, SKUs, ledger, vínculos e auditoria; saldo positivo bloqueia. |
| Archive/restore | Reutilizados | Já implementados no PR25. PR32 não os duplica; adiciona somente o comando terminal de remoção lógica. |
| Domínio e RPC | Implementados localmente | product.delete exige expectedVersion, atualiza lifecycle e auditoria na transação; repetição é idempotente. Produto tombstoned não admite restore, edição, SKU, configuração de variante ou novos movimentos; leitura histórica e replay permanecem válidos. |
| Migration 0023 | Aplicada e validada | `drizzle-kit migrate` aplicou as migrations pendentes 0019–0023 na branch Neon descartável `pr32-archive-catalog-gate`; `bun run db:generate` não encontrou drift. |
| Gate PostgreSQL | Implementado localmente | verify-inventory-gate.ts agora cobre tombstone com histórico e saldo zero, bloqueio de saldo positivo, proteção SQL direta, replay idempotente e corrida entre recebimento e tombstone. |
| Verificação local | Concluída | bun run check passou: lint, formatação, typecheck nos oito workspaces, boundaries, Knip e 157 testes em 25 arquivos. O check precisou rodar fora do sandbox devido a paths temporários inacessíveis do Vitest no sandbox do Windows. |
| Build local | Concluído | bun run build passou nos oito workspaces. |
| Gate Neon PostgreSQL 18 | Concluído | Gate passou em PostgreSQL 18.6 na branch `pr32-archive-catalog-gate`, derivada de `production`, com 26 movimentos e todos os cenários listados aprovados. A branch expira em 2026-10-10 13:00 BRT; fixtures sintéticas permanecem até a expiração. A connection string ficou somente no ambiente do processo. |
| UI de exclusão | Adiada | O plano não define affordance nem confirmação para uma ação terminal; archive/restore continuam como já implementados. |
| Revisão independente | Concluída sem achados | Revisão do diff `95dbc20..b3781fd`: nenhum achado crítico, importante ou menor. O gate PostgreSQL 18 passou na branch descartável `pr32-archive-catalog-gate`. |
| Push e PR draft | Concluídos | Branch `codex/pr32-archive-catalog` publicada; [PR #31](https://github.com/camilagama/polaris/pull/31) aberto em draft sobre `codex/pr31-inventory-count` (PR #30). Nenhum merge foi feito. |
| CI remoto | Concluído | GitHub Actions passou 6/6 no commit `5c3704a`: build, Knip, lint/boundaries, typecheck, testes unitários e offline persistence browser gate. |
### PR33 — Media schema (implementação, revisão independente, checks locais, gate Neon, publicação e CI concluídos; revisão do usuário pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Branch isolada | Concluída | `codex/pr33-media-schema` foi criada sobre o head `d0c6640` do PR32; ainda local, sem push. |
| Decisões de domínio | Confirmadas | Assets são por organização e vinculam a no máximo um produto; `variant_media` reutiliza o asset do mesmo produto. As tabelas de associação têm `position` ordenada, sem semântica separada de capa. |
| Migration 0024 | Implementada e aplicada | `media_assets`, `product_media` e `variant_media` com UUIDv7, FKs compostas, unicidade por produto/posição e `ON DELETE RESTRICT`. Storage/provider metadata e upload ficam para PR34. |
| RLS e grants | Concluídos | FORCE RLS nas três tabelas; runtime recebe somente SELECT neste schema-only PR. Triggers sincronizam escrita de associações com a linha do produto e bloqueiam mutações após tombstone. |
| Gate Neon PostgreSQL 18 | Concluído | Gate passou em PostgreSQL 18.6 na branch descartável `pr33-media-schema-gate`, derivada de `production`; oito grupos de cenário passaram. A branch expira em 2026-10-11 às 13:00 BRT; fixtures são sintéticas e permanecem até a expiração. URLs ficaram somente no ambiente dos processos. |
| Verificação local | Concluída | `bun run check` passou com 157 testes em 25 arquivos; lint, formato, typecheck, boundaries e Knip também passaram. `bun run db:generate` não encontrou drift. |
| Build local | Concluído | `bun run build` passou nos oito workspaces (exit code 0). Wrangler mostrou `EPERM` somente ao gravar log fora do repositório. |
| Upload, locator e metadata | Adiados | PR33 não faz upload e não persiste provider-specific fields; pipeline Cloudflare Images → WebP → R2 fica para PR34; derivados e cleanup para PR35. R2 permanece privado. |
| Quotas Free/Pro | Adiadas | `PRODUCT.md` classifica os limites como hipóteses ajustáveis; PR33 não fixa contagens em constraints. Enforcement fica no modelo de entitlements. |
| Revisão independente | Concluída sem achados | Revisão do diff `d0c6640..caf8824`: nenhum achado Critical, Important ou Minor; migration 0024, RLS/grants, guard de tombstone e gate revisados. |
| Push, PR draft e CI remoto | Concluídos | Branch `codex/pr33-media-schema` publicada; [PR #32](https://github.com/camilagama/polaris/pull/32) aberto em draft sobre `codex/pr32-archive-catalog` (PR #31). CI passou 6/6 no commit `5e66fba`: build, Knip, lint/boundaries, typecheck, testes unitários e offline persistence browser gate. Nenhum merge foi feito. |
| Revisão do usuário | Pendente | Revisar o PR33 draft e ADR 0013 depois da publicação. Nenhum merge será feito sem autorização. |

### PR34 — Upload/crop pipeline (implementação, gates, preview e validação no iPhone concluídos; revisão do PR pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Branch isolada | Concluída | `codex/pr34-media-upload` criada no clone de trabalho sobre `codex/pr33-media-schema`; `main` permaneceu intacta. |
| HEIC, recorte e saída | Concluídos localmente | Conversão HEIC/HEIF para JPEG no navegador, com fallback `<img>` para Safari; seleção de recorte por arraste/toque e teclado; recorte normalizado; Cloudflare Images configurado para WebP quality 85, limite de 1200 px e `scale-down` sem ampliação. |
| Migration 0025 e RLS/grants | Concluídos | Metadados de storage, tamanho, MIME, dimensões, fingerprint e upload command; runtime recebe `SELECT` e `INSERT`, sem `UPDATE`/`DELETE`; asset exige associação ao produto por trigger deferred. Migration aborta com mensagem explícita se `media_assets` já contiver linhas sem metadados migráveis. `bun run db:generate` não encontrou drift. |
| Rotas, repositório e painel | Concluídos localmente | Upload binário autenticado e tenant-scoped, leitura privada, fingerprint idempotente, posições append-only, auditoria e associação do mesmo asset a variantes do produto. IDs de variante são validados antes do R2. A chave R2 contém organização, produto, comando e fingerprint. Rejeições determinísticas antes do commit removem o objeto recém-criado; falhas ambíguas de commit podem deixar objeto privado órfão, cuja reconciliação geral fica para PR35. |
| Gate Neon PostgreSQL 18 | Concluído | `0025` aplicada e gate passou em PostgreSQL `18.6` na branch descartável `pr34-media-upload-gate`, projeto `green-tooth-16857010`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Verificou RLS/grants, inserts tenant-scoped, replay/conflito, mesma imagem associada a duas variantes do produto, bloqueio de associação do asset a outro produto, auditoria, constraints, asset órfão, cross-tenant em `media_assets`, `product_media` e `variant_media`, tombstone e imutabilidade. A branch expira em `2026-10-11 13:00 BRT`; fixtures sintéticas ficam até a expiração. URLs não foram registradas. |
| Verificação local | Concluída | `bun run check`: lint, formatação, tipos, boundaries, Knip e 189 testes em 30 arquivos passaram. |
| Build local | Concluído | `bun run build` passou nos oito workspaces. |
| Gate real Cloudflare Images/R2 | Concluído com ressalva registrada | O perfil `junior-pessoal` foi confirmado pela CLI `cf` como `contato.juniordiniz@gmail.com`; todos os comandos Cloudflare desta etapa usaram `--profile junior-pessoal`. A instalação global `cf` beta12 falhava ao iniciar `cf dev --remote` com `spawn EFTYPE`; `cf@1.0.0-beta.14` em execução isolada contornou o problema. Após o responsável habilitar R2 no Dashboard, `cf r2 buckets create --name polaris-media --profile junior-pessoal` criou o bucket. Workers temporários provaram Images e R2 separadamente e combinados: JPEG sintético 320×240 com crop central virou WebP 160×120, 292 bytes, assinatura RIFF/WEBP; R2 passou put/get, metadados, delete e confirmação de remoção. No teste combinado instrumentado, tanto o fluxo com resultado textual quanto o fluxo que gravou bytes WebP passaram e os objetos foram lidos e removidos. Uma primeira tentativa combinada respondeu HTTP 404/código 1042; o erro não se reproduziu no retry instrumentado e sua causa exata permanece desconhecida. Os Workers foram removidos; os prefixos de gate ficaram vazios. O bucket permanente `polaris-media` permanece criado e vazio. |
| Preview completo da aplicação | Concluído; recursos temporários removidos | O Worker `polaris-pr34-upload-preview` foi publicado com `cf@1.0.0-beta.14 --profile junior-pessoal` usando uma cópia isolada. A migração Wrangler→`cloudflare.config.ts` e o plugin Vite v2 beta ficaram somente nessa cópia; checkout e lockfile do PR não mudaram. Hyperdrive temporário `d146d27dfa3c40afb4637313b5477bbc` apontou para a branch descartável PR34 com o role `polaris_pr11_runtime`; o Worker usou R2 `polaris-media` e Images. Smoke headless confirmou sessão Better Auth, catálogo e painel “Imagens”, sem erros de página/RPC. Após o teste manual, o Worker (incluindo versões, deployments e secrets) e o Hyperdrive foram excluídos. O endpoint retorna 404, e a lista de Hyperdrive mantém apenas a configuração anterior do PR11. |
| Safari/iPhone | Concluído pelo responsável | No iPhone 12/iOS 26.6.2, em navegação Safari normal, o responsável confirmou que o fluxo de seleção HEIC, conversão, recorte, envio e exibição da miniatura funcionou como esperado, sem erros. O único objeto R2 do fixture foi apagado e o prefixo da organização ficou vazio; o bucket permanente `polaris-media` permanece criado e vazio. Usuário, organização, produto, sessão, associações de mídia e auditoria do fixture foram removidos da branch Neon; os demais fixtures do gate anterior não foram tocados. |
| Revisão independente | Concluída | Duas revisões estáticas corrigiram o gesto sem arraste, validação de variante pós-R2, cobertura cross-tenant de `variant_media` e compensação para rejeições determinísticas após storage. A reconciliação de falhas ambíguas permanece agendada para PR35. |
| Push da branch | Concluído | `codex/pr34-media-upload` publicada em `origin` sobre `codex/pr33-media-schema`; [PR #33](https://github.com/camilagama/polaris/pull/33) permanece em draft. |
| Draft PR e CI remoto | Concluídos | O workflow `38072317058` passou 6/6 no commit `a4d8708`: build, browser gate offline, unit tests, typecheck, lint/boundaries e Knip. Este checkpoint só altera documentação; PR #33 permanece draft e nenhum merge foi feito. |
| Revisão do usuário | Pendente | Revisar as regras documentadas, o diff do PR34 e os gates pendentes antes de qualquer merge. |

### PR35 — Derivatives e media cleanup (implementação e gates remotos concluídos; publicação pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Branch/worktree isolada | Concluída localmente | Worktree `D:\\2 - Dev\\2 - Worktree\\pr35-media-derivatives\\polaris`, branch `codex/pr35-media-derivatives`, baseada no head `87cbc27` do PR34. O checkout principal permaneceu intacto. |
| Derivados 320/640 | Implementados | Derivação sob demanda via Cloudflare Images, `scale-down`, sem upscale, WebP quality 85; keys `media/derivatives/v1/{assetId}/{size}.webp`. A rota continua tenant-authorized e entrega privada `no-store`. O painel atual solicita o derivado 320. |
| Tentativas físicas e staging | Implementados | Chave master v2 inclui UUID exclusivo por tentativa. Marker privado `media/staging/v1/{UTC}/{attemptId}.json` é gravado antes do master e removido após commit confirmado; falhas mantêm o marker. |
| Migration 0026, lock e grants | Concluídos | `media_cleanup_claims` com FORCE RLS, função SECURITY DEFINER de search_path fixo, trigger de inserção e advisory transaction lock compartilhado. Runtime tenant não executa a função. O login cleanup foi provado sem SUPERUSER, CREATEROLE ou BYPASSRLS e sem SELECT direto. |
| Escopo de purge futuro | Adiado | PR35 não adiciona hard-delete de assets. A futura purge física deve remover também `media/derivatives/v1/{assetId}/`; o tombstone de produto atual preserva assets. |
| Gate Neon PostgreSQL 18 | Concluído | Migration 0026 aplicada e verificador passou em PostgreSQL 18.6 na branch descartável `pr35-media-derivatives-gate` (projeto `green-tooth-16857010`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`). Dez verificações passaram, incluindo FORCE RLS, função, grants, claim idempotente, bloqueio de insert depois de claim e concorrência entre insert não confirmado e reconciliador. Branch expira em `2026-10-11 15:00 UTC` (12:00 BRT); fixtures são sintéticas e permanecem até expiração automática. Não foram registrados URLs de conexão. |
| Gate Cloudflare Images/R2/Hyperdrive | Concluído | Perfil `junior-pessoal` confirmado como `contato.juniordiniz@gmail.com`; comandos usaram o perfil explicitamente. Um JPEG sintético 1600×1200 virou master WebP 1200×900 e derivados 320×240 e 640×480; os dois caches passaram put/get com bytes iguais. O reconciliador remoto apagou um master órfão e seu marker via Hyperdrive cleanup, sem falhas. |
| Teardown remoto | Concluído e verificado | Worker e preview removidos; `cf workers list` e a lista de previews voltaram vazias. Hyperdrive temporário foi removido; a lista mantém somente a configuração anterior do PR11. As roles/login de cleanup de teste foram removidas da branch Neon. Os prefixes R2 `media/staging/v1/`, `media/derivatives/v1/` e `media/v2/` estão vazios; o bucket privado permanente permanece criado. |
| Observação do preview | Registrada | Deploy comum retornou HTTP 1042 quando a rota `workers.dev` não estava ativa; o Preview temporário serviu os endpoints autenticados do gate. A URL raiz `/health` do preview mínimo serviu a página estática 404; `/gate?stage=image`, `r2`, `database` e o fluxo completo responderam 200. |
| Verificação local final | Concluída | `bun run check` passou: lint, formatação, typecheck nos oito workspaces, import boundaries, Knip e 203 testes em 31 arquivos. `bun run build` passou nos oito workspaces; `bun run --filter @polaris/db db:generate` confirmou que não há drift. |
| Revisão independente | Concluída sem achados | Revisão estática do diff `87cbc27..1f7262a`; nenhum achado acionável no escopo de derivados privados, RLS, grants, cleanup concorrente, idempotência, cache e configuração. |
| Push e PR draft | Concluídos | Branch `codex/pr35-media-derivatives` publicada; [PR #34](https://github.com/camilagama/polaris/pull/34) aberto em draft sobre `codex/pr34-media-upload` (PR #33). Nenhum merge nem deploy de produção foi feito. |
| CI remoto | Concluído | GitHub Actions run `38094938994` passou 6/6 no commit `2332291`: build, Knip, lint/boundaries, typecheck, testes unitários e offline persistence browser gate. |
| Revisão do usuário | Pendente | Revisar o diff, ADR 0014, migration 0026 e evidências dos gates antes de qualquer merge. |


Os status serão atualizados ao concluir ou adiar cada etapa e apresentados para revisão.
