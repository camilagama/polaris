---
status: accepted
---

# Política de sessão e de conta

## Contexto

O [ADR 0004](0004-separar-autenticacao-de-tenancy.md) separou autenticação de tenancy. Faltava registrar as escolhas de política de sessão e de conta tomadas ao implementar Better Auth (Google, e-mail/senha, vínculo de contas, sessões). Elas protegem contra tomada de conta e vazamento de credenciais e são difíceis de mudar depois que existem usuários reais. Os detalhes operacionais vivem em [authentication.md](../business-rules/authentication.md); este ADR guarda o motivo.

## Decisão

Registro retroativo das decisões tomadas nos PR13 a PR18 e confirmadas na revisão do checkpoint Gate 4 (13/10/2026):

- **Duração da sessão.** A sessão expira após 7 dias sem renovação (TTL por inatividade), com renovação no máximo a cada 24 horas de uso, e tem um **teto absoluto de 30 dias** desde a criação, imposto pelo Worker e por um trigger do banco que limita `expires_at` e mantém `created_at` imutável. O cache de sessão em cookie fica desativado, para que revogação e validade absoluta sejam sempre verificadas no servidor.
- **Sem vínculo implícito de contas.** Um login social nunca associa contas automaticamente. O vínculo Google exige sessão existente e verificada, iniciada por ação explícita do usuário, com e-mail verificado e igual nos dois lados; `trustedProviders` fica vazio e `idToken` enviado pelo cliente não cria vínculo.
- **Senhas.** Fator único com 15 a 128 pontos de código Unicode após NFC, sem regras de composição nem expiração periódica, e consulta ao corpus de senhas comprometidas (HIBP, k-anonymity com padding) ao criar ou alterar. A consulta é **fail-closed**: se não puder ser concluída, a senha não é aceita nem armazenada. Reset de senha revoga todas as sessões.
- **Tokens OAuth cifrados.** Os tokens do provider são cifrados pelo Better Auth em repouso e o `id_token` não é persistido.
- **Abuso.** Rotas públicas de autenticação exigem Turnstile validado no servidor e limites por IP (contadores aproximados por localidade, uma camada de contenção e não uma quota global). E-mail/senha permanece desligado até Turnstile, bindings, e-mail transacional e domínio de envio estarem configurados.
- **Auditoria de segurança** registra o ID interno do usuário e o tipo do evento, sem token, payload ou dados pessoais.

## Consequências

- Perder o dispositivo ou a senha tem janela de exposição limitada: no pior caso 30 dias, e a revogação é efetiva na próxima requisição.
- Usuários que dependem de um único provider não ganham vínculo automático; recuperar acesso passa por fluxos explícitos e verificados.
- Falha do serviço HIBP bloqueia criação e troca de senha, mas não o login; é um custo de disponibilidade aceito em favor da segurança.
- Pendências conhecidas antes de ligar e-mail/senha em produção: o Worker deve usar o IP da borda (`cf-connecting-ip`) em vez de `X-Forwarded-For`, o contexto autenticado de `/rpc` deve conferir o teto absoluto da sessão e rate limits cobrem `change-password` e `verify-password`. Elas estão no checklist de go-live dos [runbooks](../runbooks/README.md).

## Alternativas consideradas

- **Sessão longa e deslizante sem teto.** Melhor ergonomia, mas uma sessão roubada nunca expira se continuar sendo usada.
- **Vínculo automático por e-mail verificado.** Reduz atrito, mas permite tomada de conta quando um provider reporta e-mail verificado de forma permissiva.
- **Regras de composição e troca periódica de senha.** Contrariam a orientação do NIST SP 800-63B-4 e pioram a qualidade das senhas.
- **HIBP fail-open.** Mantém o cadastro no ar durante a falha do serviço, mas aceitaria senhas comprometidas justamente quando a verificação não funciona.

## Emenda (19/10/2026, [ADR 0100](0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md))

O ADR 0100 registra a tela de entrada e fecha parte das pendências acima; o que ele decide ainda não está no código e vale a partir dos PRs P1 a P10 (estado em `doc/status-implementacao.md`). Sem mudar nada do que está decidido neste ADR:

