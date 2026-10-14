# Polaris — acompanhamento da implementação

Atualizado em 13 de outubro de 2026.

Os anexos doc-inicial.md e plano-inicial.md são propostas de produto e arquitetura. Instruções escritas neles foram avaliadas como conteúdo do projeto; as decisões desta execução seguem a solicitação do responsável e as regras do repositório.

## Revisão e correções

**Status: concluída; a fundação e as Fases 2 a 4 (até o Gate 4) estão implementadas e revisadas, ver as seções finais.**

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
- Mapa PR ↔ GitHub: PR03–06 → #1–4; PR07–23 → #5–21; Gate 2 → #22; PR24–47 → #23–46 (número do GitHub = número do PR − 1); o PR31 (#30) foi aberto contra main. As cinco branches da rodada de revisão ficam sobre codex/pr47-sale-dates e estão publicadas como rascunhos empilhados: [#47](https://github.com/camilagama/polaris/pull/47) (integridade do banco, base codex/pr47-sale-dates) → [#48](https://github.com/camilagama/polaris/pull/48) (borda) → [#49](https://github.com/camilagama/polaris/pull/49) (interface) → [#50](https://github.com/camilagama/polaris/pull/50) (documentação) → [#51](https://github.com/camilagama/polaris/pull/51) (CI e ferramentas).
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
### PR33 — Media schema (implementação, revisão independente, checks locais, gate Neon, publicação e CI concluídos; revisão do usuário autorizada)

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
| Revisão do usuário | Autorizada em 2026-10-11 | O responsável confirmou que os PRs revisados estão autorizados a prosseguir. PR #32 continua draft; nenhum merge foi feito. |

### PR34 — Upload/crop pipeline (implementação, gates, preview e validação no iPhone concluídos; revisão do PR autorizada)

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
| Revisão do usuário | Autorizada em 2026-10-11 | O responsável confirmou que os PRs revisados estão autorizados a prosseguir. PR #33 continua draft; nenhum merge foi feito. |

