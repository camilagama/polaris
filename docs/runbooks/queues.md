# Filas Cloudflare (Queues)

**Gatilho:** antes do primeiro deploy do Worker `polaris-web` com as filas declaradas no `wrangler.jsonc`, ou ao rever limites e custo das filas ([ADR 0083](../adr/0083-filas-cloudflare-e-consumidor-idempotente.md)).

> **Nada deste procedimento foi executado**, e este PR não cria recurso algum na conta Cloudflare. Os comandos abaixo são para o responsável, depois de aprovar, com a identidade confirmada pela [política de perfis de CLI](./cli-profile-policy.md): não execute o CLI sem confirmar o perfil e a conta permitidos.

## O que está declarado

Em `apps/web/wrangler.jsonc` (Worker `polaris-web`):

| Fila | Binding de envio | Consumidor | Para quê |
| --- | --- | --- | --- |
| `polaris-critical` | `QUEUE_CRITICAL` | 1 mensagem por vez, 1 invocação por vez, 5 tentativas, recuo 30 s | o que afeta dinheiro ou acesso (nenhum evento usa ainda) |
| `polaris-default` | `QUEUE_DEFAULT` | 1 mensagem por vez, 1 invocação por vez, 3 tentativas, recuo 30 s | o trabalho comum; `data_export.requested` |
| `polaris-media` | `QUEUE_MEDIA` | 1 mensagem por vez, 1 invocação por vez, 3 tentativas, recuo 60 s | o que é pesado e pode esperar (nenhum evento usa ainda) |

Hoje **nada envia** a essas filas: o despachante do outbox é o PR110. O consumidor está ligado e, ao receber `data_export.requested`, roda o job de exportação para **um** pedido e **sem** a varredura de expiração e exclusão (essa fica com o job horário, que continua valendo). Uma mensagem só é aceita na fila do seu tipo (`default` para a exportação); em outra fila ela é descartada com aviso. O nome da fila deve seguir `polaris-<critical|default|media>`, com **sufixo** de ambiente se houver (por exemplo `polaris-default-staging`); um prefixo (`staging-polaris-default`) faz o consumidor descartar tudo como fila errada. Mensagem com tipo ou versão que o consumidor não conhece é descartada como inválida: ao adicionar um tipo, implante o consumidor antes do produtor. O envelope não é assinado: quem pode escrever na fila é quem a controla, então restrinja o token e o acesso de envio à conta e, no teste manual, envie só envelopes com IDs fictícios. Sem DLQ (PR111): uma mensagem que falha todas as tentativas é descartada pela plataforma.

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

Só depois de criar as três filas, e com o resto do checklist de go-live, faça o deploy do Worker. **Um deploy com consumidor de fila inexistente falha**, de propósito: ele impede subir sem este passo.

## Verificação

1. `wrangler queues list` mostra as três filas, e o painel do Worker lista `polaris-*` como consumidor.
2. Com o despachante (PR110): uma exportação pedida gera um evento, uma mensagem em `polaris-default` e o job de exportação rodando em segundos, sem esperar a hora cheia. Até o PR110, o consumidor pode ser exercitado enviando um envelope válido à fila pelo painel ou por `wrangler queues` (sem dado pessoal: só IDs opacos).
3. Acompanhar o uso diário de operações no painel; ao passar de 60% das 10.000 (6.000 operações), o responsável decide entre reduzir o volume, ajustar lote e tentativas ou contratar o plano pago.

## Rollback ou forward-fix

- Para parar o consumo sem apagar nada: remova o bloco `queues.consumers` do `wrangler.jsonc` e faça o deploy; as mensagens ficam na fila até a retenção (24 horas no Free). O envio e o job horário não dependem disso.
- Apagar uma fila apaga as mensagens dela: só o responsável, e só depois de conferir que o outbox mantém os eventos (`pending` ou `dispatched`) que ainda importam.

## Limites conhecidos

- O registro de processamento do consumidor é **em memória** até o PR110: a idempotência de verdade, hoje, é do handler (a exportação toma o pedido no banco).
- A falha de montar uma exportação é registrada pelo job (que não lança) e a nova tentativa é do job horário, não da fila.
- Sem DLQ: mensagem que esgota as tentativas some (PR111).
- Uma falha do job de exportação devolve o pedido a `requested` sem recuo (ADR 0078, 3 tentativas): várias mensagens seguidas podem gastar as tentativas em segundos, onde o cron as espaçava em uma hora. Hoje nada envia mensagens; o PR110 revisa isso (recuo no despachante).
- Mensagem que expira na fila (24 horas no Free) sem ser consumida se perde; o PR110 trata a reconciliação.

Escalonamento: o responsável pelo teto de custo e pelas contas Cloudflare.
