# Provedores de cobrança: segredos, rotação e webhook

Procedimento dos segredos dos adaptadores de cobrança ([ADR 0101](../adr/0101-adaptador-asaas-porta-de-saida-e-releitura-do-recurso.md), [ADR 0063](../adr/0063-rota-de-webhooks-de-billing.md)). Aqui só há **nomes**: nenhum valor de chave ou token entra no repositório, em log, em PR, em comentário nem em relatório. Credenciais de produção, webhook de produção e o primeiro deploy são do responsável (POL-6, POL-10); para o CLI do Cloudflare, siga a [política de perfis](./cli-profile-policy.md).

## Asaas (cartão recorrente)

| Nome no Worker `polaris-web` | Tipo | Staging | Produção |
|---|---|---|---|
| `ASAAS_API_KEY` | secret | chave de homologação (começa com `$aact_hmlg_`) | chave de produção |
| `ASAAS_BASE_URL` | var | `https://api-sandbox.asaas.com/v3` | `https://api.asaas.com/v3` |
| `ASAAS_WEBHOOK_TOKEN` | secret | token gerado pelo Polaris, 32 a 255 caracteres | outro token |
| `ASAAS_WEBHOOK_TOKEN_NEXT` | secret | só durante a rotação do token | idem |

- **Trava de ambiente:** o cliente recusa rodar quando o host não bate com a chave (chave que começa com `$aact_hmlg_` fora do sandbox, ou outra no sandbox) e a rota responde 503 `billing_provider_not_configured`. O mesmo 503 aparece quando falta um dos três primeiros nomes ou quando o token tem menos de 32 caracteres; a rota nunca responde 200 sem eles.
- **Cuidado com o `$`:** a chave do Asaas começa com `$`. Num arquivo `.env` lido pelo shell, ponha o valor entre **aspas simples**; sem elas o shell expande `$aact...` e a variável fica vazia (o Asaas responde 401). Ao gravar o segredo pelo `wrangler secret put`, cole o valor no prompt, sem passar pela linha de comando.
- **Gerar o token do webhook:** `openssl rand -base64 48`, gravado como segredo `ASAAS_WEBHOOK_TOKEN` e no campo "Token de autenticação" do webhook no painel do Asaas.
- **Registrar o webhook** no painel do Asaas: URL `https://<domínio>/webhooks/billing/asaas` (sem barra final), envio **sequencial** (`SEQUENTIALLY`), com os eventos de cobrança, de assinatura e `CHECKOUT_PAID`. A fila do Asaas **pausa depois de 15 falhas seguidas**: o Polaris responde 503 quando a API está fora e quando a chave é recusada, e também quando a releitura não acha o recurso ou o recebe fora da forma, mas só nos primeiros 30 minutos do evento. Se pausar, corrija a causa, reative a fila no painel e reconcilie.

### Rotação da chave de API

1. Gere a nova chave no painel do Asaas (Integrações).
2. Grave a nova chave no segredo `ASAAS_API_KEY` e implante.
3. Confira que um evento de teste do sandbox (ou o próximo real) responde 200.
4. Revogue a chave antiga no painel.

Chave recusada (rotacionada ou revogada antes da hora) aparece no log como `billing_provider_rejected` com `httpStatus` 401 ou 403, uma vez por entrega; é o alerta antes de a fila pausar.

### Rotação do token do webhook

1. Gere o novo token e grave em `ASAAS_WEBHOOK_TOKEN_NEXT`; implante (o adaptador passa a aceitar os dois).
2. Troque o token do webhook no painel do Asaas.
3. Grave o novo valor em `ASAAS_WEBHOOK_TOKEN`, implante e apague o segredo `ASAAS_WEBHOOK_TOKEN_NEXT`.

### O que os registros dizem