### PR35 — Derivatives e media cleanup (correção de migration/gate publicada; review, checks locais e CI concluídos; revisão do usuário autorizada)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Branch/worktree isolada | Concluída localmente | Worktree `D:\\2 - Dev\\2 - Worktree\\pr35-media-derivatives\\polaris`, branch `codex/pr35-media-derivatives`, baseada no head `87cbc27` do PR34. O checkout principal permaneceu intacto. |
| Derivados 320/640 | Implementados | Derivação sob demanda via Cloudflare Images, `scale-down`, sem upscale, WebP quality 85; keys `media/derivatives/v1/{assetId}/{size}.webp`. A rota continua tenant-authorized e entrega privada `no-store`. O painel atual solicita o derivado 320. |
| Tentativas físicas e staging | Implementados | Chave master v2 inclui UUID exclusivo por tentativa. Marker privado `media/staging/v1/{UTC}/{attemptId}.json` é gravado antes do master e removido após commit confirmado; falhas mantêm o marker. |
| Migration 0026, lock e grants | Corrigida; replay PG18 passou | O replay Neon revelou que `ALTER FUNCTION OWNER` exige SET ROLE, os REVOKEs precisam executar como owner e o trigger precisa ser criado antes de retirar EXECUTE do migrator. A migration agora concede SET temporário, transfere ownership, instala o trigger na mesma transação, usa `SET ROLE polaris_media_cleanup_owner` para revogar PUBLIC/tenant e conceder claim só ao cleanup, depois reseta e revoga o SET explícito. ACL pós-migration verificada: tenant/PUBLIC sem EXECUTE, cleanup só no claim, owner sem SET residual. |
| Escopo de purge futuro | Adiado | PR35 não adiciona hard-delete de assets. A futura purge física deve remover também `media/derivatives/v1/{assetId}/`; o tombstone de produto atual preserva assets. |
| Gate Neon PostgreSQL 18 | Concluído após correção | Replay 0000–0026 e verificador passaram em PostgreSQL 18.6 na branch schema-only `pr36-customers-gate`, projeto `green-tooth-16857010`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Onze verificações confirmaram FORCE RLS, owner/ACLs, ausência de EXECUTE para PUBLIC/tenant/roles de limpeza na função de trigger, claim executável só pelo cleanup runtime, idempotência, bloqueio de insert após claim e corrida real insert/cleanup. Login temporário removido; fixtures sintéticas permanecem até expiração automática `2026-10-11 15:00 UTC`. URLs de conexão não foram registradas. |
| Gate Cloudflare Images/R2/Hyperdrive | Concluído | Perfil `junior-pessoal` confirmado como `contato.juniordiniz@gmail.com`; comandos usaram o perfil explicitamente. Um JPEG sintético 1600×1200 virou master WebP 1200×900 e derivados 320×240 e 640×480; os dois caches passaram put/get com bytes iguais. O reconciliador remoto apagou um master órfão e seu marker via Hyperdrive cleanup, sem falhas. |
| Teardown remoto | Concluído e verificado | Worker e preview removidos; `cf workers list` e a lista de previews voltaram vazias. Hyperdrive temporário foi removido; a lista mantém somente a configuração anterior do PR11. As roles/login de cleanup de teste foram removidas da branch Neon. Os prefixes R2 `media/staging/v1/`, `media/derivatives/v1/` e `media/v2/` estão vazios; o bucket privado permanente permanece criado. |
| Observação do preview | Registrada | Deploy comum retornou HTTP 1042 quando a rota `workers.dev` não estava ativa; o Preview temporário serviu os endpoints autenticados do gate. A URL raiz `/health` do preview mínimo serviu a página estática 404; `/gate?stage=image`, `r2`, `database` e o fluxo completo responderam 200. |
| Verificação local final | Concluída | `bun run check` passou: lint, formatação, typecheck nos oito workspaces, import boundaries, Knip e 203 testes em 31 arquivos. `bun run build` passou nos oito workspaces; `bun run --filter @polaris/db db:generate` confirmou que não há drift. |
| Revisão independente | Concluída sem achados | Revisão estática do follow-up `181a3c5..681bcd6`; sem achados Critical, Important ou Minor. A semântica de `acldefault`/`aclexplode` e dos privilégios efetivos foi conferida contra PostgreSQL 18; o gate real passou na branch Neon descartável. |
| Push e PR draft | Concluídos | Branch `codex/pr35-media-derivatives` atualizada até `e70aa23`; [PR #34](https://github.com/camilagama/polaris/pull/34) segue em draft sobre `codex/pr34-media-upload` (PR #33). Nenhum merge nem deploy de produção foi feito. |
| CI remoto | Concluído | Workflow `38138069207` passou 6/6 no head `e70aa23`: build, Knip, lint/boundaries, typecheck, testes unitários e offline persistence browser gate. |
| Revisão do usuário | Autorizada em 2026-10-11 | O responsável confirmou que os PRs revisados estão autorizados a prosseguir. PR #34 continua draft; nenhum merge foi feito. |


Os status serão atualizados ao concluir ou adiar cada etapa e apresentados para revisão.



### PR36 — Customers (implementação, gates local/Neon, revisão independente e CI concluídos; draft PR #35 publicado; revisão do usuário autorizada)



| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Worktree e base | Concluídos | Worktree isolado `D:\\2 - Dev\\2 - Worktree\\pr36-customers\\polaris`, branch `codex/pr36-customers`, rebased sobre o head publicado `e70aa23` do PR35; as alterações locais do PR36 foram preservadas. `main` e PR35 permanecem intactos. |
| Regra de identificação | Confirmada | Usuário definiu nome obrigatório e ao menos um contato (telefone ou email); contatos repetidos são permitidos. Não aplicar unicidade rígida nem mesclagem automática. |
| Schema e migration 0027 | Concluídos | `db:generate` não encontrou drift; migration 0027 foi aplicada na branch schema-only `pr36-customers-gate`. Customers usa FORCE RLS, exige nome e telefone/email, aceita contatos repetidos e não concede DELETE ao runtime. |
| Commands, RPC e interface | Concluídos localmente | Create/list/update/archive/restore com `expectedVersion`, auditoria sem PII e tela Clientes; capacidades V1 usam `customer:update`. Associação a vendas e possíveis duplicados ficam para etapas posteriores. |
| Gates local e Neon | Concluídos | `bun run check` passou no head `ae9a88d` com 212 testes em 33 arquivos; `bun run build` passou nos oito workspaces. Gate em Neon PostgreSQL 18.6 passou os nove grupos de cenários de migration/ACL, RLS, duplicatas, isolamento, invariantes, versionamento, lifecycle, auditoria e cleanup do role temporário. Fixtures sintéticas permanecem na branch schema-only até a expiração automática `2026-10-11 15:00 UTC`. |
| Revisão independente | Concluída sem blockers | O review identificou respostas antigas da lista aparecendo após erro ou corrida entre filtros; fix em `ae9a88d` limpa resultados durante load e descarta respostas obsoletas. O uso V1 de `customer:update` em leitura/criação foi mantido: o mapa atual só tem `owner`, não tem `customer:read`, e isso não muda o acesso atual. Refinar capabilities fica para quando papéis por operação forem definidos. |
| Push e PR draft | Concluídos | Branch `codex/pr36-customers` publicada; [PR #35](https://github.com/camilagama/polaris/pull/35) aberto em draft sobre `codex/pr35-media-derivatives` (PR #34). Nenhum merge ou deploy de produção foi feito. |
| CI remoto | Concluído | GitHub Actions run `38139378431` passou 6/6 no head `d3861f3`: build, Knip, lint/boundaries, typecheck, unit tests e offline persistence browser gate. |
| Revisão do usuário | Autorizada em 2026-10-11 | O responsável confirmou que os PRs revisados estão autorizados a prosseguir. PR #35 continua draft; nenhum merge foi feito. |

### PR37 — Possible duplicates (implementação, gates, revisão independente e CI concluídos; draft PR #36 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Worktree e base | Concluídos | Branch local `codex/pr37-possible-duplicates`, isolada em `.codex-worktrees/pr37-possible-duplicates`, sobre o head PR36 `d3861f3`. O branch `main` não foi alterado. |
| Regra de correspondência | Confirmada | Email exato sem distinção de caixa após trim; telefone exato após trim; sem normalização de pontuação e sem busca por nome. Incluir ativos e arquivados, usar OR entre contatos e apresentar todos os candidatos; nunca mesclar automaticamente. |
| Contrato, repository e RPC | Concluídos | Consulta exige ao menos um contato, usa capability `customer:update`, autorização e organização definidas no servidor, filtro explícito de organização e retorna os campos que coincidiram. |
| UI de cadastro | Concluída localmente | A criação consulta possíveis duplicados antes de gravar. A pessoa pode abrir o registro existente para revisão/edição ou criar mesmo assim. A busca falhando bloqueia a criação até nova tentativa. Escolher registro arquivado não restaura automaticamente. |
| Migration 0028 | Concluída | Índices parciais não únicos para `(organization_id, lower(email))` e `(organization_id, phone)`; `bun run db:generate` reportou “No schema changes”. |
| Gate Neon PostgreSQL 18 | Concluído | Migration 0028 aplicada e gate passou em PostgreSQL `18.6` na branch descartável `pr36-customers-gate`, projeto `green-tooth-16857010`, CLI perfil `junior-pessoal` / `juniordiniz56@gmail.com`. O gate comprovou definição dos índices, contatos repetidos, email case-insensitive, telefone exato após trim, inclusão de arquivados, exclusão de nome/pontuação, retorno de todos os candidatos e isolamento tenant. A branch contém apenas fixtures sintéticas e expira em `2026-10-11 15:00 UTC`; URLs não foram registradas. Uma branch schema-only criada durante a preparação ficou sem alterações e expira em `2026-10-11 16:00 UTC`. |
| Verificação local | Concluída | `bun run check` passou com lint, formatação, typecheck nos oito workspaces, boundaries, Knip e 216 testes em 33 arquivos. `bun run db:generate` confirmou ausência de drift. |
| Build local | Concluído com observação | `bun run build` terminou com exit code 0 nos oito workspaces. Wrangler registrou `EPERM` transitório ao abrir arquivo de log no perfil local e, em seguida, informou que os logs foram gravados; o build concluiu normalmente. |
| Revisão independente | Concluída sem blockers | A revisão identificou falta de asserção sobre expressões/predicados dos índices. O gate agora valida o DDL esperado e passou novamente no PostgreSQL 18.6. |
| Push e PR draft | Concluídos | Branch `codex/pr37-possible-duplicates` publicada; [GitHub PR #36](https://github.com/camilagama/polaris/pull/36) em draft sobre `codex/pr36-customers` (PR #35). CI passou 6/6. Nenhum merge foi feito. |
| Revisão do usuário | Pendente | Revisar o PR37 draft e os gates depois da publicação. |

### PR38 — decisões confirmadas para a próxima etapa

| Decisão | Status | Regra |
| --- | --- | --- |
| Origem de preço | Confirmada | Capturar no comando da venda preço de tabela e preço cobrado; não adicionar preço ao catálogo nesta etapa. |
| Custo desconhecido | Confirmada | Permitir a venda, registrar custo desconhecido e exibir margem indeterminada; não substituir ausência por zero. |
| Quantidade | Confirmada | Quantidade inteira positiva, limitada atomicamente ao saldo disponível, sem teto arbitrário adicional. |
| Escala monetária | Confirmada | Valores comerciais BRL com duas casas e até 18 dígitos inteiros; custo em seis casas; percentuais em até seis casas; cálculo exato e half-up na persistência, com pontos definidos por operação. |
| Estados persistidos | Confirmada | Apenas vendas confirmadas no banco. Estados pending/syncing/rejected/needs_attention ficam na outbox local; sem rascunho persistido. |

### PR38 — Sale aggregate (implementação, migrations, gate Neon, checks, build, revisão e CI concluídos; draft PR #37 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Domínio | Concluído localmente | `normalizeConfirmedSaleSnapshot` exige ao menos um item, IDs UUID válidos, quantidade inteira positiva dentro do limite do PostgreSQL, preços BRL exatos com duas casas e custo null ou decimal com seis casas; preserva a ordem dos itens. Não calcula total, que fica para PR39/40. |
| Migrations 0029–0030 | Concluídas | `0029` cria `sales` e `sale_items`, command ID único por organização, `confirmed_at`, moeda BRL, snapshots por item, FKs compostas, posição única e FORCE RLS. O índice composto que a FK referencia é criado antes da FK. `0030` remove as policies e o grant de INSERT do runtime: ele permanece somente leitura até PR43 entregar a confirmação transacional do cabeçalho com todos os itens. |
| Gate Neon PostgreSQL 18 | Concluído | Migrations aplicadas e gate passou em PostgreSQL `18.6` na branch descartável `pr36-customers-gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Sete grupos cobrem FORCE RLS, runtime somente leitura, snapshot com custo desconhecido, command identity, moeda, escala/quantidade, FKs e isolamento tenant. Um login/policies temporários e isolados exercitam as constraints e são removidos ao final; fixtures são sintéticos. A branch expira em `2026-10-11 15:00 UTC`. |
| Verificação local | Concluída | `bun run check` passou fora do sandbox: lint, formatação, typecheck nos oito workspaces, boundaries, Knip e 221 testes em 34 arquivos. A primeira execução dentro do sandbox falhou ao importar módulos por caminhos TEMP redirecionados; a repetição fora dele passou. `bun run db:generate` reportou “No schema changes”. |
| Build local | Concluído com observação | `bun run build` terminou com exit code 0 nos oito workspaces; Wrangler registrou EPERM transitório ao abrir log no perfil local, depois informou logs gravados. |
| Revisão independente | Concluída sem blockers | A revisão apontou que grants de INSERT permitiriam confirmar cabeçalho sem itens e inserir itens em commits posteriores. A migration `0030` revoga a escrita do runtime até PR43; follow-up confirmou o isolamento do role temporário no gate e sem blockers. O cleanup também só tenta remover login se `CREATE ROLE` teve sucesso. |
| Push e PR draft | Concluídos | Branch `codex/pr38-sales-aggregate` publicada; [GitHub PR #37](https://github.com/camilagama/polaris/pull/37) em draft sobre `codex/pr37-possible-duplicates`. CI passou 6/6. Nenhum merge foi feito. |
| Revisão do usuário | Pendente | Revisar o PR38 draft depois da publicação. |

### PR39 — Money library (implementação, revisão independente, checks e CI concluídos; draft PR #38 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Worktree e base | Concluídas | Branch `codex/pr39-money-library`, isolada em `D:\2 - Dev\2 - Worktree\pr39-money-library\polaris`, parte do commit PR38 `6a2f5c9`. Baseline passou com 221 testes/34 arquivos e build dos oito workspaces. |
| Regras monetárias | Confirmadas com convenção técnica registrada | BRL tem 2 casas e até 18 dígitos inteiros; custo mantém 6 casas; percentual aceita até 6 casas. A implementação representa percentual em pontos percentuais (`2.5` = `2,5%`) e usa a direção do tipo de operação. Intermediários não arredondam até a conversão half-up escolhida pela operação. |
| Primitives | Concluídas | `Money` usa centavos BigInt; `Percentage` usa pontos percentuais; `DecimalAmount` preserva valores exatos com até 10 casas intermediárias e arredonda somente quando solicitado. O pacote exporta `money/money`. |
| Testes de propriedade | Concluídos | 14 testes financeiros passaram; oito properties executam 300 casos cada para soma, desconto, quantidade, soma/subtração de intermediários, arredondamento half-up e aplicação exata de percentual. Há também casos de limite, escala, entrada inválida e ties negativos. |
| Verificação local | Concluída | `bun install --frozen-lockfile` não alterou dependências; `bun run check` passou: lint, formatação, typecheck nos oito workspaces, boundaries, Knip e 235 testes em 35 arquivos. `bun run build` passou nos oito workspaces. |
| Gate Neon | Adiado até PR43 | PR39 é aritmética de domínio, sem schema, migration, grants ou gravação no banco. O gate de persistência e atomicidade será executado junto do comando transacional de PR43. |
| Revisão independente | Concluída sem blockers | A revisão confirmou precisão BigInt, escalas, arredondamento assinado, aplicação percentual sem arredondamento antecipado e limite inteiro de quantity. Não foi inferido teto inteiro para `DecimalAmount`/`Percentage`, pois a documentação não o define. |
| Revisão do responsável | Pendente | Revisar especialmente a convenção percentual em pontos percentuais (`2.5` representa `2,5%`), registrada em `CONTEXT.md` e `docs/business-rules/money.md`. |
| Publicação | Concluída | Branch `codex/pr39-money-library` publicada; [GitHub PR #38](https://github.com/camilagama/polaris/pull/38) em draft sobre `codex/pr38-sales-aggregate`. CI passou 6/6. Nenhum merge foi feito. |

### PR40 — Sale adjustments (implementação, checks, gate, revisão e CI concluídos; draft PR #39 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base e worktree | Concluídas | Branch `codex/pr40-sale-adjustments`, isolada em `D:\2 - Dev\2 - Worktree\pr40-sale-adjustments\polaris`, sobre PR39 `5740ff7`. Baseline passou com 235 testes/35 arquivos e build dos oito workspaces. |
| Regras de ajuste | Confirmadas | Negociação por item permanece em `charged_unit_price` versus `listed_unit_price`; ajustes são de venda. Desconto/acréscimo aceitam valor fixo ou percentual; frete e sobretaxa de pagamento são fixos. Percentuais usam o mesmo subtotal, sem composição, arredondam half-up uma vez por ajuste e desconto total não excede o subtotal. |
| Sobretaxa de pagamento | Confirmada | Soma ao total devido pelo comprador; taxas do processador e de antecipação são custos separados de PR42. |
| Domínio | Concluído localmente | `calculateSaleAdjustments` calcula subtotal pelo preço cobrado, ajusta valor fixo ou percentual e retorna totais separados. Percentuais compartilham a base negociada, são arredondados half-up uma vez cada e não compõem; desconto agregado acima do subtotal é rejeitado. |
| Migration 0031 e RLS | Concluídas localmente | `sale_adjustments` guarda tipo, modo fixo/percentual, percentual de entrada e valor monetário calculado, vinculados por FK composta à venda e posição única. FORCE RLS; runtime tem SELECT somente até PR43. `db:generate` não encontra drift. |
| Verificação local | Concluída | `bun run check` passou com 244 testes em 36 arquivos, lint, formato, tipos, boundaries e Knip. `bun run build` passou nos oito workspaces; `bun run db:generate` não encontrou drift. |
| Gate Neon PostgreSQL 18 | Concluído | Migration 0031 aplicada; gate passou em PostgreSQL `18.6` na branch descartável `pr36-customers-gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Nove grupos verificaram FORCE RLS/runtime read-only, snapshots, tipo/escala/modo/posição, FKs compostas, isolamento tenant e imutabilidade. O gate criou fixtures e policies de teste temporárias e as removeu; a branch expira em `2026-10-11 15:00 UTC`. |
| Revisão independente | Concluída sem blockers | A revisão confirmou coerência do cálculo, schema, migration e gate. Follow-up confirmou que arrays esparsos são rejeitados e que arrays válidos mantêm o cálculo. |
| Revisão do responsável e publicação | Publicação concluída; revisão pendente | Branch `codex/pr40-sale-adjustments` publicada; [GitHub PR #39](https://github.com/camilagama/polaris/pull/39) em draft sobre `codex/pr39-money-library`. CI passou 6/6. Nenhum merge será feito. |

### PR41 — Sale payments (implementação, checks, gate, revisão independente e CI concluídos; draft PR #40 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base e worktree | Concluídas | Branch `codex/pr41-sale-payment`, isolada em `D:\2 - Dev\2 - Worktree\pr41-sale-payment\polaris`, sobre PR40 `6d74f70`. Baseline passou com 244 testes/36 arquivos e build dos oito workspaces. |
| Regras de pagamento | Confirmadas | Valor igual ao total devido, sem parcial ou saldo pendente; dinheiro não registra valor entregue/troco; método não prova liquidação; parcelas positivas só para `credit_card`, limitadas pelo `integer` do PostgreSQL. |
| Domínio | Concluído localmente | `normalizeSalePayment` deriva o valor do total devido, aceita os seis métodos V1 e exige parcelas inteiras positivas apenas para `credit_card`. Erros de método/parcela/valor negativo são rejeitados; seleção do método não representa liquidação. |
| Migration 0032 e RLS | Concluídas localmente | `sale_payments` permite no máximo uma linha por venda via unicidade tenant-scoped, snapshot de valor BRL, método e parcelas; FK composta para venda. FORCE RLS e runtime somente SELECT até PR43. `db:generate` não encontra drift. |
| Verificação local | Concluída | `bun run check` passou com 251 testes em 37 arquivos, lint, formato, tipos, boundaries e Knip; `bun run build` passou nos oito workspaces. |
| Gate Neon PostgreSQL 18 | Concluído | Migration 0032 e gate combinado passaram em PostgreSQL `18.6` na branch descartável `pr36-customers-gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Onze grupos verificaram RLS/grants, método/valor/parcelas, unicidade por venda, FKs tenant, imutabilidade e os gates de venda/ajuste. Fixtures são sintéticas; a branch expira `2026-10-11 15:00 UTC`. |
| Revisão independente | Concluída sem blockers | Revisão confirmou o snapshot derivado do total devido, métodos/parcelas, unicidade, FK tenant-scoped, RLS/grants e gate/cleanup; nenhuma falha concreta foi encontrada. |
| Revisão do responsável/publicação | Publicação concluída; revisão pendente | Branch `codex/pr41-sale-payment` publicada; [GitHub PR #40](https://github.com/camilagama/polaris/pull/40) em draft sobre `codex/pr40-sale-adjustments`. CI passou 6/6. Nenhum merge será feito. |

### PR42 — Payment profiles (implementação, migration, gate PG18, checks locais, build, revisão independente e CI concluídos; draft PR #41 publicado; revisão do responsável pendente)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Worktree e base | Concluídas | Branch `codex/pr42-payment-profiles`, isolada em `D:\2 - Dev\2 - Worktree\pr42-payment-profiles\polaris`, baseada no checkpoint PR41 `27a7ec4`. |
| Auditoria documental | Concluída | O plano PR42 define perfis/regras por método e parcelas, taxas de processamento e antecipação e snapshots. `doc/doc-inicial.md` §29 também pede modalidade merchant/issuer e prazo esperado, omitidos no plano. |
| Regras já resolvidas | Confirmadas | Parcelas positivas limitadas pelo `integer` do PostgreSQL, sem teto arbitrário, prevalecem sobre a referência antiga de 1–12. Custos desconhecidos continuam `null`, nunca zero; sobretaxa do comprador permanece separada das taxas do negócio. |
| Decisões de domínio | Confirmadas | Taxas podem combinar componente fixo e percentual efetivo sobre o total devido; half-up uma vez por custo. Modalidade `merchant`/`issuer` e prazo inteiro em dias entram no perfil/snapshot. Antecipação é marcada por venda. Perfil selecionado explicitamente; sem perfil/regra a venda segue com custo desconhecido. |
| Domínio e schema | Concluídos localmente | Normalização e cálculo exato das taxas; snapshots de perfil/versão/regra, componentes e valores; configuração por método, tipo e parcelas; profiles e regras tenant-scoped, versionados e arquiváveis. `0033` preserva pagamentos antigos sem modalidade como desconhecidos, sem inferir `merchant` ou `issuer`. Runtime pode criar/ler/editar perfis e regras, não apagá-los; pagamentos seguem read-only até PR43. |
| Contracts/RPC e interface | Concluídos localmente | CRUD versionado com `organization:manage`; página `/payment-profiles` para criar/editar/regras e arquivar/restaurar, com estado de custo desconhecido explícito. A seleção explícita do perfil (ou ausência) e persistência do snapshot no comando/UI de venda são requisitos obrigatórios do PR43, onde o fluxo de venda será criado. |
| Migration 0033 e drift | Concluídos | Migration gerada pelo Drizzle e endurecida com FORCE RLS/grants. Índices compostos são criados antes das FKs que os referenciam; migration marca modalidade antiga como desconhecida. `bun run db:generate` confirma ausência de drift. |
| Gate Neon PostgreSQL 18 | Concluído | 24 cenários passaram em PostgreSQL 18.6 na branch schema-only `pr42-payment-profiles-gate`, database `polaris_pr42_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`. Cobre CRUD/RLS/ACL, cross-tenant, taxas/precisão/arredondamento, modalidade, antecipação, snapshot, concorrência de versão e preservação de regras antigas. Fixtures são sintéticas; a branch expira `2026-10-12 15:45 UTC`. Nenhum dado de produção foi copiado. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, tipos dos oito workspaces, boundaries, Knip e 267 testes em 39 arquivos. `bun run build` passou nos oito workspaces; `bun run --filter @polaris/db db:generate` confirmou ausência de drift. |
| Revisão independente | Concluída sem blockers | O reviewer inicialmente apontou a seleção por venda como possível lacuna; após formalizar no plano sua conexão obrigatória no PR43 (que cria a transação e o pagamento), confirmou a divisão e não encontrou outros achados Critical/Important no escopo PR42. |
| Publicação | Concluída | Commit `cee49e5`; branch `codex/pr42-payment-profiles` publicada; [GitHub PR #41](https://github.com/camilagama/polaris/pull/41) em draft sobre `codex/pr41-sale-payment`. CI passou 6/6 no head `1ca6330`; o handoff documental terá CI próprio. Nenhum merge foi necessário para a continuidade; a cadeia permanece em draft. |

### PR43 — Sale transaction (implementação, checks, gates PG18 e UI concluídos; revisão independente e publicação: ver linhas abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Estado remoto e base | Concluídos | Verificado em 2026-10-13: GitHub PR #41 aberto em draft, base `codex/pr41-sale-payment`, head `5c38919`, CI 6/6; `main` (`f1edde9`) não contém PR42. Worktree `D:\2 - Dev\2 - Worktree\pr43-sale-transaction\polaris`, branch `codex/pr43-sale-transaction` criada sobre `origin/codex/pr42-payment-profiles` (`5c38919`); o upstream acidental para a branch do PR42 foi removido para evitar push errado. Baseline antes de editar: `bun run check` com 267 testes, `bun run build` e `db:generate` sem drift. |
| Domínio | Concluído | `packages/domain/src/sales/confirm-sale.ts`: valida e precifica o comando (itens, ajustes via `calculateSaleAdjustments`, pagamento igual ao total devido), exige a escolha explícita do perfil (`{id, expectedVersion}` ou `null`), compõe o snapshot com `snapshotPaymentProfileForSale`, resume totais e converte o instante comercial na data de ledger no fuso da organização. 24 testes novos. |
| Repositório transacional | Concluído | `packages/db/src/sale-repository.ts#confirmSale`: replay por `commandId` (comparação de payload), cabeçalho com `ON CONFLICT DO NOTHING`, perfil lido com `FOR SHARE` (existente, ativo, versão esperada), produtos bloqueados em ordem de id, movimentos `sale` pelo ledger existente (`recordSaleStockMovement`; a autorização por capability segue obrigatória em todo caminho do ledger), itens, ajustes, pagamento com snapshots e auditoria `sale.confirmed`, tudo na transação tenant. Organização e usuário vêm da identidade autorizada. |
| Contrato e RPC | Concluídos | `sale.confirm` em `packages/contracts` (versão 1, `paymentProfile` obrigatório e anulável, `anticipationRequested` explícito) e `apps/web/src/server/rpc/sale-handlers.ts`; mapeamento de erros para 400/404/409. 19 testes do roteador. |
| Migration 0034, RLS e ACL | Concluídos | Colunas `occurred_at`, `client_created_at`, `item_count`, `adjustment_count`; policies de INSERT por organização; runtime com SELECT+INSERT e sem UPDATE/DELETE nas quatro tabelas; gatilhos de restrição deferidos (`check_sale_confirmation_complete`) recusam no commit venda sem itens/ajustes declarados, sem um pagamento igual ao total, sem movimentos correspondentes, itens acrescentados depois e movimento `sale` órfão. Função sem EXECUTE para PUBLIC. `db:generate` sem drift. |
| Interface `/sales` | Concluída localmente | `apps/web/src/sales/*`: tela "Nova venda" com uma única chamada `sale.confirm`, escolha explícita de perfil ou "Sem perfil", intenção de antecipação, prévia exata de totais e taxas (desconhecida ≠ R$ 0,00), estados de carregamento, vazio, envio, sucesso e erro, `commandId` e instante congelados por tentativa (nova tentativa idêntica reaproveita; qualquer alteração gera novo `commandId`). 64 testes na camada de modelo (sem jsdom nesta etapa), incluindo a trava após resultado desconhecido e as mensagens por data.reason. Verificação manual no navegador com servidor `/rpc` simulado (2026-10-13): formulário, falha 503 forçada, trava dos campos, descarte em duas etapas com aviso, repetição com o mesmo `commandId` e horário, mensagem de replay e reinício do formulário. Layout a 360 px (painel do navegador sem viewport) e E2E automatizado em navegador **não** foram executados. |
| Outbox | Não aplicável | O passo 10 do plano não gera intents: o outbox transacional do servidor é PR108 e a venda não tem consumidores definidos. Registrado em `docs/business-rules/sales.md` e no plano. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, typecheck (8 workspaces), boundaries, Knip e 377 testes em 42 arquivos; `bun run build` passou nos 8 workspaces; `bun run --filter @polaris/db db:generate` reportou "No schema changes". |
| Gate Neon PostgreSQL 18 | Concluído | Branch schema-only nova `pr43-sale-transaction-gate` (projeto `green-tooth-16857010`, database `polaris_pr43_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`, expira `2026-10-14 16:30 UTC`), migrations 0000–0034 reaplicadas do zero em PostgreSQL 18.6, fixtures sintéticas, sem dados de produção. `poc:sales:transaction:verify` (novo): 18 grupos — snapshots completos, custo conhecido/desconhecido, perfil ausente/sem regra/zero conhecido/antecipação, replay e conflito de payload, versão e ciclo de vida do perfil, validações sem escrita, estoque insuficiente, falha injetada em 8 pontos de escrita com rollback conjunto, corridas de saldo (8 vendas × 3 unidades vendem 3; 2×2 sobre 3 vende 1), 6 entregas simultâneas do mesmo comando, ordem oposta sem deadlock, isolamento entre organizações, recusa de commits parciais no PostgreSQL, RLS de INSERT e ACL. `poc:sales:verify` (adaptado ao novo modelo de escrita: fixtures de venda completa em vez de cabeçalho solto, sem policies temporárias): 24 cenários dos PRs 38–42 passaram. A URL de conexão ficou só no ambiente do processo e foi removida. |
| Revisão independente | Concluída sem Critical/Important | Revisão estática da fronteira transacional, do SQL dos gatilhos, de RLS/ACL, da concorrência e do domínio. Minors tratados: limite técnico de ano (1900–2200) em `occurred_at` para não gerar erro 500; `recordStockMovement` não aceita mais `sale`; gate ganhou os casos de fuso horário (data de ledger na organização), instante irrepresentável e contagem de itens do cabeçalho divergente. Minors registrados e não alterados: `confirmed_at` usa `defaultNow()` (início da transação); o gatilho não acopla venda e saldo (a atomicidade do estoque é do código da aplicação); o limite de 200 itens/20 ajustes é salvaguarda de transporte, custo por linha não medido; a migration 0034 falha se `sales` tiver linhas (o runtime nunca pôde inserir antes); id de comando reutilizado por outro comando de estoque devolve conflito de estoque. Gates e `check` repetidos depois dessas mudanças: passaram (377 testes). |
| Publicação | Concluída | Commit `5e17b26`; branch `codex/pr43-sale-transaction` publicada; [GitHub PR #42](https://github.com/camilagama/polaris/pull/42) em draft sobre `codex/pr42-payment-profiles` (PR #41). CI 6/6 verde no head `0898277` (build, Knip, lint/boundaries, typecheck, unit tests, offline persistence browser gate). Sem merge nem deploy. |
| Perguntas levantadas no PR43 | Decididas (responsável delegou ao projeto em 2026-10-13) | (1) **Horário comercial:** passado ilimitado (venda offline); occurred_at mais de 5 minutos à frente do relógio do servidor é rejeitado com sale_occurred_in_future. (2) **Resultado desconhecido:** a tela trava a venda e só permite repetir a mesma tentativa (replay seguro); descartar exige confirmação explícita; deduplicação no servidor além do commandId não foi criada porque o replay já cobre a repetição e a venda não tem outra chave natural. (3) **Mensagens de conflito:** erros 400/404/409 carregam data.reason com o código de domínio estável; a tela mostra mensagem específica por motivo. (4) **Capabilities:** sale:create, organization:manage e inventory:read seguem todas no papel owner; a tela de venda lista perfis com organization:manage até existirem papéis por operação. |

### PR44 — Customer attribution (implementação, checks, gates PG18 e UI concluídos; revisão independente e publicação: ver linhas abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Estado remoto e base | Concluídos | Verificado em 2026-10-13: GitHub PR #42 (PR43) aberto em draft, head `ba538f7`, CI 6/6; `main` (`f1edde9`) não contém PR42 nem PR43. Worktree `D:\2 - Dev\2 - Worktree\pr44-customer-attribution\polaris`, branch `codex/pr44-customer-attribution` criada sobre `origin/codex/pr43-sale-transaction`, sem upstream até a publicação. Baseline: `bun run check` 377 testes e `bun run build`. |
| Decisões de domínio | Tomadas pelo projeto (responsável delegou em 2026-10-13) | Histórico versionado somente de acréscimo; `expectedVersion` em toda mudança; ações já válidas são no-op; `assign` só sem cliente, `reassign` só para outro cliente, `unassign` só com cliente; somente clientes ativos são associáveis (já associado e depois arquivado continua visível); capability dedicada `sale:assign_customer` (leitura e escrita, só `owner` hoje); auditoria apenas com tipo e UUID da versão. O plano não definia esses pontos. |
| Domínio | Concluído | `packages/domain/src/sales/sale-customer-link.ts`: normalização do comando, plano de transição puro, erros próprios e nome do evento de auditoria. 14 testes (inclui capability). |
| Schema, migration 0035, RLS e ACL | Concluídos | `sale_customer_links` (versão única por venda, FKs compostas para venda e cliente, checks de ação/cliente), policies de SELECT/INSERT, runtime com SELECT+INSERT sob FORCE RLS e sem UPDATE/DELETE/TRUNCATE, gatilho `guard_sale_customer_link_transition` (sequência de versões, transições válidas, cliente ativo da mesma organização) sem EXECUTE para PUBLIC. `db:generate` sem drift. |
| Repositório, contrato e RPC | Concluídos | `getSaleCustomerLink` e `changeSaleCustomerLink` na transação tenant com capability, venda e cliente escopados por organização, `FOR SHARE` no cliente, mapeamento de conflito de versão (índice único ou guard) e auditoria na mesma transação; procedures `sale.getCustomerLink`, `assignCustomer`, `reassignCustomer`, `unassignCustomer`; erros 400/404/409 com `data.reason`. 12 testes de roteador. |
| Interface | Concluída localmente | Painel "Cliente da venda" (colapsado e opcional após a confirmação em `/sales`) e página `/sales/customer?saleId=` (não existe lista de vendas para reconciliar vendas antigas); mostra só o nome do cliente, ações permitidas por estado, histórico e a nota de que os valores da venda não mudam. 57 testes de modelo. Verificação manual no navegador com servidor `/rpc` simulado (2026-10-13): estado sem cliente, picker só com clientes ativos, associar (v1), trocar (v2) com o cliente atual fora do picker, remover (v3), histórico com nomes e conflito de versão provocado por mudança externa (mensagem, recarga e nada alterado). Layout a 360 px e E2E automatizado **não** foram executados. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, typecheck, boundaries, Knip e 444 testes em 45 arquivos; build nos 8 workspaces; `db:generate` sem drift. |
| Gate Neon PostgreSQL 18 | Concluído | Branch schema-only nova `pr44-customer-attribution-gate` (projeto `green-tooth-16857010`, database `polaris_pr44_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`, expira `2026-10-14 18:02 UTC`), migrations 0000–0035 reaplicadas do zero em PostgreSQL 18.6, fixtures sintéticas. `poc:sales:customer-link:verify` (novo) cobre estado inicial, assign/reassign/unassign com auditoria, no-ops, conflitos de versão e de estado, economia da venda idêntica após quatro mudanças, ciclo de vida do cliente, isolamento entre organizações, capability e associação, corrida de seis atribuições (uma vencedora), interleavings determinísticos pelos dois caminhos do banco (índice único e guard de sequência), archive concorrente com associação (`FOR SHARE`), rollback por falha de auditoria, guards do banco, ACL e a policy de INSERT provada sozinha (guard desabilitado só durante a sonda: organização alheia, usuário sem membership e organização suspensa). Os gates `poc:sales:transaction:verify` e `poc:sales:verify` também passaram nesta branch (a checagem do nome da branch virou um padrão `prNN-...-gate`). Nota: um INSERT com `organization_id` de outra organização é recusado pelo guard (`customer_active`) antes da policy de RLS; a sonda com o guard desabilitado prova que a policy também recusa sozinha. |
| Revisão independente | Concluída sem Critical/Important | Revisão estática de migration, gatilho, repositório, RPC, UI e gate. Minors tratados: gate com interleavings determinísticos, corrida archive × associação, rollback de auditoria, ausência de auditoria em no-op, policy de INSERT provada sem o guard, asserções menos frágeis (contagem de migrations, snapshot com o id da venda); UI limpa a seleção quando ela vira o cliente atual, descarta respostas fora de ordem e usa `key` por venda. Registrados e não alterados: o histórico é somente de acréscimo por ACL/RLS (dono da tabela ou papel com BYPASSRLS poderia alterá-lo, como nas demais tabelas de venda; um gatilho de rejeição de UPDATE/DELETE seria endurecimento opcional); o guard consulta o cliente sem lock, seguro apenas via repositório (`FOR SHARE`); erros 23514 de `transition_valid`/`customer_active` não são mapeados e só são alcançáveis por SQL direto; repetir um comando cuja resposta se perdeu devolve conflito de versão (não replay), a tela recarrega e mostra o resultado. |
| Publicação | Concluída | Commit `ee7b264`; branch `codex/pr44-customer-attribution` publicada; [GitHub PR #43](https://github.com/camilagama/polaris/pull/43) em draft sobre `codex/pr43-sale-transaction` (PR #42). CI do PR em andamento na publicação. Sem merge nem deploy. |

### PR45 — Sale cancellation (implementação, checks, gates PG18 e UI concluídos; revisão independente e publicação: ver linhas abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Estado remoto e base | Concluídos | Verificado em 2026-10-13: GitHub PR #43 (PR44) aberto em draft sobre o PR #42, CI 6/6; `main` (`f1edde9`) não contém PR42–PR44. Worktree `D:\2 - Dev\2 - Worktree\pr45-sale-cancellation\polaris`, branch `codex/pr45-sale-cancellation` sobre `origin/codex/pr44-customer-attribution` (`ae5eee2`). |
| Decisões de domínio | Tomadas pelo projeto (checkpoint pede revisão) | O plano só diz "operação compensatória, nunca editar itens antigos, movimentos inversos". Decidido: cancelamento total (uma vez por venda, irreversível, idempotente por `commandId`); motivo estruturado opcional com lista V1 `customer_request`/`entry_error`/`payment_issue`/`other` (nota obrigatória só para `other`); estoque devolvido ao custo do próprio item, recalculando a média como em um recebimento quando custo e média são conhecidos, sem bloquear nem inventar custo; produto arquivado recebe o estoque, produto removido bloqueia o cancelamento; atribuição de cliente segue permitida em venda cancelada (resolve a pergunta deixada no handoff do PR44); capabilities `sale:cancel` e `sale:read`. |
| Domínio | Concluído | `sale-cancellation.ts` (comando, motivos, erros, plano de reposição), `restockMovingAverageCost` em `inventory-cost.ts`, `SaleNotFoundError` compartilhado em `sale-errors.ts`. 12 testes novos de domínio. |
| Schema, migration 0036, RLS e ACL | Concluídos | `sale_cancellations` (única por venda, comando único por organização, `cancelled_by` obrigatoriamente o usuário autorizado, motivo validado), runtime com SELECT+INSERT sob FORCE RLS sem UPDATE/DELETE/TRUNCATE, gatilhos deferidos `check_sale_cancellation_complete` (movimentos inversos de todos os itens com quantidade, produto, variante e custo corretos; comando distinto do da venda; movimento `sale_cancellation` órfão). `db:generate` sem drift. |
| Repositório, contrato e RPC | Concluídos | `cancelSale` (replay, ordem de locks por produto, reposição pelo ledger via `recordSaleRestockMovement`, auditoria `sale.cancelled`), `listSales`/`getSale`; procedures `sale.cancel`, `sale.list`, `sale.get`; erros 400/404/409 com `data.reason`. 16 testes de roteador. |
| Interface | Concluída localmente | `/sales/history` (lista com status, cliente, total, paginação), `/sales/detail?saleId=` (snapshot completo, cancelamento, painel de cliente) e cancelamento em duas etapas com a mesma disciplina de `commandId` e de resultado desconhecido da confirmação de venda. 50 testes de modelo. Sem clique em navegador nesta etapa. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, typecheck, boundaries, Knip e 522 testes em 49 arquivos; `bun run build`; `db:generate` sem drift. |
| Gate Neon PostgreSQL 18 | Concluído | Branch schema-only `pr45-sale-cancellation-gate` (projeto `green-tooth-16857010`, database `polaris_pr45_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`, expira `2026-10-14 19:00 UTC`), migrations 0000–0036 do zero em PostgreSQL 18.6, fixtures sintéticas. `poc:sales:cancellation:verify` (novo): cancelamento completo com venda e movimentos originais byte a byte idênticos, replay e conflitos, valoração (média ponderada, saldo zero, custo desconhecido), produto arquivado × removido, isolamento e capability, falha injetada em 5 pontos com rollback conjunto, corridas (6 cancelamentos → 1 vencedor; 5 entregas do mesmo comando; cancelamento × vendas novas sem deadlock), guards do banco e ACL, leitura de status e atribuição de cliente em venda cancelada. Os gates dos PRs 38–44 também passaram nesta branch. Limite do plano Neon: branches só de schema contam como raiz; a branch do gate do PR43 (minha, já registrada) foi removida para liberar espaço. |
| Revisão independente | Concluída sem Critical/Important | Revisão estática de atomicidade, valoração, locks, RLS/ACL, leitura e UI. Tratados: nota do cancelamento agora é limitada (2000 unidades no contrato, 500 pontos de código no domínio) e rejeita NUL e surrogate solitário, que o PostgreSQL gravaria de forma diferente e fariam um replay legítimo parecer conflito; o gate ganhou negativos de formato (movimento ausente, quantidade, custo, variante trocada e movimento extra). Registrados e não alterados: venda com produto removido não pode ser cancelada (decisão do projeto, sem escape; documentada); estouro do limite de quantidade ao devolver estoque não tem mensagem própria na tela; o banco não liga saldo a movimento (mesma postura das vendas); `sale.get` expõe `cancelledBy` (id de usuário) e custo por item, aceitável enquanto só `owner` tem `sale:read`; corridas só foram exercitadas contra `confirmSale` em um produto. |
| Publicação | Concluída | Commit `2a8ef21` e follow-up; branch `codex/pr45-sale-cancellation` publicada; [GitHub PR #44](https://github.com/camilagama/polaris/pull/44) em draft sobre `codex/pr44-customer-attribution` (PR #43). Sem merge nem deploy. |

### PR46 — Partial returns (implementação, checks, gates PG18 e UI concluídos; revisão independente e publicação: ver linhas abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Estado remoto e base | Concluídos | Verificado em 2026-10-13: GitHub PR #44 (PR45) aberto em draft sobre o PR #43; `main` (`f1edde9`) não contém PR42–PR45. Worktree `D:\2 - Dev\2 - Worktree\pr46-partial-returns\polaris`, branch `codex/pr46-partial-returns` sobre `origin/codex/pr45-sale-cancellation`, com o follow-up do PR45 (`a5f7b6a`) trazido por merge. |
| Decisões de domínio | Tomadas pelo projeto (checkpoint pede revisão) | O plano define `sale_returns`, `sale_return_items`, `returned <= available_to_return`, `restocked <= returned` e property tests. Decidido: itens identificados pela posição; várias devoluções por venda até esgotar o disponível; só as unidades repostas geram movimento, ao custo do item (mesma regra de média do cancelamento); motivo estruturado opcional (`customer_request`/`defective`/`wrong_item`/`other`); devolução e cancelamento total se excluem (serializados por lock consultivo por venda e repetidos no commit pelo banco); capability `sale:return`; **sem valor monetário nem reembolso** (a especificação de origem diz que o Polaris não processa o dinheiro devolvido e que o impacto em vendas líquidas pertence ao motor de métricas). |
| Domínio e property tests | Concluídos | `sale-return.ts` (comando, regras, plano de devolução, erros). 17 testes, incluindo 3 property tests (300 execuções cada): devolvido acumulado nunca excede o vendido e reposto ≤ devolvido; plano rejeitado não tem efeito; devolver tudo em qualquer divisão usa cada unidade uma única vez. |
| Schema, migration 0037, RLS e ACL | Concluídos | `sale_returns` e `sale_return_items` (FKs compostas por organização, venda e posição do item), runtime com SELECT+INSERT sob FORCE RLS sem UPDATE/DELETE/TRUNCATE, `returned_by` = usuário autorizado, gatilhos deferidos `check_sale_return_complete` (linhas, quantidade acumulada, movimentos exatos, venda não cancelada, comando distinto) e `check_sale_cancellation_complete` substituída para recusar venda com devoluções. `db:generate` sem drift. |
| Repositório, contrato e RPC | Concluídos | `createSaleReturn` (replay mesmo com a venda toda devolvida, lock por venda antes de ler a disponibilidade, ordem de locks por produto, reposição pelo ledger, auditoria `sale.returned`), `lockSaleForCompensation` também no cancelamento; `sale.return`, `sale.get` com devoluções e disponibilidade, `sale.list` com `hasReturns`. 13 testes de roteador. |
| Interface | Concluída localmente | Painel de devolução no detalhe da venda (disponível por item, devolvido e "volta ao estoque", confirmação em duas etapas, mesma disciplina de `commandId` e de resultado desconhecido), histórico de devoluções, selo "Com devoluções" e cancelamento oculto quando há devoluções. 38 testes novos de modelo. Sem clique em navegador nesta etapa. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, typecheck, boundaries, Knip e 591 testes em 52 arquivos; `bun run build`; `db:generate` sem drift. |
| Gate Neon PostgreSQL 18 | Concluído | Branch schema-only `pr46-partial-returns-gate`, recriada do zero depois do endurecimento da migration 0037 (projeto `green-tooth-16857010`, database `polaris_pr46_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`, expira `2026-10-14 19:00 UTC`), migrations 0000–0037 do zero em PostgreSQL 18.6, fixtures sintéticas. `poc:sales:return:verify` (novo): devolução parcial com venda e movimentos originais byte a byte idênticos, devolução que não repõe nada, regras de disponibilidade e rejeições sem efeito, replay e conflitos, exclusão mútua com o cancelamento, valoração (13,333333 após recebimento posterior), produto removido, isolamento e capability, falha injetada em 6 pontos com rollback conjunto, corridas (8 devoluções de 3 unidades sobre 10 vendidas → 3 vencedoras; 5 entregas do mesmo comando; 5 duelos devolução × cancelamento nunca ambos; devolução × vendas novas sem deadlock), sequência aleatória de 32 tentativas (com devoluções de várias linhas) contra um modelo em memória, guards do banco e ACL, escritores diretos serializados no commit, namespaces de `commandId`, leitura de disponibilidade. Os gates dos PRs 38–45 também passaram nesta branch. A branch do gate do PR44 (minha, já registrada) foi removida para respeitar o limite de branches raiz do plano Neon. |
| Revisão independente | Concluída sem Critical | A revisão independente da fronteira transacional/RLS não encontrou Critical. Importante: a sequência aleatória do gate era degenerada (multiplicador LCG acima de 2^53 perdia bits e as posições nunca eram sorteadas por igual). Corrigido: gerador Park–Miller exato em doubles, devoluções de uma e de duas linhas, rodadas 0 e 1 fixas (uma devolução válida de duas linhas e uma recusada atomicamente) e asserção de que ambas as posições recebem devoluções. Endurecimentos adotados: lock consultivo da venda também dentro dos gatilhos `check_sale_return_complete` e `check_sale_cancellation_complete` (mesma chave do repositório, para escritores que pulam o repositório); `planSaleReturn` rejeita a mesma posição duas vezes; UI mapeia `stock_command_conflict` (descarta a tentativa) e `inventory_quantity_limit`. Novos casos no gate: devolução acima do que as devoluções já comitadas deixaram (cumulativo, no commit), dueto de dois escritores diretos sobre as unidades restantes (um só vence), reuso de `commandId` de movimento de outra venda (`stock_command_conflict` sem rastro) e replay de comando contra outra venda. Não adotados: `sale.get` em uma só consulta (otimização) e preservação do rascunho da devolução quando o disponível muda (a chave do painel descarta o rascunho de propósito). |
| Publicação | Concluída | Commits `e3ce409` e `8143f37`; branch `codex/pr46-partial-returns` publicada; [GitHub PR #45](https://github.com/camilagama/polaris/pull/45) em draft sobre `codex/pr45-sale-cancellation` (PR #44). Sem merge nem deploy. |

### PR47 — Sale dates (implementação, checks, gates PG18 e UI concluídos; revisão independente concluída; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Estado remoto e base | Concluídos | Verificado em 2026-10-13: PRs #41–#44 em draft e com CI verde; `main` (`f1edde9`) não contém PR42–PR46. Worktree `D:\2 - Dev\2 - Worktree\pr47-sale-dates\polaris`, branch `codex/pr47-sale-dates` sobre `codex/pr46-partial-returns`. |
| Decisões de domínio | Tomadas pelo projeto (checkpoint pede revisão) | O plano pede `occurred_at`, `recorded_at`, `confirmed_at`, fuso da organização e limite retroativo. Decidido: `recorded_at` substitui `client_created_at` (evidência do dispositivo, sem efeito em regra); `occurred_on` (data de `occurred_at` no calendário da organização, calculada no servidor) é coluna obrigatória e a data dos movimentos; janela retroativa de 30 dias **de calendário** no fuso da organização para o `owner` (a mesma data local de 30 dias atrás vale), papel desconhecido recebe 0 dias; futuro até 5 minutos; replay responde antes da janela; `confirmed_at` passa a `clock_timestamp()`, monotônico entre vendas sequenciais. |
| Domínio e testes | Concluídos | `sale-dates.ts` (janela, dias de calendário, papéis) com testes de borda (30/31 dias, dois fusos, propriedade de monotonicidade); `confirm-sale` normaliza `recordedAt`. |
| Schema, migration 0038 | Concluídos | Renomeia `client_created_at` → `recorded_at`; adiciona `occurred_on` com backfill pelo fuso da organização (NO FORCE/FORCE RLS no próprio `sales` durante o backfill) e depois NOT NULL; `confirmed_at` default `clock_timestamp()`; `check_sale_confirmation_complete` substituída para exigir `movement.occurred_on = sale.occurred_on`. Snapshot do Drizzle montado à mão (`--custom`); `db:generate` sem drift. |
| Repositório, contrato e RPC | Concluídos | `confirmSale` calcula `occurredOn` no fuso da organização e aplica a janela depois do replay; contrato/handler expõem `occurredOn` e `recordedAt`; `sale_occurred_too_old` (400) com `data.reason`; testes de roteador. |
| Interface | Concluída localmente | Campo opcional "Data e hora da venda" (`datetime-local`, fuso do dispositivo) com dica, "Usar agora" e resumo; tentativa congelada (`commandId`, `occurredAt`, `recordedAt`); editar a data gera novo `commandId`; futuro validado com o relógio do dispositivo e retroativo só pelo servidor; datas da venda confirmada (data da venda, registrada no dispositivo, confirmada no servidor) no resultado e no detalhe. 16 testes novos de modelo. Sem clique em navegador. |
| Verificação local | Concluída | `bun run check` passou: lint, formato, tipos, boundaries, Knip e 616 testes em 53 arquivos; `bun run build`; `db:generate` sem drift. |
| Gate Neon PostgreSQL 18 | Concluído | Branch schema-only `pr47-sale-dates-gate` (projeto `green-tooth-16857010`, database `polaris_pr47_gate`, perfil `junior-pessoal` / `juniordiniz56@gmail.com`, expira `2026-10-14 19:00 UTC`), migrations 0000–0038 do zero em PostgreSQL 18.6, fixtures sintéticas. `poc:sales:dates:verify` (novo): colunas, três datas e evidência, janela de 30 dias até o primeiro segundo da data local, ledger na data comercial (não UTC, não a de confirmação), fuso da organização (mesmo instante, datas diferentes em Tóquio e São Paulo), tolerância de 5 minutos, replay e conflito com a nova evidência, replay após a janela (linha envelhecida pelo dono da tabela), expressão do backfill igual à data da aplicação, NOT NULL. As datas dos gates anteriores agora são relativas ao dia da execução, para que não expirem com a janela. Todos os gates de venda (agregado, transação com o novo caso de data do movimento, cliente, cancelamento, devolução) e `poc:gate4:verify` passaram. |
| Revisão independente | Concluída sem Critical | Itens Important tratados: backfill sem prova (gate compara a expressão e a visibilidade de `organizations` sob FORCE RLS), predicado novo do gatilho sem prova (caso de movimento com data diferente no gate de transação) e replay após a janela sem prova (gate envelhece a linha). Aceitos e documentados: rótulo "Venda retroativa" usa o dia local do dispositivo; renomear o campo quebra clientes em cache; lista de vendas continua com `occurred_at`. |
| Publicação | Concluída | Branch `codex/pr47-sale-dates` publicada; [GitHub PR #46](https://github.com/camilagama/polaris/pull/46) em draft sobre `codex/pr46-partial-returns` (PR #45). Sem merge nem deploy. |

### Gate 4 — núcleo de vendas (fim da Fase 4)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Gate consolidado | Concluído | `poc:gate4:verify` (`verify-gate4-sales-core.ts`): um cenário ponta a ponta sobre PostgreSQL 18.6 contra um oráculo independente. Venda atômica (venda sem estoque na segunda linha não deixa rastro; replay não muda nada), estoque correto (movimento por item ao custo do snapshot, razão explica todos os saldos), dinheiro correto (subtotal, desconto percentual, frete e total em centavos inteiros e nas linhas persistidas), cancelamento correto (reposição ao custo original, venda não editada, replay, totais preservados, sem devolução depois), devoluções corretas (devolvido ≠ reposto, só o reposto move estoque, excesso recusado, venda com devoluções não cancela), reconciliação de cliente sem tocar a economia (digests idênticos), venda retroativa na data comercial e conservação de estoque por variante. |
| Runbook | Concluído | [`docs/runbooks/gate-4-sales-core.md`](../docs/runbooks/gate-4-sales-core.md): alvo seguro, sequência dos gates, mapa propriedade → evidência, limites. |
| Dossiê para a revisão completa | Concluído | [`doc/checkpoint-gate4.md`](checkpoint-gate4.md): mapa PR01–PR47, decisões tomadas pelo projeto, perguntas, lacunas e próximos passos. |
| Checkpoint seguro | Alcançado | Fim da Fase 4. Nada foi integrado ao `main` nem implantado; PRs permanecem em draft. A próxima etapa seria a Fase 5 (PR48), mas o responsável pediu parar aqui para rever tudo desde a etapa 1. |

## Rodada de correções pós-revisão (checkpoint Gate 4)

**Status: implementada em cinco branches empilhadas (rascunho); validação em Neon descartável concluída; merge e itens de nuvem pendentes com o responsável.**

A revisão completa ([`doc/revisao-checkpoint-gate4.md`](revisao-checkpoint-gate4.md)) gerou 5 frentes de correção, cada uma em uma branch empilhada sobre `codex/pr47-sale-dates`: `codex/review-1-db-integrity` → `codex/review-2-security-edge` → `codex/review-3-product-ui` → `codex/review-4-docs-adrs` → `codex/review-5-tooling`.

### Decisões tomadas pelo projeto (delegadas pelo responsável)

| Decisão | Escolha | Efeito |
| --- | --- | --- |
| D-1 — produto removido e compensações | (a) Cancelamento e devolução continuam possíveis; itens de produto removido não geram movimento de estoque | `sale-cancellation-repository.ts`, gatilho `check_sale_cancellation_complete` (conta só itens de produtos vivos), gate de cancelamento |
| D-2 — custo desconhecido na reposição | Saldo zero → custo médio desconhecido (`null`); saldo positivo mantém a média | `restockMovingAverageCost`, ADR 0020, testes de propriedade |
| D-3 — instantes | Todas as colunas de instante viram `timestamptz` | Migration 0039 (inclui `create_initial_organization`, que retornava `timestamp without time zone`) |
| D-4 — custo de venda retroativa | Usa a média vigente hoje; documentado | ADR 0020, runbook do Gate 4 |
| D-5 — integração da cadeia | Integrar por fase (Gate 0–4) antes da Fase 5; **nenhum merge foi feito** | Decisão do responsável executar |
| D-6 — preço de tabela | Entra na variante no PR50 | `doc/plano-inicial.md` |
| D-7 — UI de estoque e organização pela sessão | Antes do Gate 5, já implementados | `organization.listMine`, `inventory.listBalances`, telas de estoque |

### Banco (frente 1)

| Item | Status | Evidência |
| --- | --- | --- |
| Migration 0039 — `timestamptz` | Concluída | Recria políticas e gatilhos dependentes, converte todas as colunas e a função de onboarding |
| Migration 0040 — integridade do razão | Concluída | `variant_sequence` por variante (gatilho + índice único); gatilho diferido de reconciliação razão × saldo; GRANT UPDATE por coluna para o runtime; CHECKs de limites; CHECK de chave de mídia; endurecimento de funções (`search_path` fixo, `REVOKE` de PUBLIC) |
| Migration 0041 — role de autenticação | Concluída | `polaris_auth_runtime` (NOLOGIN) detém user/account/session/verification/auditoria de auth; o runtime de tenant perde acesso a essas tabelas |
| Timeouts e isolamento da transação tenant | Concluídos | `statement_timeout` 30 s, `lock_timeout` 20 s, `idle_in_transaction_session_timeout` 60 s; `REPEATABLE READ` opcional (leituras de venda) |
| Estoque operado em data futura | Recusado | `InventoryOccurredInFutureError` |
| Comandos de devolução/cancelamento com `commandId` de outro namespace | Recusados | `SaleReturnCommandConflictError`, `SaleCancellationCommandConflictError` |
| Limites de texto e de taxas | Concluídos | Domínio, contratos e CHECKs SQL; `Percentage.fromRate` ≤ 100 |

### Borda e segurança (frente 2)

Verificação de `Origin`, limites de taxa para mutações RPC e upload (bindings `RPC_MUTATION_RATE_LIMIT`, `MEDIA_UPLOAD_RATE_LIMIT`), CSP/HSTS em `public/_headers`, sessão com teto absoluto de 30 dias, logs estruturados sem dados pessoais, validação de UUID nas rotas de mídia, `cf-connecting-ip` como única fonte de IP, `X-Request-Id` somente UUID, e-mail via `waitUntil`, no máximo 20 mídias por produto, pool de autenticação separado (`AUTH_HYPERDRIVE`) e PoCs movidos para `apps/web/poc/` sem flags de runtime.

### Produto e interface (frente 3)

Seleção de organização pela sessão (`organization.listMine`), tentativa de venda não confirmada preservada em `sessionStorage` por organização (30 min) para o reenvio idêntico após recarregar a página, saldos de estoque (`inventory.listBalances`) com busca, filtros e paginação por cursor, telas de receber, contar e baixar estoque, shell do aplicativo, página 404 e `ErrorBoundary`, rotas com carregamento tardio, seletor de produto da venda com preços lembrados, filtros do histórico de vendas e correções de acessibilidade.

### Ferramentas e CI (frente 5)

Corredor único de gates (`packages/db/scripts/run-gates.ts`, suítes `gate3`, `gate4`, `ci`), gate de endurecimento da revisão e gate dos modelos de leitura; CI com `format:check`, checagem de drift do Drizzle, job consultivo `database` (Postgres 18) e job consultivo `audit`; verificadores próprios de fronteiras de importação (17 fixtures negativos) e de ciclos (Tarjan); `turbo.json` com `agentGuidance: false`.

### Evidência

| Verificação | Resultado |
| --- | --- |
| Branch Neon descartável `pr472-review-final-gate` (schema-only; database `polaris_pr472_gate`) | Migrations 0000–0041 aplicadas do zero em PostgreSQL 18 |
| Gates em sequência a partir do head final (`run-gates.ts`, um por vez) | Passaram: `sales-aggregate`, `sale-transaction`, `sale-customer-link`, `sale-cancellation`, `sale-return`, `sale-dates`, `gate4`, `read-models`, `gate2-runtime`, `inventory`, `customers`, `media-upload`. O `review-hardening` falhou duas vezes na primeira passada por defeitos reais (abaixo) e por fixtures do próprio gate; depois das correções passou inteiro |
| Defeitos reais encontrados pelos gates em banco novo | (1) `create_initial_organization` ainda retornava `timestamp without time zone` depois da 0039 e quebrava o onboarding; (2) o repositório do razão trocava um `null` legítimo do cálculo de média pela média antiga (`?? currentAverageCost`), então D-2 não tinha efeito na reposição de venda de custo desconhecido em saldo zero |
| `bun run check` no head final | lint, formato, tipos, fronteiras (17 fixtures negativos), ciclos (158 arquivos), Knip e 899 testes em 78 arquivos passaram |
| `bun run build` e `db:generate` | Build dos oito workspaces passou; `db:generate` sem mudanças |

### Backlog registrado (não bloqueia a Fase 5)

- Manutenibilidade: dividir `apps/web/src/server/router.ts`, `packages/contracts/src/index.ts`, `sale-form-model.ts` e `sale-page.tsx`; unificar os helpers de gates (`sales-gate-support.ts` e os scripts mais antigos).
- Repositório de estoque: `recordStockMovement` é exportado apenas como ponto de teste dos gates; `getProductVariants` ainda lê com `FOR SHARE`; `inventory_quantity_limit` e `insufficient_stock` compartilham o mesmo status HTTP.
- Capabilities: `expense:create` ainda não é usada por nenhum procedimento; algumas leituras exigem capabilities de escrita (`customer:update`, `organization:manage`) até a Fase de papéis finos.
- `/offline-poc` continua empacotada fora do modo DEV; remover ou proteger antes de produção.
- Mídia: prova de EXIF/orientação em Cloudflare Images real, consumo de memória por upload e comandos de remover/substituir/reordenar mídia (antes da Fase 7).
- CI: promover os jobs consultivos `database` e `audit` a checks obrigatórios depois de um histórico verde.
### Pendências que só o responsável pode executar

Criar e verificar as configurações Hyperdrive (cache desativado, `AUTH_HYPERDRIVE`); reservar os namespaces de rate limit; apagar Workers e Hyperdrive de PoC implantados (`ebe151e5081344479947edb6028279bb`); rotacionar a credencial owner usada no PR11; testar em Android físico; provar EXIF/orientação em Cloudflare Images real; verificar os cabeçalhos em staging; decidir o merge da cadeia de PRs.
## Fase 5 — offline

### PR48 — Device model (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr48-device-model` sobre `codex/review-5-tooling`. A cadeia de revisão ainda não está integrada ao `main`: o push direto foi bloqueado pelo classificador de permissões e a integração ficou com o responsável. |
| Decisões de domínio | Tomadas pelo projeto | [ADR 0028](../docs/adr/0028-dispositivos-e-grants-offline.md): dispositivo do usuário (não da organização), sem fingerprint, rótulo opcional curto, limite de 20 vivos; grant por organização e dispositivo, no máximo 72 h; revogação terminal e idempotente; revogar o dispositivo revoga os grants em todas as organizações; capability `offline:manage`; sem RPC (chega com o lease assinado no PR49). |
| Domínio | Concluído | `packages/domain/src/offline/offline-grant.ts`: rótulo, janela de 72 h, motivos de revogação e estado do grant, com testes de propriedade. |
| Schema e migration 0042 | Concluídos | Tabelas `devices` e `offline_grants` com RLS forçada, FKs compostas (usuário/dispositivo e organização/usuário), CHECKs de janela e de revogação, GRANT por coluna, gatilhos de revogação terminal e de dispositivo vivo (`FOR SHARE`). O índice único de `devices` precisou ser criado antes das FKs; descoberto ao aplicar do zero. |
| Repositório | Concluído | `device-repository.ts` (registrar, listar, tocar e revogar dispositivo; registrar, listar e revogar grant) e `user-transaction.ts` (transação só de usuário). |
| Gate Neon PostgreSQL 18 | Concluído | `poc:offline-devices:verify` (`offline-devices` no corredor de gates, suíte `gate5`): privilégios e RLS, limite de 20 sob concorrência, isolamento entre usuários, revogação terminal por SQL cru, janela de 72 h no domínio e no banco, dispositivo de outro usuário ou revogado recusado, revogação em duas organizações com uma auditoria por grant e corrida entre grant e revogação sem grant vivo restante. |
| Limites | Registrados | Sem RPC nem UI; época de autorização, lease assinado e validação no servidor são PR49; o registro de dispositivo não é idempotente por retry do cliente. |

### PR49 — Offline authorization (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr49-offline-authorization` sobre `codex/pr48-device-model`. |
| Decisões | Tomadas pelo projeto | [ADR 0029](../docs/adr/0029-lease-de-autorizacao-offline.md): token `v1.<keyId>.<payload>.<assinatura>` com HMAC-SHA256 (Web Crypto); só o servidor assina e verifica, o cliente só lê; rotação por `KEY_ID` e segredo anterior; falha fechada sem segredo; época de autorização por membership; reset de senha invalida todos os leases; suspensão invalida pelo estado da organização; assinatura dentro da transação. |
| Domínio | Concluído | `offline-lease.ts`: claims, janela `min(agora + 72 h, fim do direito)`, validade, serialização determinística; testes de propriedade. |
| Token | Concluído | `apps/web/src/lib/offline-lease-token.ts` (assinar, verificar com várias chaves, ler sem verificar para a UI): adulteração, assinatura trocada, chave desconhecida, formato inválido, expirado e relógio adiantado cobertos. |
| Banco, migration 0043 | Concluída | `memberships.authorization_epoch`; função `SECURITY DEFINER` `bump_user_authorization_epoch` (lock consultivo por usuário, revoga grants com `security_event` e audita um evento por grant), executável só pela role de auth; o runtime de tenant lê e não escreve a época. |
| Repositório e RPC | Concluídos | `offline-lease-repository.ts` (emitir e revalidar no servidor com motivos distintos), `authorization-epoch.ts`, procedimentos `device.register|list|revoke` e `offline.issueLease`; o gancho `onPasswordReset` do Better Auth chama a função. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:offline-lease:verify` (`offline-lease`, suíte `gate5`): privilégios e função pinada, emissão com época, capabilities e 72 h, teto do trial e direito encerrado, revalidação (principal, organização, grant, expiração, capability, dispositivo, época, revogado), reset de senha por usuário em duas organizações sem tocar outro usuário e corrida entre emissão e reset sem época vencida. |
| Limites | Registrados | Nenhum cliente consome o lease ainda (PR50 em diante); o fim do direito (trial) não é informado por nenhum chamador porque billing não existe; `OFFLINE_LEASE_SECRET` precisa ser criado em cada ambiente (checklist de go-live). |

### PR50a — Preço de tabela por variante (D-6) (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr50a-variant-list-price` sobre `codex/pr49-offline-authorization`. Dividido do PR50 do plano para manter os PRs coesos; o PR50b traz as coleções locais e o bootstrap. |
| Decisão | Registrada | Preço de tabela opcional na variante, só sugestão na venda (o último preço confirmado da variante tem precedência); `catalogVersion` será o cursor do PR51. Ver [ADR 0026](../docs/adr/0026-ui-de-estoque-organizacao-pela-sessao-e-preco-de-tabela.md) e `docs/business-rules/products.md`. |
| Domínio, banco e RPC | Concluídos | `normalizeVariantListPrice`; migration 0044 (`list_price`, CHECK de escala e limite, GRANT de UPDATE só na coluna); `setProductVariantListPrice` (versionado, auditado, idempotente); `product.setVariantListPrice`; `listPrice` nas variantes e nas entradas de saldo. |
| Interface | Concluída | Seção "Preço de tabela das variantes" no painel de variantes (vírgula ou ponto, vazio remove) e pré-preenchimento dos preços do item ao escolher a variante na venda. |
| Gate Neon PostgreSQL 18 | Concluído | `gate2-runtime` cobre normalização, versão, repetição sem mudança, conflito de versão, valores inválidos e os CHECKs do banco; `read-models` continua verde. |

### PR51 — Sync change log (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Ordem | Alterada pelo projeto | O PR51 vem **antes** do PR50b (coleções locais e bootstrap): o bootstrap consistente depende do cursor do log (cursor, snapshot por páginas, pull a partir do cursor). Branch `codex/pr51-sync-change-log` sobre `codex/pr50a-variant-list-price`. |
| Decisões | Tomadas pelo projeto | [ADR 0030](../docs/adr/0030-change-log-de-sincronizacao.md): registro por gatilho nas tabelas de domínio; sequência por organização atribuída no COMMIT sob lock do contador (ordem de commit, sem buracos, sem consumo por rollback); escrita só por funções `SECURITY DEFINER`, runtime só lê; o log leva chaves (tipo, id, seq), não conteúdo; capability `sync:read`. |
| Banco, migration 0045 | Concluída | `sync_changes` (RLS, append-only por gatilho) e `sync_cursors`; triggers em categorias, produtos, variantes, saldos, clientes, perfis de pagamento, regras, vendas, cancelamentos, devoluções e vínculos. |
| Repositório e RPC | Concluídos | `getSyncCursor`, `pullSyncChanges` (dedupe por entidade, páginas, cursor validado), procedimentos `sync.getCursor` e `sync.pull`. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:sync-log:verify` (`sync-log`, suíte `gate5`): privilégios e funções, mudança por escrita de cada tipo, sequência por organização sem buracos, rollback sem consumo, dedupe e páginas, runtime sem escrita (inclusive dono sem editar), escrita por SQL manual registrada e escritores concorrentes com leitor em polling sem nenhum salto. |
| Limites | Registrados | Sem retenção do log (sem piso de cursor); o pull devolve chaves e o conteúdo vem do cliente (PR50b); `payment_profile` e `sale` entram por já serem necessários ao offline de vendas. |

### PR50b — Coleções locais e bootstrap (implementação, gates Neon e de navegador, verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr50b-local-collections` sobre `codex/pr51-sync-change-log`. É a segunda metade do PR50 do plano (a primeira é o preço de tabela, PR50a). |
| Decisões | Tomadas pelo projeto | [ADR 0031](../docs/adr/0031-colecoes-locais-e-bootstrap.md): uma base OPFS por usuário e organização (nome por hash); seis coleções com modelos de leitura menores (sem custo, sem auditoria); bootstrap em três tempos com o cursor do PR51 registrado antes da leitura; estado `bootstrapping` retomável; falha fechada; apagar o namespace como gancho do logout. |
| Servidor | Concluído | `sync.bootstrapPage` (páginas por chave de cinco coleções, ou entidades por id; variantes por produto) sobre `bootstrap-repository.ts`; as vendas recentes usam `sale.list`. |
| Cliente | Concluído | `apps/web/src/offline/`: `namespace`, `bootstrap` (orquestração pura), `local-store` (TanStack DB sobre SQLite WASM em OPFS) e `orpc-source`. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:bootstrap:verify` (`bootstrap`, suíte `gate5`): páginas de dois e de 500 cobrem cada linha uma vez em ordem de id, linhas sem custo nem dados de organização, releitura por id (variantes por produto, saldos por variante), isolamento entre organizações e entradas inválidas recusadas. |
| Gate de navegador | Concluído em Chromium | `e2e/offline-local-collections.e2e.ts` no laboratório `/offline-local-lab` (só no modo offline-poc): sincronização do zero, persistência após recarregar sem servidor, catch-up por cursor, bootstrap interrompido retomado, isolamento entre usuários e organizações e apagar só o namespace escolhido; seis cenários em Chromium desktop e em Pixel 5 emulado. Android físico, Edge real e Safari continuam sem prova desta etapa. |
| Limites | Registrados | Ainda não está montado no aplicativo (o worker OPFS é carregado sob demanda e a montagem vem com a primeira tela offline, PR52+); sem mutações offline; a prova em Android real do ADR 0015 continua bloqueando o PR52. |

### PR52 — Durable command outbox (implementação, gate de navegador e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base e decisão | Concluídas | Branch `codex/pr52-command-outbox` sobre `codex/pr50b-local-collections`. O responsável pediu para seguir sem o teste em Android; a condição do [ADR 0015](../docs/adr/0015-offline-persistence-tanstack-db-opfs-indexeddb.md) passou de "antes de iniciar o PR52" para **"antes de ligar a escrita offline em produção"** ([ADR 0032](../docs/adr/0032-outbox-duravel-de-comandos.md)); o outbox não está montado em nenhuma tela. |
| Regras | Concluídas | `apps/web/src/offline/outbox/`: envelope do comando (ID, tipo, organização, dispositivo, versão-base, lease, payload), posição local monotônica, idempotência por ID e conteúdo, fila que não pula nem reordena, `sending` recuperável, `rejected` bloqueante, descarte e confirmação explícitos, limites e lease que bloqueia comandos novos mas preserva a fila. 13 testes sobre armazenamento em memória. |
| Armazenamento | Concluído | IndexedDB por usuário e organização (transação atômica, contador de posição na mesma transação); apagar recusa com comandos pendentes sem aceite explícito; `requestPersistentStorage()` com estado visível. |
| Gate de navegador | Concluído em Chromium | `e2e/offline-outbox.e2e.ts` no laboratório `/offline-outbox-lab`: sobreviver a recarregar mantendo a ordem, comando repetido sem duplicar, resposta perdida recuperada com a mesma posição, rejeição bloqueante, lease vencido, isolamento entre usuários e organizações, apagar sem descarte silencioso, posição nunca reutilizada e pedido de armazenamento persistente; nove cenários em Chromium desktop e em Pixel 5 emulado. |
| Limites | Registrados | Sem prova em Android físico (bloqueia ligar a escrita offline); `sync.push` é o PR53; nenhum comando de domínio usa o outbox ainda. |

### PR53 — sync.push (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr53-sync-push` sobre `codex/pr52-command-outbox`. |
| Decisões | Tomadas pelo projeto | [ADR 0033](../docs/adr/0033-protocolo-sync-push.md): uma transação de tenant por comando, em ordem, com `not_processed` depois de uma rejeição; idempotência por ID e organização com hash do conteúdo (`command_id_reused` não grava nada); revalidação por comando; lease vencido ainda cobre o que foi criado enquanto valia; trabalho de domínio em savepoint; registro de manipuladores vazio até o PR54. |
| Banco, migration 0046 | Concluída | `sync_commands` (RLS forçada; o runtime só lê e insere; imutável até para o dono por gatilho); `runSyncCommand` com lock por comando, repetição do resultado, revalidação do lease (grant, dispositivo, época, capabilities), janela de criação e savepoint. |
| Servidor | Concluído | Procedimento `sync.push` (até 50 comandos, capability `sync:push`, 503 sem o segredo do lease), verificação da assinatura sem janela, hash do JSON canônico, ordem e códigos estáveis; 9 testes da orquestração e 6 do roteador. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:sync-push:verify` (`sync-push`, suíte `gate5`): privilégios, aceito uma vez e repetido igual, mesmo ID com outro conteúdo, recusa sem rastro, falha inesperada reenviável, revogação, época, dispositivo, capabilities, janela de criação, lease vencido com comando feito a tempo, direito perdido, oito envios simultâneos executando uma vez e isolamento entre organizações. |
| Limites | Registrados | Nenhum comando de domínio registrado ainda (PR54 em diante); direito (billing) é só um ponto de extensão; sem retenção de `sync_commands`; o cliente que envia o outbox pelo `sync.push` ainda não existe. |

### PR54 — Cliente criado offline (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr54-offline-customer-create` sobre `codex/pr53-sync-push`. |
| Decisões | Tomadas pelo projeto | [ADR 0034](../docs/adr/0034-cliente-criado-offline.md): o dispositivo gera o UUIDv7 do cliente; idempotência por `commandId` e por `customerId` (`customer_id_conflict`); validação repetida no servidor; sem capability nova (`customer:update`). |
| Servidor | Concluído | `createCustomer` aceita `id` (validado, em savepoint, conflito limpo); manipulador `customer.create` registrado em `server/sync/registry.ts`, com 9 testes do manipulador e do roteador. |
| Cliente | Concluído | `lib/uuidv7.ts`; `offline/customer-create.ts` (enfileira, grava a linha otimista, restaura após queda, estado pendente/rejeitado); `offline/sync-runner.ts` (lotes em ordem, `sending` antes da requisição, aplicação dos resultados, atualização das coleções pelo change log); servidor sintético com resposta perdida e rejeição. |
| Gate Neon PostgreSQL 18 | Concluído | `customers` (ID do cliente mantido, duplicata na mesma organização e em outra, transação do chamador intacta após o conflito, ID inválido recusado) e `sync-push` verdes. |
| Limites | Registrados | Nenhuma tela monta o fluxo (a prova em Android físico ainda bloqueia ligar a escrita offline); sem laboratório de navegador para este fluxo; o sincronizador ainda não tem agendamento (online, foco, tentativa com espera). |

### PR55 — Produto criado offline (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr55-offline-product-create` sobre `codex/pr54-offline-customer-create`. |
| Decisões | Tomadas pelo projeto | [ADR 0035](../docs/adr/0035-produto-criado-offline.md): um comando atômico `product.create` (produto, variante padrão e estoque de abertura opcional); IDs do dispositivo; SKU em conflito recusa o comando inteiro (`sku_conflict`) e o descarte é explícito; `product:create` mais `inventory:adjust` quando há estoque, via `extraCapabilities`. |
| Banco | Concluído | Sem migration. `createProduct` aceita `id`, `defaultVariantId`, `sku` e `listPrice`, em savepoint, com `ProductIdConflictError` e `InvalidProductIdError`. |
| Servidor | Concluído | Manipulador `product.create` registrado; `extraCapabilities` no `sync.push` (lease precisa carregar todas); 8 testes do manipulador e 1 do `push`. |
| Cliente | Concluído | `offline/product-create.ts` (valida, enfileira, linhas otimistas de produto/variante/saldo, restauração, estado pendente/recusado, descarte explícito com bloqueio por dependentes e por `sending`); servidor sintético atômico com SKU único e resposta perdida; 9 testes. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:offline-product:verify` (`offline-product`, suítes `ci` e `gate5`): IDs, SKU, preço e estoque preservados; change log; reenvio cria uma vez; SKU em uso (qualquer caixa) recusa tudo; ID de produto ou variante ocupado (mesma ou outra organização); atomicidade com estoque recusado e categoria indisponível; `receiveStock` negado sob `sync:push` puro. |
| Limites | Registrados | Só a variante padrão é criada offline (opções e variantes continuam online); sem laboratório de navegador nem tela; a prova em Android físico ainda bloqueia ligar a escrita offline. |

### PR56 — Comandos de estoque offline (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr56-offline-stock-commands` sobre `codex/pr55-offline-product-create`. |
| Decisões | Tomadas pelo projeto | [ADR 0036](../docs/adr/0036-comandos-de-estoque-offline.md): `stock.receive`, `stock.write_off`, `stock.count` (capability `inventory:adjust`); servidor autoritativo (`insufficient_stock`, `inventory_version_conflict`), sem "forçar"; o cliente não edita o saldo local, o saldo exibido é a linha do servidor mais a fila; descarte explícito. |
| Banco | Concluído | Sem migration e sem mudança de repositório: os manipuladores chamam `receiveStock`, `writeOffStock` e `inventoryCount`. |
| Servidor | Concluído | `handlers/stock-commands.ts` (três manipuladores, códigos estáveis, contagem exige `baseVersion`), `handlers/identity.ts` (`withCapability`); 13 testes. |
| Cliente | Concluído | `offline/stock-commands.ts`: `effectiveStock`, `receiveStockOffline`, `writeOffStockOffline`, `countStockOffline` (leva a versão-base), `pendingStockCommands`, `discardPendingStock`; leitor `inventoryRow` no armazenamento local; servidor sintético do razão; 12 testes. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:offline-stock:verify` (`offline-stock`, suítes `ci` e `gate5`): entrada uma vez e replay; fila com a versão-base prevista igual à do razão; baixa acima do saldo e contagem obsoleta recusadas sem rastro; variante inexistente; data futura; duas contagens concorrentes (uma conflita); duas baixas concorrentes (saldo nunca negativo); isolamento entre organizações. |
| Limites | Registrados | Sem tela nem laboratório de navegador; a prova em Android físico ainda bloqueia ligar a escrita offline; contagem obsoleta após descarte de um movimento anterior só é percebida pelo servidor. |

### PR57 — Venda offline (implementação, gate Neon e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr57-offline-sale` sobre `codex/pr56-offline-stock-commands`. |
| Decisões | Tomadas pelo projeto | [ADR 0037](../docs/adr/0037-venda-offline.md): um comando `sale.confirm` (capability `sale:create`) pela mesma `confirmSale` da venda online; estoque autoritativo do servidor (venda recusada inteira, sem rastro); aviso local sem bloqueio; estados `pending`, `syncing`, `confirmed`, `rejected`, `needs_attention`; correção por reenvio como comando novo ou descarte, sem "forçar"; estoque exibido desconta a fila. |
| Banco | Concluído | Sem migration e sem mudança de repositório. |
| Contrato | Concluído | `offlineSalePayloadSchema` em `@polaris/contracts` (sem perfil de pagamento). |
| Servidor | Concluído | `handlers/sale-confirm.ts` (esquema mais normalização do domínio sem checagem de relógio, códigos estáveis, snapshot inválido classificado); 6 testes. |
| Cliente | Concluído | `offline/sale-confirm.ts`: `createOfflineSale` (preço de tabela local, total, avisos de estoque), `pendingSales` com os cinco estados, `confirmedSales`, `resubmitRejectedSale`, `discardPendingSale`; `syncOutbox` informa `acceptedCommands`; `effectiveStock` desconta vendas na fila; leitor `variantRow`; 13 testes. |
| Gate Neon PostgreSQL 18 | Concluído | `poc:offline-sale:verify` (`offline-sale`, suítes `ci` e `gate5`): confirmada uma vez com `recordedAt` e replay; versão por linha; recusa total sem rastro; recusa gravada e reenvio como comando novo; janela de datas; disputa pelas últimas unidades; isolamento entre organizações. |
| Limites | Registrados | Sem perfil de pagamento offline; sem tela nem laboratório de navegador; a prova em Android físico ainda bloqueia ligar a escrita offline; aparelho offline além da janela retroativa tem as vendas recusadas por `sale_occurred_too_old`. |

### PR58 — Painel de atenção das operações offline (implementação, gate de navegador e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr58-conflict-attention` sobre `codex/pr57-offline-sale`. |
| Decisões | Tomadas pelo projeto | [ADR 0038](../docs/adr/0038-painel-de-atencao-offline.md): modelo puro de itens de atenção (causa, explicação, ações honestas por causa); sem "forçar sincronização"; descarte em duas etapas; reenvio só da venda recuperável, como comando novo; mudança de direito leva à revisão da conta sem descartar. |
| Modelo | Concluído | `offline/attention.ts` (`buildAttention`, `discardAttentionItem`, `resubmitAttentionItem`, `discardWarning`); `discardPendingCustomer` no módulo do cliente; 8 testes. |
| Painel | Concluído | `offline/attention-panel.tsx` e CSS (só apresentação, botões desabilitados durante a resolução); 5 testes de marcação (sem botão que force a sincronização). |
| Gate de navegador | Concluído | `e2e/offline-attention.e2e.ts` sobre o laboratório `/offline-attention-lab` (outbox real em IndexedDB): venda recusada aparece, bloqueia a fila e sobrevive a recarregar; reenvio como comando novo; descarte com confirmação; direito alterado só leva à revisão da conta. 4 cenários em Chromium desktop e Pixel 5 emulado. |
| Limites | Registrados | O painel ainda não está montado no app (a interface offline não está montada); sem edição guiada de SKU; a prova em Android físico ainda bloqueia ligar a escrita offline. |

### PR59 — Sair com operações pendentes (implementação, gate de navegador e verificações locais concluídos; publicação: ver linha abaixo)

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Base | Concluída | Branch `codex/pr59-logout-pending` sobre `codex/pr58-conflict-attention`. |
| Decisões | Tomadas pelo projeto | [ADR 0039](../docs/adr/0039-saida-com-operacoes-pendentes.md): enviar primeiro; bloquear a saída com razão e contagens; nada é apagado em nenhuma organização enquanto uma tiver trabalho; descarte só com confirmação explícita, em duas etapas; limpeza que se recusa a perder comandos; encerrar a sessão só depois de `ready`. |
| Guarda | Concluído | `offline/logout-guard.ts` (`attemptLogout`, `discardAndLogout`), `offline/logout-purge.ts` (`purgeNamespace`: outbox e depois coleções locais); 9 testes. |
| Diálogo | Concluído | `offline/logout-dialog.tsx` e CSS (sem "sair assim mesmo", descarte em duas etapas, aviso de comandos já enviados); 5 testes de marcação. |
| Gate de navegador | Concluído | `e2e/offline-logout.e2e.ts` sobre `/offline-logout-lab` (outbox em IndexedDB e banco em OPFS reais, rede e servidor simulados): 6 cenários em Chromium desktop e Pixel 5 emulado. |
| Limites | Registrados | O app ainda não tem tela de conta: o guarda não está ligado a um botão "Sair" nem ao `signOut`; sem registro das organizações do usuário no aparelho (quem chama informa as organizações); a prova em Android físico ainda bloqueia ligar a escrita offline. |

### Handoff para continuação por outro desenvolvedor

| Subetapa | Status | Evidência / dependência |
| --- | --- | --- |
| Documento de passagem PR42 → PR43 | Concluído | [`doc/handoff-pr43.md`](handoff-pr43.md) registra o head exato, cadeia de PRs, decisões, artefatos, segurança das CLIs, sequência do PR43, verificações e documentos que devem continuar atualizados. |
| Merge para habilitar o handoff | Não necessário | O PR42 já está publicado no branch remoto e é a base cumulativa para PR43. Integrar ao `main` exigiria decidir e processar a cadeia anterior de PRs; o novo desenvolvedor pode iniciar sobre `origin/codex/pr42-payment-profiles`. |
| Próxima etapa | PR43 concluído em draft | A confirmação transacional da venda foi implementada em `codex/pr43-sale-transaction` (ver seção PR43). PR44 — Customer attribution foi implementado em `codex/pr44-customer-attribution` (ver seção PR44). PR45 — Sale cancellation foi implementado em `codex/pr45-sale-cancellation` (ver seção PR45). PR46 — Partial returns foi implementado em `codex/pr46-partial-returns` (ver seção PR46). PR47 — Sale dates foi implementado em `codex/pr47-sale-dates` (ver seção PR47) e o Gate 4 foi fechado (ver seção Gate 4). O checkpoint seguro foi alcançado; a próxima etapa do plano seria a Fase 5 (PR48), depois da revisão completa descrita em [`doc/checkpoint-gate4.md`](checkpoint-gate4.md). |
