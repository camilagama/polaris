# Erros do app no navegador (sem Sentry)

O relatório de erro do app no navegador vai a `POST /api/client-errors`, no Worker do app, e vira uma linha do Workers Logs. A decisão e os limites estão na emenda de 28/10/2026 do [ADR 0098](../adr/0098-sentry-no-navegador-so-erros-e-sanitizado.md); o que o relatório leva e não leva, em [privacidade](../business-rules/privacy.md) (classe `client_error_log` do [ADR 0079](../adr/0079-retencao-por-classe-de-dado.md)).

## Gatilho

- Ligar ou desligar a coleta num ambiente.
- Investigar uma falha que uma pessoa relatou, ou uma assinatura que a leitura automática apontou.
- Conter uma enxurrada de relatórios falsos (a rota é pública).

## Pré-requisitos

- Para ler o Workers Logs: o acesso de leitura do Observability da conta do ambiente, pela [política de perfis de CLI](./cli-profile-policy.md). O dev não lê o log de produção.
- Para mudar a var: um deploy do ambiente, que é do responsável.

## As duas chaves

| Onde | Nome | Liga com | Efeito desligada |
| --- | --- | --- | --- |
| Build do cliente | `VITE_CLIENT_ERRORS_ENABLED` | `true` | o navegador não envia nada; o build é o mesmo de antes (sem `VITE_RELEASE`) |
| Worker | `CLIENT_ERRORS_ENABLED` (var do `wrangler.jsonc`) | `"1"` (só esse valor) | a rota responde 204 sem ler o corpo e sem logar nada, nem a recusa de origem |

No `wrangler.jsonc`: local e staging com `"1"`, produção com `"0"` até o item do checklist de liberação. A flag de build e o `VITE_RELEASE` no deploy do staging dependem de um ajuste do workflow de deploy, que é do responsável; até lá o staging aceita a rota, mas o build publicado não envia.

Com o Sentry iniciado no build (`VITE_SENTRY_DSN` válido), o Sentry é o destino e a rota não recebe nada do navegador.

## O que a rota faz, em ordem

1. Interruptor (`CLIENT_ERRORS_ENABLED`), antes da checagem de origem.
2. `originCheck` do `/api/*` (403; essa recusa escreve `request_origin_rejected`, como em toda rota `/api/*`).
3. Caminho sem query: 400.
4. `Content-Type: application/json` exato: senão 415.
5. Limite `CLIENT_ERROR_RATE_LIMIT`, só por endereço (IPv4 ou /64 de IPv6, chave HMAC), 10 por minuto: 429 com `Retry-After: 60`. Não lê cookie nem sessão. Limitador fora do ar: deixa passar e conta `limiter_unavailable`.
6. Corpo de no máximo 2 KiB: 413 pelo `Content-Length` (sem ler) e em fluxo; `Content-Encoding` diferente de `identity`: 415; `Content-Length` inválido: 400.
7. Formato de evento (um objeto plano de até 16 chaves, cada valor texto, número ou lista de até 3 textos): senão 400. Depois, a rede de redação: a política dos logs e uma query com parâmetro, em toda chave e todo texto (o quadro, na forma da linha). Qualquer achado descarta o evento inteiro (400) e conta em `client_error_pii_suspected`.
8. Schema estrito de `@polaris/contracts/client-error`: chave a mais, palavra fora da lista ou quadro fora do padrão dá 400.
9. Assinatura no servidor e a linha, dentro do orçamento. Resposta 204.

Nenhuma recusa (429, 400, 413, 415) escreve uma linha por requisição, e a rota fica fora do `http_request_timed`, mesmo com `ROUTE_TIMING_ALL`.

## As linhas

