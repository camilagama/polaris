# Avisos do encerramento por e-mail

**Gatilho:** a loja entra em encerramento e o dono precisa saber as datas, ou um aviso aparece como falho, pulado ou devido por tempo demais; ou o responsável vai ligar ou desligar o envio. Os sinais estão em [alertas](./alertas.md#aviso-de-encerramento-falhando) e a decisão, no [ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md) (emenda do PR E).

## O que é

A cada encerramento o dono recebe avisos em cinco marcos, todos tirados das datas: o pedido (`closure`), D menos 30 dias locais (`d30`), D menos 7 dias locais (`d7`, quando o apagamento é agendado), D (`deletion_day`) e o novo prazo de 7 dias quando uma trava legal solta depois do agendamento (`rescheduled`). D é o pedido mais 90 dias de calendário, no fuso da loja.

O e-mail leva só o nome da loja, as datas no fuso da organização e um link para a aplicação, que exige o login do dono. Não leva token na URL, nome da pessoa nem dado de negócio. O endereço é lido da conta do dono, só se estiver verificado, e nunca entra em log, erro ou evento. O evento da fila tem só o ID do aviso.

## Ligar o e-mail

Pré-requisitos:

- domínio de envio verificado no Resend;
- segredos `RESEND_API_KEY` e `AUTH_EMAIL_FROM`, que a autenticação já usa;
- `BETTER_AUTH_BASE_URL`, que monta o link;
- `AUTH_HYPERDRIVE`, pelo qual a função lê o endereço da conta (o papel de autenticação, não o de privacidade).

Passos:

1. Ligue primeiro em staging, com um endereço de teste. Nunca com um cliente real.
2. O responsável põe `CLOSURE_NOTICE_EMAIL_ENABLED` = `"true"` no Worker e faz o deploy. A flag fica `"false"` em todos os ambientes do `wrangler.jsonc` até ele decidir.
3. Na primeira hora, o repasse da varredura de privacidade envia o aviso devido mais recente de cada ciclo e grava os anteriores devidos como pulados. O dono não recebe avisos antigos em sequência.

Um aviso gravado nos últimos 15 minutos fica para o consumidor da fila, que tenta enviá-lo logo.

## Conferir

Workers Logs, no Worker `polaris-web`:

- `closure_notice_email_sent` (info): um envio aceito pelo provedor.
- `closure_notice_handover_complete` (info): a execução do repasse, com as contagens `handedOver`, `sent`, `failed`, `notVerified` e `retry`.
- `closure_notice_not_sent` (warn), com `reason` `email_not_configured` (falta segredo ou flag) ou `email_not_verified` (o dono não verificou o endereço).
- `closure_notice_email_failed` (error): ver o [alerta de falha](./alertas.md#aviso-de-encerramento-falhando).

Banco, só leitura, seguindo a [política de perfis de CLI](./cli-profile-policy.md). Estado dos avisos por marco, sem dado pessoal:

```sql
SELECT milestone,
       count(*) FILTER (WHERE sent_at IS NOT NULL) AS enviados,
       count(*) FILTER (WHERE failed_at IS NOT NULL) AS falhos,
       count(*) FILTER (WHERE skipped) AS pulados,
       count(*) FILTER (WHERE dismissed_at IS NOT NULL) AS dispensados,
       count(*) FILTER (WHERE NOT skipped AND sent_at IS NULL AND failed_at IS NULL AND dismissed_at IS NULL) AS devidos
FROM closure_notices
GROUP BY milestone
ORDER BY milestone;
```

Um `devidos` que não cai ao longo das horas, com o `closure_notice_handover_complete` sem `sent`, pede olhar a configuração antes de qualquer ato de suporte.

## Ato de suporte

O ato é do Admin, com a capacidade `organization:purge`, e só sob um caso de privacidade aberto da organização. Não há como editar um aviso: o ato grava uma linha nova (reemissão) ou marca a dispensa numa linha nova, e a auditoria registra cada um (`closure_notice.reissued` e `closure_notice.dismissed`).

**Reemitir** serve quando o aviso devido ou falho precisa sair de novo, depois que a causa foi corrigida. Chama-se a rota de reemissão do caso, com o identificador da organização no corpo. Cria um aviso `d7` novo do mesmo ciclo, para o dono atual, com `reissue` 1, 2 e assim por diante.

**Dispensar** serve quando o aviso não pode ser entregue, e o apagamento não pode esperar por ele. Chama-se a rota de dispensa do caso, com a organização e o motivo. O motivo é um destes:

- `owner_account_deleted`: o dono apagou a conta depois do aviso entregue. A linha do aviso sai com a conta.
- `email_not_verified`: o dono não verificou o endereço. O repasse continua tentando a cada hora, então o suporte pode esperar primeiro.
- `email_undeliverable`: o provedor recusou o endereço e o dono não o corrigiu.

A dispensa grava um `d7` sem usuário, marca como pulados os avisos do ciclo que ainda estavam devidos, e não gera evento. Um aviso dispensado conta como entregue: o apagamento ainda espera 7 dias depois da dispensa.

Casos:

- **`d7` pulado** (ficou atrás de um marco posterior que já estava vencido): reemitir.
- **`d7` falho** (endereço recusado): o dono corrige o endereço, e então reemitir. Se o endereço não puder ser corrigido, dispensar com `email_undeliverable`.
- **Conta do dono apagada**: dispensar com `owner_account_deleted`.
- **E-mail nunca verificado**: esperar a verificação, ou dispensar com `email_not_verified` depois da decisão do caso.

Recusas (todas com 409 e uma mensagem):

| Código | O que quer dizer | O que fazer |
| --- | --- | --- |
| `organization_mismatch` | o caso não é desta organização | confira o caso e a organização da chamada |
| `organization_not_in_closure` | a loja não está em encerramento | não há aviso a tratar |
| `closure_notice_not_due` | o marco do ciclo ainda não chegou | espere a data |
| `privacy_case_required` | não há caso de privacidade aberto da organização | abra o caso de privacidade primeiro |
| `privacy_case_not_decided` (dispensa) | o caso não tem decisão registrada | registre a decisão no caso, depois dispense |
| `closure_notice_pending` (reemissão) | outro aviso do ciclo ainda está devido | deixe o repasse enviá-lo, ou resolva esse aviso antes |
| `closure_notice_no_owner` (reemissão) | não há dono ativo | não há para quem reemitir; a decisão é do caso |
| `closure_notice_delivered` (dispensa) | um `d7` ou `rescheduled` do ciclo já foi entregue ou dispensado | nada a dispensar |

## Desligar

O responsável põe `CLOSURE_NOTICE_EMAIL_ENABLED` = `"false"` e faz o deploy. Os avisos devidos ficam devidos (não viram falhos), e nada é apagado: o apagamento espera um aviso entregue ou dispensado. Com o apagamento automático ligado, as lojas esperando caem em [loja-encerrada-parada](./alertas.md#loja-encerrada-parada). Ao religar, o repasse retoma sozinho.

## Limites

- A chave de idempotência do Resend é guardada por 24 horas. Um reenvio depois desse prazo é outro envio.
- Não há webhook de bounce. Uma recusa que chega depois de o provedor aceitar o envio não aparece, e o aviso conta como enviado.
- O link leva à raiz da aplicação, que exige login. A tela de encerramento depende do roteamento do PR G.
- A revisão do texto do e-mail está pendente (Petković).
- A revisão jurídica dos prazos segue a do [ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md).
