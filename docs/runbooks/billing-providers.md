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

- **Ligação com a organização (S1.3):** o `externalReference` do checkout não passa para a assinatura; o `providerRef` do Asaas é o **ID do checkout** e a assinatura o traz em `checkoutSession`. A API não filtra por ele: a reconciliação lista as assinaturas da mais nova para a mais antiga e filtra no cliente (ADR 0101, seção 5). Evento cuja assinatura relida não traz `checkoutSession` fica `unresolved` e vira 503 nos primeiros 30 minutos.
O corpo do webhook, o recurso relido e o link do checkout nunca vão para o log; os registros trazem só IDs e códigos.