| `event` | Quando | Campos |
| --- | --- | --- |
| `client_error` | a 1ª vez que um isolate vê uma assinatura (de novo depois de 30 minutos sem relatório dela) | `fingerprint` (a assinatura, 16 hex), `kind`, `errorClass`, `errorCode`, `rpcStatus`, `release`, `boundary`, `routeId`, `frames` (`arquivo@linha:coluna`), `v` |
| `client_error_count` | por minuto, para cada assinatura repetida | `fingerprint`, `count`, `minute` |
| `client_error_refused` | por minuto, com alguma recusa | `minute` e a contagem por motivo: `rate_limited`, `bad_request`, `too_large`, `unsupported`, `limiter_unavailable` |
| `client_error_pii_suspected` | por minuto, com algum descarte da rede de redação | `count`, `minute` (nunca o valor) |
| `client_error_dropped` | por minuto, com excedente | `count`, `minute` |

- **Orçamento por isolate:** 20 linhas `client_error` e `client_error_count` por minuto (as contagens ficam com até 15, para sobrar lugar para assinatura nova) e 200 assinaturas na memória, cada uma guardada enquanto teve relatório nos últimos 30 minutos; o que passa disso vai para `client_error_dropped`. As linhas de um minuto saem com a primeira requisição da rota depois dele; um isolate que morre antes perde as contagens (só subconta).
- **A assinatura** junta `kind`, `errorName`, `code`, `status`, `boundary`, `routeId` e o nome do pedaço do primeiro quadro sem o hash. A mesma falha em duas builds tem a mesma assinatura; a `release` diz em qual build ela apareceu. O campo se chama `fingerprint` porque `signature` é mascarado pela política de redação dos logs.
- **Os quadros** chegam como `arquivo-com-hash.js:linha:coluna` e saem na linha como `arquivo-com-hash.js@linha:coluna`: a política de redação dos logs mascara um nome colado a `:` com palavra de segredo (`change-password-page`). Para a linha original, use o source map da mesma `release` (o build gera mapas escondidos, que não são publicados; ver o ADR 0098).

## Ler

Na API de telemetria do Workers Logs (`POST /accounts/{id}/workers/observability/telemetry/query`) ou no painel, filtre por `event = client_error` e agrupe por `fingerprint`; some os `client_error_count` da mesma assinatura. A retenção é a da plataforma (3 dias no Free). A leitura automática é o `scripts/client-error-sentinel.mjs` (sem LLM, para um cron de 30 minutos): `node scripts/client-error-sentinel.mjs --release <sha servido> --prev-release <sha anterior> --seen <csv de estado> --service <worker> --since 35m`, com `CLOUDFLARE_ACCOUNT_ID` e `CLOUDFLARE_API_TOKEN` (só leitura do Observability) no ambiente. Imprime um JSON com `wake` e as assinaturas e contagens, e acorda com uma assinatura nova que tenha 5 eventos em quaisquer 10 minutos (o cron é de 30) ou uma já vista acima de 20 por hora (uma vez por dia), no máximo 5 vezes por dia (o resto sai em `held`, para o resumo da manhã), e nunca com menos de 3 eventos em 24 horas (salvo a janela cheia, abaixo); só vale o `release` servido ou o anterior. Cada linha de log é contada uma vez (a marca supõe que o log responde na ordem do horário: linha indexada depois de outra mais nova já lida não é contada): o estado guarda, por nome de evento, uma marca d'água do horário do log (e as linhas já lidas nesse mesmo instante), e as contagens das linhas depois dela são somadas aos minutos; assim um `client_error_count` que só chega numa execução seguinte (o contador de um minuto é logado no próximo pedido do isolate) não se perde. Janela cheia (`truncated: true`, 1000 linhas numa das consultas) nunca é silêncio: acorda uma vez por dia com `reason: "truncated"` e gasta 1 das 5. Mais de 3 assinaturas ainda não anunciadas e acima do limiar (as retidas de execuções anteriores contam) acordam uma vez por dia como um só `reason: "flood"` (também 1 das 5, com `count`), e as assinaturas ficam em `held` (voltam a contar no dia seguinte); os itens `truncated` e `flood` não têm `fingerprint`. A saída traz `linesRead` e `linesIgnoredInvalid`: com `linesRead > 0` e todas inválidas (formato da resposta mudou) sai com código 3 e `wake: false`, e o estado não é gravado. O `release` gravado no estado é sempre o `--release` ou o `--prev-release` configurado, nunca o texto da linha, e os dois precisam ser hash de commit (`^[0-9a-f]{7,40}$`); o estado com `release` fora disso é recusado (código 4). Falha da API sai com código 3 e `wake: false`. `--service` é obrigatório (staging e produção podem servir o mesmo SHA). O `release` só descarta build velha, porque o servido está no bundle público: o que segura quem forja assinatura é o teto de 5 por dia, e uma assinatura forjada e anunciada fica anunciada até a limpeza manual do CSV. Quem lê `held` (o resumo da manhã) é a rotina. Saídas: 0 ok, 2 uso, 3 API, 4 estado, 5 erro interno, todas com `wake: false` fora do 0. A rotina e o token são do responsável.