| Evento no log | Significado | Ação |
|---|---|---|
| `billing_webhook_rejected` | token ausente ou errado (401) | conferir o token do painel e o segredo; repetido sem motivo é tentativa de terceiro |
| `billing_provider_not_configured` | falta segredo ou a chave não é do ambiente (503) | gravar o segredo certo |
| `billing_provider_rejected` | a API recusou a chave do Polaris (503) | rotação de chave fora de ordem ou chave revogada |
| `billing_webhook_unresolved` | a releitura não achou o recurso citado (503 por até 30 minutos depois do evento, só IDs) | conferir no painel se o recurso existe nesta conta |
| `billing_webhook_unresolved_given_up` | o mesmo, depois dos 30 minutos (200, nível erro) | reconciliar a organização do recurso; até o PR de banco seguinte o evento não fica em `billing_events` |
| `billing_provider_response_malformed` | a API respondeu fora da forma documentada (503 por até 30 minutos, depois 200) | ver se o Asaas mudou o formato; reconciliar |
| `billing_webhook_malformed` | entrega autêntica que o Asaas não documenta, ou recurso relido fora da forma (200) | investigar cada um |
| `billing_trial_fact_without_claim` | um checkout pago começaria o trial de uma organização que não tem a reserva de ninguém (a pessoa levou o teste para outra loja, ou optou antes do teste por pessoa); o evento fica `unresolved` com `trial_claim_missing` em `billing_events`, a organização continua sem trial e o reprocesso horário o relê (aviso; erro na última tentativa, só IDs opacos) | nada à mão: depois das tentativas, a manutenção horária cancela no Asaas a assinatura desse checkout, antes da 1ª cobrança (ver `billing_unclaimed_trial_settled`); não cobrar sem o trial sem o responsável |
| `billing_trial_checkout_discard_failed` | a reserva do teste mudou de loja, mas o provedor não cancelou o checkout que a anterior deixou aberto (só ID opaco e provedor) | nada urgente: se o checkout for pago, o fato acima segura o segundo trial; conferir a chave e a disponibilidade do Asaas se repetir |
| `billing_unclaimed_trial_settled` | um trial sem reserva (`trial_claim_missing`) foi liquidado: `reason` `cancelled` (assinatura cancelada no Asaas, nada cobrado) ou `left_paid` (a mesma assinatura já dá Pro e foi mantida); só IDs, nível aviso | conferir se a pessoa precisa ser avisada; o motivo fica no ledger (`unclaimed_trial_cancelled` ou `unclaimed_trial_left_paid`) |
| `billing_unclaimed_trial_settle_failed` | o cancelamento no Asaas falhou; o evento continua pendente e a próxima hora tenta de novo (a manutenção sai incompleta, `billing_unclaimed_trials_incomplete`) | conferir a chave e a disponibilidade do Asaas antes do 7º dia do checkout; se precisar, rodar `settle-unclaimed` do script do Gate 7 (só sandbox) ou, em produção, pedir ao responsável |
| `billing_unclaimed_trials_not_configured` | a manutenção não liquida trials sem reserva porque faltam os segredos do Asaas | gravar os segredos do ambiente |
| `billing_trial_setup_sweep_failed` | a varredura não devolveu a Free uma organização presa em `trial_setup` há mais de 2 horas | ver o erro pelo ID opaco; a próxima hora tenta de novo |
| `billing_checkout_discard_failed` | o checkout foi criado, a ligação à organização falhou e o descarte no Asaas também (só ID opaco e provedor) | nada urgente: o checkout expira em 60 minutos e um pagamento dele não acha organização |
| `billing_renewal_cancelled_at_closure` | o encerramento cancelou a renovação no Asaas (`reason` `cancelled` ou `already_cancelled`) e o fato `subscription_cancelled` foi gravado (ID do evento do outbox e ID opaco da organização) | nada: o acesso pago vai até o fim, sem reembolso (ADR 0074) |
| `billing_renewal_cancel_skipped` | o consumidor do pedido de cancelamento não fez nada: `nothing_owed` (sem provedor, sem Pro ou já cancelada) ou `not_handled` (provedor sem adaptador, nível aviso) | com `not_handled`, a pessoa cancela no provedor; o campo `renewal` do `organization.closedStatus` diz isso (a tela vem depois) |
| `billing_renewal_cancel_nothing_found` | o Asaas não mostra assinatura para a referência de uma organização encerrada cujo registro ainda diz renovação viva | reconciliar a organização (`reconcileOrganization`); a nova tentativa horária repete o pedido até o fato chegar |
| `billing_renewal_cancel_rearmed` | a manutenção horária reenviou (`rearmed`) ou criou (`inserted`) pedidos de cancelamento: organizações encerradas com a renovação ainda viva no Asaas uma hora ou mais depois do encerramento (um evento para de ser reenviado depois de 200 envios) |
| `billing_renewal_status_unavailable` | o painel da loja encerrada não leu o registro de billing; `renewal` vai `null` e o resto da leitura segue | ver [erros-de-banco](./alertas.md#erros-de-banco) e o binding `BILLING_HYPERDRIVE` | conferir a DLQ e o incidente `billing.renewal_cancel_requested`, a chave e a disponibilidade do Asaas; o encerramento nunca é desfeito por isso |

- **Ligação com a organização (S1.3):** o `externalReference` do checkout não passa para a assinatura; o `providerRef` do Asaas é o **ID do checkout** e a assinatura o traz em `checkoutSession`. A API não filtra por ele: a reconciliação lista as assinaturas da mais nova para a mais antiga e filtra no cliente (ADR 0101, seção 5). Evento cuja assinatura relida não traz `checkoutSession` fica `unresolved` e vira 503 nos primeiros 30 minutos.
- **Encerrar cancela a renovação (L4, [ADR 0074](../adr/0074-encerramento-de-organizacao.md)):** o encerramento grava `billing.renewal_cancel_requested` no outbox; o consumidor da fila crítica cancela no Asaas e grava `subscription_cancelled` (`command:cancel_renewal:<ID do evento>`). Uma falha do provedor vai à DLQ como incidente do tipo `billing.renewal_cancel_requested`, e a manutenção horária repete o pedido enquanto a renovação estiver viva: corrigir a causa basta, sem reenviar à mão. **Não reenvie pelo Admin um evento desse tipo de uma organização que voltou a ficar ativa** (encerramento desfeito): se ela assinou de novo depois do fim do acesso cancelado, o reenvio cancelaria a assinatura nova.

O corpo do webhook, o recurso relido e o link do checkout nunca vão para o log; os registros trazem só IDs e códigos.

## Gate 7 do cartão (script, só sandbox)

`apps/web/scripts/gate7-asaas.ts` roda os comandos de cobrança contra o **sandbox** do Asaas e um banco de **staging** (marcador `polaris.environment = 'staging'`) ou local sem marcador. Ele recusa chave que não comece com `$aact_hmlg_`, host que não seja `api-sandbox.asaas.com` URL de banco com qualquer parâmetro além de `sslmode` e `channel_binding` (antes de conectar), `DATABASE_URL` e `BILLING_DATABASE_URL` de bancos diferentes, e banco sem o marcador `staging` gravado (`ALTER DATABASE`) fora de `localhost` sem marcador. O link do checkout vai para um arquivo novo, criado antes do checkout, com permissão `0600`, fora do repositório (também pelo caminho real); nunca para o terminal, log, PR ou relatório.

```sh
set -a; . ~/.secrets/pagamentos-sandbox.env; set +a   # valores entre aspas simples no arquivo
export BILLING_DATABASE_URL=…  DATABASE_URL=…  BETTER_AUTH_BASE_URL=https://…
cd apps/web
bun run gate7:asaas checkout --organization <id> --user <id do dono> --cycle 1 --trial --link-file /tmp/gate7-link.txt
bun run gate7:asaas wait --organization <id> --until trialing --minutes 30   # o QA conclui o checkout no navegador
bun run gate7:asaas state --organization <id>
bun run gate7:asaas reconcile --organization <id>
bun run gate7:asaas refund --organization <id>
bun run gate7:asaas cancel --organization <id>
bun run gate7:asaas settle-unclaimed
```

- `checkout` autoriza como o RPC (membership e `billing:manage` na transação de tenant, preço de `billing_prices`) e segue a ordem trial → checkout → ligação → link. Sem `--trial`, a 1ª cobrança é hoje.
- `state` mostra só o estado, o fim do acesso, a marca de cancelamento e se há provedor e `sub_` ligados; nunca as referências.
- A saída é JSON de uma linha; um erro mostra só a classe e o código.
- Apague o arquivo do link depois do teste.

