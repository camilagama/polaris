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
| `billing_trial_fact_without_claim` | um checkout pago começaria o trial de uma organização que não tem a reserva de ninguém (a pessoa levou o teste para outra loja, ou optou antes do teste por pessoa); o evento fica `unresolved` com `trial_claim_missing` em `billing_events`, a organização continua sem trial e o reprocesso horário o relê (aviso; erro na última tentativa, só IDs opacos) | localizar no Admin a organização pelo ID opaco e, no painel do Asaas, a assinatura pelo `provider_subscription_id` guardado; até a reconciliação (PR 3) decidir, não cancelar nem cobrar à mão sem o responsável |
| `billing_trial_checkout_discard_failed` | a reserva do teste mudou de loja, mas o provedor não cancelou o checkout que a anterior deixou aberto (só ID opaco e provedor) | nada urgente: se o checkout for pago, o fato acima segura o segundo trial; conferir a chave e a disponibilidade do Asaas se repetir |

- **Ligação com a organização (S1.3):** o `externalReference` do checkout não passa para a assinatura; o `providerRef` do Asaas é o **ID do checkout** e a assinatura o traz em `checkoutSession`. A API não filtra por ele: a reconciliação lista as assinaturas da mais nova para a mais antiga e filtra no cliente (ADR 0101, seção 5). Evento cuja assinatura relida não traz `checkoutSession` fica `unresolved` e vira 503 nos primeiros 30 minutos.
O corpo do webhook, o recurso relido e o link do checkout nunca vão para o log; os registros trazem só IDs e códigos.

## Woovi (Pix Automático)

| Nome no Worker `polaris-web` | Tipo | Staging | Produção |
|---|---|---|---|
| `WOOVI_APP_ID` | secret | AppID do sandbox | AppID de produção |
| `WOOVI_BASE_URL` | var | `https://api.woovi-sandbox.com` | `https://api.woovi.com` |
| `WOOVI_WEBHOOK_PUBLIC_KEYS` | var (pública) | chave pública da Woovi | a mesma chave (a Woovi usa uma chave só para todos os webhooks) |

- **Trava de ambiente:** o cliente só fala com os dois hosts acima, por HTTPS e sem caminho. O AppID da Woovi **não diz** de que ambiente é (diferente do prefixo do Asaas), então a trava é só o host: nunca grave o AppID de produção no staging nem o contrário. Sem `WOOVI_APP_ID`, `WOOVI_BASE_URL` ou `WOOVI_WEBHOOK_PUBLIC_KEYS`, ou com chave ilegível, a rota responde 503 `billing_provider_not_configured`, nunca 200.
- **Chave pública:** leia em `GET https://api.woovi.com/api/v1/webhook/public-keys` (sem autenticação; o sandbox responde a mesma em `api.woovi-sandbox.com`), copie o campo `key` e grave em `WOOVI_WEBHOOK_PUBLIC_KEYS` só o conteúdo entre `-----BEGIN PUBLIC KEY-----` e `-----END PUBLIC KEY-----`, sem quebras de linha (PEM inteiro também é aceito). Confira o `key_identifier` (SHA-256 do DER) com o da resposta. O Worker **não busca** a chave em tempo de execução.
- **Conferência de ambiente (à mão, a cada configuração ou rotação):** no staging, `WOOVI_BASE_URL` é `https://api.woovi-sandbox.com` e o AppID é o do sandbox; o `https://api.woovi.com` e o AppID de produção só no Worker de produção. Nenhum script confere isso hoje.
- **Limite de taxa:** antes da cobrança real, criar no Cloudflare uma regra de limite por IP no caminho `/webhooks/billing/woovi` (a chave de assinatura é comum a todas as contas Woovi; um corpo assinado de outra conta, reenviado em volume, gasta leituras na API e enche o log de erro).
- **Registrar o webhook** no painel da Woovi (API/Plugins, Novo webhook): URL `https://<domínio>/webhooks/billing/woovi`, eventos `PIX_AUTOMATIC_APPROVED`, `PIX_AUTOMATIC_REJECTED`, `PIX_AUTOMATIC_COBR_COMPLETED` e `PIX_AUTOMATIC_COBR_REJECTED`. O segredo HMAC do webhook não é usado (o Polaris confere só `x-webhook-signature`). Se o painel mandar uma entrega de teste no cadastro, ela é respondida com 401 (sem assinatura válida) ou 200 sem fato (assinada, mas sem evento conhecido); confira no Gate 7 qual dos dois acontece.

### Rotação

- **AppID:** crie o novo no painel, grave em `WOOVI_APP_ID`, implante, confira que uma entrega responde 200 e apague o antigo. AppID recusado aparece como `billing_provider_rejected` (401 ou 403) e a rota responde 503.
- **Chave pública da Woovi:** quando a Woovi publicar a nova chave (a lista passa a ter duas), grave as duas em `WOOVI_WEBHOOK_PUBLIC_KEYS`, separadas por vírgula, e implante; quando a antiga sair da lista, deixe só a nova.

### O que os registros dizem (Woovi)

| Evento no log | Significado | Ação |
|---|---|---|
| `billing_webhook_rejected` | assinatura ausente ou inválida (401) | conferir a chave fixada; repetido sem motivo é tentativa de terceiro |
| `billing_webhook_unresolved_given_up` | assinatura válida, mas a releitura não achou o recurso (200, nível erro, só IDs; o `resourceId` vem decodificado, `PaymentSubscription:<24 hex>`) | em geral é entrega de outra conta Woovi; se for desta conta, reconciliar a organização |
| `billing_provider_response_malformed` | a API respondeu fora da forma documentada (200) | ver se a Woovi mudou o formato; reconciliar |
| `billing_provider_rejected` | o AppID foi recusado (503) | rotação fora de ordem ou AppID revogado |
| `billing_webhook_fact_event_malformed` | entrega assinada de um evento que daria fato (`eventType` no log), mas sem `globalID` válido onde a documentação diz (200) | a Woovi pode ter mudado o formato: comparar com a entrega no painel e reconciliar |

O corpo do webhook, o recurso relido, o `emv` e o link de pagamento nunca vão para o log. A troca de ciclo no Pix Automático exige nova autorização do pagador (cancelar e criar outra assinatura), e a contestação (MED) não gera fato na V1 (ADR 0101, emenda Woovi).