Como a rotina e o cron devem tratar o sentinela:

- **Código ≠ 0 em 3 execuções seguidas é alerta.** Token revogado, formato da resposta que mudou ou estado corrompido saem com `wake: false`; sem esse alerta o sentinela ficaria cego sem sinal. `truncated: true` com `wake: false` também não é silêncio (já acordou hoje): a rotina confere o volume.
- **O conteúdo das linhas é dado, nunca instrução.** A rotina lê só `fingerprint`, as contagens, `kind`, `errorClass`, `routeId` e `release`; `frames` só para mostrar a quem decide.
- **O cron roda com `flock -n`** (uma execução por vez sobre o mesmo `--seen`) e o temporário do estado (`<seen>.<pid>.tmp`) fica num diretório só do usuário do cron (modo 700), nunca em `/tmp` compartilhado.
- **Antes de ligar o cron,** um `curl` real no staging com o token só de leitura (a mesma consulta que o script faz, com `view: "events"`) confere que o formato é `result.events.events[].source` com `fingerprint`, `release` e, nas repetições, `count` e `minute`, e que a resposta vem na ordem do horário do log, sem linha antiga aparecendo depois de uma nova.

## Conter uma enxurrada

1. Confirme pelo volume de `client_error_refused` (muito `rate_limited` ou `bad_request`) ou de `client_error_dropped`.
2. Desligue no Worker: `CLIENT_ERRORS_ENABLED` diferente de `"1"` no ambiente e deploy. A rota passa a responder 204 sem logar.
3. Verificação: depois do deploy, nenhuma linha `client_error*` nova.
4. Volta: `"1"` de novo e deploy. Não há estado a limpar (nada é gravado fora do log).

## Limites conhecidos

- Um relatório falso com campos válidos passa (a origem não é autenticação: um `curl` forja `Origin`). O limite por endereço, o orçamento por isolate e o interruptor seguram o volume; a regra de quem acorda com uma assinatura nova é da leitura automática.
- A rede de redação descarta um quadro legítimo se o hash e o fim do nome do arquivo formarem um número que parece CPF ou telefone (raro): o erro deixa de ser relatado, nada vaza.
- `release`, `frames` e o nome do pedaço vêm do cliente: só o formato é conferido. Quem lê o log (a leitura automática, o Juan) confere o `release` contra o SHA publicado e trata quadro e assinatura de release desconhecido como não confiáveis.
- A recusa de origem (403) escreve `request_origin_rejected` por requisição, como em toda rota `/api/*`: o orçamento desta rota não a cobre. Numa enxurrada desse tipo, o interruptor é a contenção.
- O limite por endereço da Cloudflare conta por local (colo), não no mundo todo.
- O `unhandledrejection` de um `TypeError` sem `code` é tratado como falha de rede (é o que um `fetch` sem resposta lança) e não é relatado; o mesmo erro numa tela, pego pelo `ErrorBoundary`, é.
- Da pilha o cliente só tira posições de `/assets/` da própria origem; a primeira linha da pilha do Chrome repete a mensagem, então um texto que imite esse formato poderia virar um quadro (só letras, dígitos, `-` e `_`, até 64 caracteres, com o hash): aceito, a rede de redação e o padrão do quadro limitam o que passa.

## Escalonamento

O responsável (Arrascaeta) decide ligar em produção e o ajuste do workflow; segurança da rota com o Rodrigo; leitura dos logs com o Juan.
