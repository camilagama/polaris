# Filas Cloudflare (Queues)

**Gatilho:** antes do primeiro deploy do Worker `polaris-web` com as filas declaradas no `wrangler.jsonc` e o despachante do outbox, ou ao rever limites e custo das filas ([ADR 0083](../adr/0083-filas-cloudflare-e-consumidor-idempotente.md), [ADR 0084](../adr/0084-despachante-e-varredor-do-outbox.md)).

> **Nada deste procedimento foi executado**, e este PR não cria recurso algum na conta Cloudflare. Os comandos abaixo são para o responsável, depois de aprovar, com a identidade confirmada pela [política de perfis de CLI](./cli-profile-policy.md): não execute o CLI sem confirmar o perfil e a conta permitidos.

## O que está declarado

Em `apps/web/wrangler.jsonc` (Worker `polaris-web`):

| Fila | Binding de envio | Consumidor | Para quê |
| --- | --- | --- | --- |
| `polaris-critical` | `QUEUE_CRITICAL` | 1 mensagem por vez, 1 invocação por vez, 5 tentativas, recuo 30 s | o que afeta dinheiro ou acesso (nenhum evento usa ainda) |
| `polaris-default` | `QUEUE_DEFAULT` | 1 mensagem por vez, 1 invocação por vez, 3 tentativas, recuo 30 s | o trabalho comum; `data_export.requested` |
| `polaris-media` | `QUEUE_MEDIA` | 1 mensagem por vez, 1 invocação por vez, 3 tentativas, recuo 60 s | o que é pesado e pode esperar (nenhum evento usa ainda) |

Quem envia é o **despachante do outbox** (ADR 0084), num cron próprio (`19 * * * *`): toma até 25 eventos `pending` vencidos (e os de tomada vencida), envia com um `sendBatch` por fila, marca `dispatched` só o que a fila aceitou e devolve o resto com recuo. Uma execução que morre entre enviar e marcar gera uma **duplicata**, que o consumidor absorve. O consumidor, ao receber `data_export.requested`, monta **a exportação que o evento nomeia** (por ID e organização) e **sem** a varredura de expiração e exclusão; com o caminho da fila ligado (`OUTBOX_HYPERDRIVE` e `QUEUE_DEFAULT`), o job horário só varre e re-arma, e não monta mais nada (montar não cabe nos 10 ms de CPU do cron no plano Free). Uma mensagem só é aceita na fila do seu tipo (`default` para a exportação); em outra fila ela é descartada com aviso. O nome da fila deve seguir `polaris-<critical|default|media>`, com **sufixo** de ambiente se houver (por exemplo `polaris-default-staging`); um prefixo (`staging-polaris-default`) faz o consumidor descartar tudo como fila errada. Mensagem com tipo ou versão que o consumidor não conhece é descartada como inválida: ao adicionar um tipo, implante o consumidor antes do produtor. O envelope não é assinado: quem pode escrever na fila é quem a controla, então restrinja o token e o acesso de envio à conta e, no teste manual, envie só envelopes com IDs fictícios. Sem DLQ (PR111): uma mensagem que falha todas as tentativas é descartada pela plataforma.

## Checklist de go-live do despachante (responsável)

Nada disto foi executado. **Siga a ordem:** cada passo depende do anterior, e o passo 7 (ligar o `OUTBOX_HYPERDRIVE`) é o último, depois das medições.

