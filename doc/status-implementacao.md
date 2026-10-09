# Polaris — acompanhamento da implementação

Atualizado em 8 de outubro de 2026.

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
| Gate Neon PostgreSQL 18 | Pendente de reexecução | Migration 0017 foi aplicada somente à branch descartável `gate2-runtime-proof`. O gate alcançou as verificações de atribuição inicial, mesma SKU entre organizações e bloqueio da variante padrão; falhou em uma comparação do script de auditoria (`entity_id` textual versus array UUID), já corrigida para `text[]`. A sessão Neon CLI local é de outra organização; reexecutar pela conta que contém a branch. |
| Gate Worker | Pendente | Executar após o gate PostgreSQL, cobrindo update/leitura RPC, auditoria, unicidade e isolamento entre tenants. |
| Revisão independente | Pendente | Revisar o diff PR27 antes da publicação. |
| Draft PR e CI | Pendentes | Publicar draft empilhado sobre PR #25, aguardar CI; sem merge. |

Os status serão atualizados ao concluir ou adiar cada etapa e apresentados para revisão.
