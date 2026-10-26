---
status: accepted
---

# Tracing e amostragem do Workers Observability

> O número deste ADR (0094) é o próximo livre na `main` e nos PRs abertos no momento da escrita (o 0093 é o das funções `SECURITY DEFINER`, já na `main`); pode mudar se outro entrar antes.

## Contexto

O plano da Fase 12 (PR 117) pede observabilidade ligada, amostragem alta no staging, cerca de 5% na produção e erros sempre registrados. Os três Workers (`polaris-web`, `polaris-admin`, `polaris-catalog`) tinham só `"observability": { "enabled": true }`. O [ADR 0089](0089-evlog-e-logger-tipado-no-backend.md) fez do Workers Logs o destino do logger, e o [ADR 0076](0076-teto-de-custo-e-free-tier-primeiro.md) fixa o teto de US$ 10 por mês e o plano Workers Free.

Fontes da Cloudflare consultadas em 19/10/2026: [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) (amostragem por requisição, limites do plano), [Traces](https://developers.cloudflare.com/workers/observability/traces/) (`observability.traces`, beta, retenção de 7 dias), [configuração do Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/#observability) o [preço do Observability](https://developers.cloudflare.com/observability/pricing/) e o `config-schema.json` do wrangler 4.147 do repositório (campos `logs.*`, `traces.*`, `invocation_logs`).

## Decisão

- **Bloco explícito nos três `wrangler.jsonc`**, com o padrão de produção no topo:

  ```jsonc
  "observability": {
    "enabled": true,
    "logs": { "enabled": true, "head_sampling_rate": 1, "invocation_logs": false },
    "traces": { "enabled": true, "head_sampling_rate": 0.05 }
  }
  ```

  Na versão atual da Cloudflare, `enabled: true` liga só os logs; o *tracing* precisa de `traces.enabled`. Com logs a 100% a amostragem não descarta erro algum.
- **Traces a 5% na produção** (`traces.head_sampling_rate: 0.05`), a amostragem pedida pelo plano.
- **Logs a 100%, com os *invocation logs* desligados.** A amostragem da plataforma é *head-based*, decidida por requisição: uma requisição fora da amostra perde todos os seus logs, inclusive o `server_error`, e a documentação não traz uma taxa separada para erros. Então "erros sempre registrados" só se garante deixando os logs a 100%. O que fica armazenado é o que o logger do Polaris emite (eventos com nome e campos fixos, já mascarados pelo [ADR 0089](0089-evlog-e-logger-tipado-no-backend.md)), sem a linha automática de cada invocação, o que mantém o volume baixo (consequência em "Consequências"). A amostragem de 5% vale para os traces, que é o dado volumoso e de diagnóstico.
- **Staging: ainda não existe.** Nenhum `wrangler.jsonc` tem `env.*` (a Fase 14 cria o staging), e `observability` é uma chave herdável: o `env.staging` terá de repetir o bloco inteiro, com `traces.head_sampling_rate` entre 0,5 e 1 (e os logs também a 1), porque um bloco de ambiente substitui o do topo em vez de se fundir a ele (no wrangler 4.147, `inheritable()` devolve `rawEnv[campo] ?? topo[campo]`). Um teste proíbe um ambiente nomeado de desligar a observabilidade, os logs ou os traces, de baixar a taxa dos logs e de ligar de novo os *invocation logs*.
- **Teste de configuração** (`packages/observability/src/tracing-config.test.ts`): lê os três `wrangler.jsonc` e exige observabilidade, logs e traces ligados, traces a 0,05, logs a 1 e *invocation logs* desligados.
- **Nada é contratado nem implantado.** A mudança é só de configuração no repositório; ela entra em vigor no primeiro deploy, que é um passo do responsável.

## Estimativa de volume e custo

A cobrança muda em 1º/12/2026 (daqui a seis semanas): logs e traces passam ao [preço do Cloudflare Observability](https://developers.cloudflare.com/observability/pricing/) (consultado em 19/10/2026); até lá vale o modelo da página do Workers Logs (200.000 eventos de log por dia no Free, 3 dias de retenção), e o primeiro deploy só ocorre perto da virada, então o dimensionamento usa o modelo novo. No Free, a franquia é de **0,5 GB por dia de ingestão, dividida entre Workers Logs e Workers Traces** (e outros produtos de observabilidade da conta), com retenção de 7 dias; "Cloudflare stops ingesting new data when the account reaches its daily limit" (volta às 00:00 UTC) e não há ingestão adicional no Free. A ingestão conta o corpo do evento e os atributos, antes da compressão.

Premissas (**hipóteses, não medidas**: a página não dá bytes por evento ou por span, e os pesos por evento abaixo, de cerca de 1 KB por evento de log e 0,5 KB por span, são estimativas sem fonte da Cloudflare; a medida real fica para a Fase 14): um evento de log com os atributos de plataforma pesa cerca de 1 KB; uma requisição gera de 1 a 2 eventos de log nossos (hoje, só `server_error` na falha e os eventos de cron, fila e auth) e, se amostrada, um trace de algumas dezenas de spans de cerca de 0,5 KB.

- **Hoje:** sem evento por requisição HTTP (ADR 0091), a estimativa é de poucas centenas de eventos de log por dia por Worker (2 *cron triggers* por hora, algumas linhas por tick e por mensagem de fila), da ordem de 1 MB por dia, e traces a 5% de um tráfego de desenvolvimento: bem abaixo de 1% dos 0,5 GB.
- **Com um evento largo por requisição (futuro):** 100% dos logs somam cerca de 1 a 2 KB por requisição e os traces a 5% cerca de 1 KB por requisição em média (5% de ~20 KB). A franquia comportaria da ordem de 150.000 a 250.000 requisições por dia nos três Workers somados; o piloto da V1 deve ficar uma ordem de grandeza abaixo (hipótese).
- **Custo:** US$ 0 no Free, que não cobra excedente: o teto de US$ 10 do ADR 0076 não é tocado, e nada é contratado. No Paid (não contratado), a ingestão seria de US$ 0,25 por GB acima de 50 GB por ciclo.
- **Os traces dividem a cota com os logs.** Acima de 0,5 GB por dia o Free para de ingerir tudo, inclusive os erros: com logs a 100% a plataforma deixa de os descartar por amostragem, mas não os garante contra o limite diário. Por isso os traces ficam a 5% e o gatilho de revisão olha o consumo em GB.
- **Como medir os pesos no staging (Fase 14):** com `invocation_logs` e traces como em produção (traces entre 0,5 e 1), gerar um volume conhecido de requisições (por exemplo, 1.000), anotar o uso de ingestão da conta no painel (ou na API de uso) antes e depois, e dividir a diferença pelo número de eventos de log e de spans consultados no Workers Logs e nos Traces. Repetir com os traces desligados para separar o peso dos logs. Os valores medidos substituem as premissas acima e refazem a conta de requisições por dia; se a medida for maior que a hipótese, o gatilho abaixo pode disparar antes do esperado.
- **Gatilho de revisão:** 50% da franquia (0,25 GB por dia, em qualquer dia, conferido no painel de uso) ou qualquer cobrança. O consumo a olhar é o da **conta inteira**, não o de um Worker: logs e traces de todos os Workers da conta (e de outros produtos de observabilidade) dividem a mesma cota de 0,5 GB por dia, então o painel é lido no nível da conta e a soma dos três Workers (mais os de outros projetos, se houver) é que compara com 0,25 GB. O responsável decide entre baixar `traces.head_sampling_rate`, cortar eventos de sucesso no logger (mantendo os erros) ou contratar plano pago, o que exige decisão explícita (ADR 0076).

## Consequências

- Em produção, todo erro registrado pelo logger é enviado ao Workers Logs (sem descarte por amostragem) e 1 de cada 20 requisições gera um trace, enquanto a conta ficar abaixo de 0,5 GB por dia.
- **Os *invocation logs* desligados tiram o registro automático por invocação** (requisição, resposta e metadados da plataforma): sem evento largo por requisição (ADR 0091), o status HTTP e o resultado de uma requisição que não passa pelo logger não ficam no Workers Logs. A documentação lista exceções não capturadas entre os logs, mas não diz se sobrevivem com `invocation_logs: false`; isso fica para validar na Fase 14, junto com o evento largo por requisição. A validação é o item 16 do [checklist de release](../runbooks/release-checklist.md#16-exceção-não-capturada-visível-nos-workers-logs-com-invocation_logs-desligado-block): no staging, provocar uma exceção não capturada em cada Worker e conferir se ela aparece nos Workers Logs. Se não aparecer, ligar `invocation_logs` (o custo é uma linha por requisição, dentro da estimativa acima) antes do go-live é a saída.
- O campo `environment` do evento (`NODE_ENV` do bundle) e a medida de CPU do evlog continuam sem prova em nuvem; ficam para a Fase 14.

## Alternativas descartadas

- **Logs a 5% como os traces:** perderia 95% dos erros junto com os sucessos, contra o plano.
- **Logs amostrados na plataforma e erros garantidos por *tail sampling* no evlog:** o descarte da Cloudflare é decidido no início da requisição, antes de o evlog saber se ela vai falhar; só com os logs a 100% na plataforma o evlog pode, depois, cortar eventos de sucesso e manter os erros. Fica como a saída do gatilho de revisão, não como a configuração inicial.
- **Plano Paid para a franquia maior:** fora do ADR 0076, sem necessidade na V1.

## Emenda (26/10/2026): `ROUTE_TIMING_ALL`, o tempo de toda rota só no staging

- **Problema.** O `http_request_timed` (com `isolate.id` e `isolate.seq`, [ADR 0095](0095-onde-os-alertas-operacionais-vao-rodar.md)) só sai nas rotas críticas, para conter o volume. Sem ele, uma rota nova (o `report.dailySales`) não pode ser medida no staging contra uma rota leve separando a chamada fria (`seq = 1`) das quentes, nem pelo mesmo critério.
- **Decisão.** A variável `ROUTE_TIMING_ALL`, só `"true"` no `env.staging` do `wrangler.jsonc` do web, faz o evento sair também em **todo procedimento** `/rpc` e em **toda rota nomeada** `/api`. Em produção a variável é `"false"`, e a verificação de isolamento do staging (`scripts/verify-staging-isolation.mjs`) recusa `"true"` ali. Qualquer valor que não seja exatamente `"true"`, ou a ausência dela, mantém só as rotas críticas. O valor vem do arquivo: uma variável posta à mão no painel da Cloudflare não passa pela verificação.
- **O que o evento grava** é o mesmo de antes: `route`, `method`, `httpStatus`, `durationMs`, `outcome`, `requestId` (UUID validado ou gerado pelo servidor) e `isolate`. O `route` é sempre um nome do código, nunca texto do cliente:
  - uma `/rpc` só sai quando o oRPC casou um procedimento;
  - uma `/api` só sai quando uma rota do app a nomeou, e sai pelo padrão (`/api/products/:productId/...`), nunca pela URL nem pela query.
  - Caminho que nada casou (digitado ou de sondagem), recusa antes do handler (origem, limite de taxa) e `/health` não geram evento.
- **Volume e custo.** É um evento por chamada a procedimento ou rota do staging. O tráfego é sintético e pequeno, dentro da franquia estimada acima. Uma chamada sem sessão a um procedimento real também gera evento, mas o limite de taxa do `/rpc` corta antes do handler, e a recusa não gera evento. O alerta `latencia-p95` filtra `route in criticalRoutes` e não muda. Na bancada local (`wrangler dev`), um evento a mais custa cerca de 0,75 ms de CPU por requisição. No staging, as rotas comparadas pagam o mesmo evento, então a diferença entre elas não muda.
- **Fim.** A variável fica enquanto houver medida de rota no staging. Ligar em produção exige refazer a conta de volume desta página e uma decisão explícita.