1. **Migration antes do Worker.** Aplicar as migrations (inclusive a do despachante, 0071 ou o número que tiver na `main`) no banco do ambiente **antes** de qualquer deploy do Worker: ele chama funções novas (`claim_outbox_events`, `claim_queue_processing`, `claim_data_export_by_id`, `rearm_data_export_events`) e o pedido de exportação já grava no outbox desde o PR108. Um Worker novo sobre um banco antigo falha nessas chamadas.
2. **Papel de login do outbox e Hyperdrive, ainda sem ligar.** Criar um login que herde `polaris_outbox_runtime` (como os outros papéis de runtime, pela [política de perfis de CLI](./cli-profile-policy.md)) e um Hyperdrive para ele **sem query caching**. Só criar: o id do Hyperdrive vai para o `wrangler.jsonc` no passo 7, e não antes. Sem esse binding o despachante só avisa (`outbox_dispatch_not_configured`), os eventos ficam `pending` e o job horário continua montando as exportações como antes.
3. **Filas criadas** (seção "Criar as filas", abaixo). O deploy do passo 4 falha sem elas.
4. **Deploy do Worker sem o caminho da fila ligado** (a configuração de deploy do responsável **não traz** o bloco `OUTBOX_HYPERDRIVE`; o repositório só tem o id `local-only`, de desenvolvimento, e os ids reais dos outros Hyperdrives entram só na configuração de deploy, como pede o [checklist de runbooks](./README.md)), com as filas e os dois Cron Triggers (`17 * * * *` e `19 * * * *`; o plano Free permite cinco por conta). O consumidor já existe, o despachante só avisa, e o cron `:17` segue montando as exportações.
5. **Nenhuma exportação órfã.** Antes de ligar o `OUTBOX_HYPERDRIVE` (passo 7), conferir que não há pedido em andamento sem evento (com o caminho ligado, o cron não monta mais e o re-arm só olha eventos despachados): `SELECT e.id FROM data_exports e WHERE e.status IN ('requested', 'running') AND NOT EXISTS (SELECT 1 FROM event_outbox o WHERE o.type = 'data_export.requested' AND o.event ->> 'exportId' = e.id::text)` deve voltar vazio. Se não voltar, deixe o caminho desligado até esses pedidos terminarem pelo cron.
6. **Medir, numa prévia com o caminho ligado.** A prévia é um deploy **separado** do passo 4, com banco descartável (branch Neon descartável, com dados sintéticos, nunca o banco de produção), login do outbox, Hyperdrive e filas **próprios** (nomes com sufixo de ambiente, como `polaris-default-staging`), criados só para isso e apagados depois pelo responsável. A produção continua desligada até o passo 7:
   - **CPU do consumidor:** pedir uma exportação com dados e imagens próximos do teto e conferir no `wrangler tail` do consumidor que a montagem fica abaixo dos 30 s de CPU. Se não ficar, não ligue o caminho da fila e leve ao responsável a decisão de plano.
   - **CPU do despachante:** `wrangler tail` no cron `19 * * * *` com eventos pendentes; o `cpuTime` precisa ficar abaixo de 10 ms no plano Free. Se não ficar, reduzir o lote ou levar ao responsável a decisão do plano pago.
7. **Ligar o caminho da fila em produção:** só com os passos 1 a 6 concluídos, pôr o id real do Hyperdrive do passo 2 como `OUTBOX_HYPERDRIVE` e fazer o deploy. O id `local-only` do `wrangler.jsonc` é só para desenvolvimento.

## Desenvolvimento local

Não precisa criar nada: `bun run dev` (plugin do Vite) e `wrangler dev` simulam as filas em memória, com o consumidor do próprio Worker. Os bindings `QUEUE_*` existem no ambiente local. `bun run build` valida a configuração sem tocar na conta.

## Plano e custo