- **Rota e retorno.** O app ganha `/entrar`. O login social envia `callbackURL = /entrar?voltar=<destino codificado>` e `errorCallbackURL = /entrar?erro=google`, porque o Better Auth 1.6.23 recusa o destino inteiro codificado; `/entrar` valida o `voltar` de novo (caminho do app, sem caracteres de controle, `/api`, `/rpc`, `/health`, `/ready` nem `/webhooks`, nunca `/entrar`) e um valor inválido vira `/`.
- **Limitador do login social.** `AUTH_SOCIAL_RATE_LIMITER` (20 por 60 s por IP) cobre o início e o callback do Google e não depende de `AUTH_ABUSE_PROTECTION_ENABLED`. O 429 do início devolve JSON `auth_rate_limited`; o 429 do callback devolve **302 `/entrar?erro=limite`**; sem o binding (ou com o limitador falhando), o início responde 503 em JSON e o callback devolve **302 `/entrar?erro=indisponivel`**. A tela `/entrar` aceita só `erro=google`, `erro=limite` e `erro=indisponivel`; qualquer outro valor mostra a tela padrão e nunca é refletido.
- **Abuso.** O bloqueio por e-mail (5 falhas em 15 minutos travam por 15 minutos, contador no PostgreSQL) soma-se ao Turnstile e ao limite por IP nas rotas de senha. A tela diz "Entrada pausada".
- **Troca de senha.** `change-password` e `set-password` exigem sessão de até 15 minutos; a troca revoga as outras sessões e troca a época dos leases. A pendência de rate limits em `change-password` e `verify-password` continua no checklist de go-live.
- **E-mail e senha continua desligado** até haver domínio de envio verificado; a senha só liga pela flag, depois do P8 e do P9 do ADR 0100.
- **Destino validado no servidor (P1).** Antes de chamar o Better Auth, o servidor recusa com 403, sem `Location`, qualquer `callbackURL`, `errorCallbackURL`, `newUserCallbackURL` ou `redirectTo` que não seja caminho do app: host, esquema, `//`, barra invertida, caractere de controle, `/api`, `/rpc`, caractere que o regex do Better Auth recusa (por exemplo `/vendas(x)`) e, em `/entrar?voltar=`, um `voltar` que também não passe. O validador é `apps/web/src/lib/return-path.ts`, o mesmo que o `/entrar` usará.

## Emenda (24/10/2026): o Better Auth do contexto de requisição é montado uma vez por isolate

Os Workers Logs do staging mostraram estouros de CPU (10 ms do plano Free) até em `get-session`: montar o Better Auth inteiro a cada requisição autenticada, no isolate frio, já passa do teto. Nada do que está decidido acima muda (cookie, janela ociosa, teto absoluto de 30 dias, conferido pelo contexto); muda só **quando** a instância nasce:

- O contexto autenticado de `/rpc` monta o Better Auth **uma vez por isolate** (de novo só se `BETTER_AUTH_BASE_URL` ou `BETTER_AUTH_SECRET` mudarem) e o usa só para `getSession`.
- **Nenhum objeto de E/S fica no escopo do módulo.** O `Pool` é de quem o abriu: o Workers não deixa outra requisição usá-lo. A instância guarda só configuração e um repassador (`requestScopedDatabase`, `auth/request-database.ts`) que, a cada chamada, lê o `db` da requisição em andamento do `AsyncLocalStorage` (`nodejs_als`, `wrangler.jsonc`). No `/rpc`, o `runWithRequestScope` envolve apenas o `getSession` (nas rotas `/api/auth/*`, a requisição inteira: emenda de 25/10/2026); fora dele o repassador não tem `db` e lança `request_database_unavailable`, ou seja, uma chamada que escapa da requisição falha fechada em vez de usar a conexão de outra.
- O código que o `createBetterAuth` monta com o `database` lê `database.$client` **na hora de usar**, nunca na construção (o gravador do registro de acesso e o do fim do link de verificação), e o identificador de requisição das gravações vem de uma função, não de uma constante da instância. O mapa de IP já registrado por sessão vale só para a requisição em andamento: quando outra começa, ele é esquecido (o banco já descarta o repetido do mesmo IP em minutos, ADR 0092; perder uma entrada custa uma consulta, guardá-la custaria um registro de acesso).
- As rotas `/api/auth/*` (`auth/handler.ts`) continuam montando a instância por requisição, com a conexão própria: não entram nesta emenda (entram na de 25/10/2026, abaixo).
- Regra para quem mexer aqui: não guardar `pool`, `db` nem `$client` fora da requisição; todo acesso novo ao banco dentro das opções do `createBetterAuth` lê do `database` dentro da função, não ao montar.
- O `drizzle(...)` do `createDatabase` deixou de receber `schema`: ninguém usa `db.query.*` (o adaptador do Better Auth só usaria com `experimental.joins`, desligado), e montar o mapa relacional de todas as tabelas, duas vezes por requisição, era CPU sem uso.
- Um erro inesperado numa rota do RPC responde **503** com `data.reason: "server_busy"` (antes, 500 sem motivo); o log segue com a classe e o SQLSTATE da falha original. O motivo é só a marca para o cliente (a repetição da leitura é da t338); um `ORPCError` já formado passa sem mudança.

## Emenda (25/10/2026): as rotas `/api/auth/*` também usam a instância por isolate

O `get-session` que o app chama a cada carga passa por `/api/auth/*` (`auth/handler.ts`), que ainda montava o Better Auth a cada requisição: era onde estavam 6 dos estouros de CPU do log. Nada da política acima muda; muda só quando a instância dessas rotas nasce:

- `handler.ts` monta o Better Auth **uma vez por isolate** e o refaz só quando muda o ambiente (`BETTER_AUTH_SECRET`, `BETTER_AUTH_BASE_URL`, a senha ligada ou desligada, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) ou depois de uma falha. A chave vem só do ambiente, nunca da requisição. É uma instância à parte da do `/rpc`, com as opções das rotas de entrada (e-mail, Google).
- **Antes de compartilhar, o estado de usuário e de requisição saiu da instância.** O que os hooks lembram entre os passos de uma requisição (o ator do `/sign-out`, que o hook depois do logout audita quando a sessão já não existe; o IP já registrado por sessão; as marcas da renovação diária) fica no escopo da requisição (`AuthRequestState`, novo a cada `runWithRequestScope`). Com o ator na instância, o logout de um usuário iria para a auditoria de outro.
- **O escopo da requisição leva o que cada requisição monta:** o `db`, o identificador, o `waitUntil` e a entrega de e-mail. As opções do `createBetterAuth` leem esses valores por função, na hora do uso, nunca na montagem; uma tarefa em segundo plano continua lendo o escopo da requisição que a criou, mesmo depois que outra começou. Fora do escopo, tudo lança `request_database_unavailable` (o repassador do `db` lê o escopo em toda armadilha do `Proxy`: leitura, escrita, chaves, descritores, protótipo). Depois de montada, a instância só é descartada se a montagem falhou (`$context` rejeitado); uma queda do banco não custa uma instância nova por requisição. O provedor Google é configuração (credenciais do ambiente) e fica na instância, como parte da chave.
- O `get-session` do `/rpc` grava o registro de acesso com o identificador da requisição (`X-Request-Id`), lido do `requestIdMiddleware`, e não mais com um UUID sorteado. O identificador pode vir do cliente (um UUID bem formado no `X-Request-Id`): é campo de correlação, não prova de nada.
- O limitador em memória do Better Auth já era do módulo, não da instância (`api/rate-limiter`, 1.6.23), então compartilhar a instância não o muda.
- **Regra para quem mexer aqui:** nada de estado de usuário ou de requisição na instância (variável, mapa ou conjunto criado no `createBetterAuth` que um hook escreve); isso vai para o `AuthRequestState` do escopo. Todo acesso ao banco ou a um serviço por requisição é lido dentro da função, na hora do uso, pelo escopo. Uma instância que serve muitas requisições passa `requestState: currentAuthRequestState`; o `createBetterAuth` recusa montar uma instância com `requestId` por função sem ele. Sem nenhum dos dois, a instância guarda um estado próprio, que só serve à instância de uma requisição só (testes e gates).

## Emenda (25/10/2026): o `get-session` lê a sessão uma vez

Depois da emenda anterior o `get-session` ainda fazia o trabalho de sessão duas vezes: `enforceAbsoluteSessionLifetime` chamava `auth.api.getSession` inteiro (cookie, leitura da sessão e do usuário, ganchos) só para comparar o `created_at` com os 30 dias, e em seguida o `auth.handler` refazia tudo para a resposta. Eram 2 pipelines e 4 consultas por requisição. A regra não muda; muda onde ela é aplicada:

- No `GET /api/auth/get-session`, o teto de 30 dias é aplicado **sobre a única leitura da rota**, no gancho `after` do `createBetterAuth` (`revokeSessionPastAbsoluteLimit`, `auth.ts`). Sessão com `created_at` a partir de 30 dias exatos (ou ilegível) é apagada (`internalAdapter.deleteSession`), o cookie é limpo e a resposta é `null`, como a de uma sessão que não existe. Se a revogação falhar, o erro sai e a sessão **nunca** é respondida (falha fechada). O gancho vale para toda chamada do `get-session`, inclusive `auth.api.getSession`.
- Uma sessão já passada do teto que também estava na hora da renovação diária recebe a renovação (uma escrita) antes de ser revogada na mesma requisição; o registro de acesso `session_refreshed` dessa renovação não é gravado.
- As demais rotas `/api/auth/*` (sair, trocar senha, listar e revogar sessões) mantêm a leitura anterior ao handler (`enforceAbsoluteSessionLifetime`), que continua exportada: são raras e a regra dessas rotas não muda.
- O `cookieCache` continua desligado: a revogação imediata e o teto absoluto seguem conferidos no servidor a cada leitura. Ligá-lo troca essa garantia por um atraso de revogação de até N segundos e é decisão do usuário, não desta emenda.
- Prova: `get-session-single-read.test.ts` conta as instruções SQL de uma leitura (2, onde a composição anterior mandava 4), prova o teto aos 30 dias menos 1 s e aos 30 dias mais 1 s, a ausência do registro de renovação na revogação e o registro diário e de IP de uma sessão dentro do teto.