- Cloudflare Queues está no plano **Workers Free** desde 04/02/2026 ([changelog](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/)): **10.000 operações por dia** (leitura, escrita e exclusão somadas, na conta toda), **retenção de 24 horas** e até 10.000 filas. Conferir os números na [página de preços](https://developers.cloudflare.com/queues/pricing/) antes de criar: o plano pode mudar.
- Uma mensagem consome pelo menos três operações (escrever, ler, apagar); cada nova tentativa soma uma leitura. Cerca de 3.300 mensagens por dia cabem no Free. Acima disso, o envio falha: o despachante (PR110) mantém o evento `pending` e tenta de novo.
- Criar as filas **não tem custo no Free**; o plano pago (Workers Paid) não está contratado e só muda por decisão do responsável (teto de custo, ADR 0076 e ADR 0060). Se o responsável preferir o plano pago, é decisão de custo, não deste procedimento.

## Criar as filas (responsável)

Pré-requisito: confirmar o perfil e a conta (política de perfis de CLI). Uma vez por ambiente (os nomes abaixo são os de produção; para staging, use um sufixo e ajuste o `wrangler.jsonc` do ambiente):

```sh
wrangler queues create polaris-critical
wrangler queues create polaris-default
wrangler queues create polaris-media
wrangler queues list
```

A retenção padrão do Free é de 24 horas e não se altera; no plano pago o `--message-retention-period-secs` pode ser definido na criação.

Só depois de criar as três filas (passo 3 do checklist de go-live), faça o deploy do Worker (passo 4). **Um deploy com consumidor de fila inexistente falha**, de propósito: ele impede subir sem este passo.

## Verificação

1. `wrangler queues list` mostra as três filas, e o painel do Worker lista `polaris-*` como consumidor.
2. Uma exportação pedida gera um evento `pending`; no cron `:19` seguinte, o log mostra `outbox_dispatch_complete` com `sent: 1`, o evento fica `dispatched` e o consumidor monta a exportação (log `data_export_complete`). Uma mensagem enviada à mão (pelo painel ou `wrangler queues`) com um evento que o outbox não tem é descartada com `queue_message_unknown_event`: o registro de processamento confere o evento no banco. O aviso traz o ID do evento, o tipo e o motivo (`reason`: `event_not_held`, o outbox não tem o evento com aquela organização, chave, tipo e tentativa, ou `key_of_another_event`), sem conteúdo da mensagem; um pico desse aviso fora de teste manual é sinal de mensagem forjada ou de evento purgado, e o responsável investiga. Falha transitória do registro (`claim_contended` ou banco fora) **não** vira descarte: o consumidor registra `queue_ledger_unavailable` (com o `sqlState`: `40001` é `claim_contended`) e a mensagem é reentregue.
3. Acompanhar o uso diário de operações no painel; ao passar de 60% das 10.000 (6.000 operações), o responsável decide entre reduzir o volume, ajustar lote e tentativas ou contratar o plano pago.

## Rollback ou forward-fix

- Para parar o consumo sem apagar nada: remova o bloco `queues.consumers` do `wrangler.jsonc` e faça o deploy; as mensagens ficam na fila até a retenção (24 horas no Free). **Com o caminho da fila ligado, isso também para a montagem das exportações**: retire junto o binding `OUTBOX_HYPERDRIVE`, para o job horário voltar a montar.
- Para parar o despachante: retire o binding `OUTBOX_HYPERDRIVE` (os eventos ficam `pending`, nada se perde) ou o cron `19 * * * *`.
- Apagar uma fila apaga as mensagens dela: só o responsável, e só depois de conferir que o outbox mantém os eventos (`pending` ou `dispatched`) que ainda importam.

## Limites conhecidos

- O registro de processamento do consumidor é **durável** (`queue_processing`) quando `OUTBOX_HYPERDRIVE` existe; sem ele, em memória por isolate. Em qualquer caso a idempotência de verdade é do handler (a exportação toma o pedido no banco).
- A falha de montar uma exportação é registrada pelo job (que não lança): o pedido volta a `requested` com recuo (15 minutos, depois 1 hora) e o **re-arm** do job horário devolve o evento a `pending` quando o recuo acaba; o despachante o envia de novo.
- Sem DLQ: mensagem que esgota as tentativas some (PR111); evento com 1000 tentativas deixa de ser tomado. O re-arm cobre a exportação.
- Mensagem que expira na fila (24 horas no Free) sem ser consumida se perde; para a exportação, o re-arm a reenvia.
- O CPU do despachante no cron Free não foi medido (checklist acima).

Escalonamento: o responsável pelo teto de custo e pelas contas Cloudflare.
