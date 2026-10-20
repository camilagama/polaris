# Avisos do encerramento por e-mail

**Gatilho:** a loja entra em encerramento e o dono precisa saber as datas, ou um aviso aparece como falho, pulado ou devido por tempo demais; ou o responsável vai ligar ou desligar o envio. Os sinais estão em [alertas](./alertas.md#aviso-de-encerramento-falhando) e a decisão, no [ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md) (emenda do PR E).

## O que é

A cada encerramento o dono recebe avisos em cinco marcos, todos tirados das datas: o pedido (`closure`), D menos 30 dias locais (`d30`), D menos 7 dias locais (`d7`, quando o apagamento é agendado), D (`deletion_day`) e o novo prazo de 7 dias quando uma trava legal solta depois do agendamento (`rescheduled`). D é o pedido mais 90 dias de calendário, no fuso da loja.

O e-mail leva só o nome da loja, as datas no fuso da organização e um link para a aplicação, que exige o login do dono. Não leva token na URL, nome da pessoa nem dado de negócio. O endereço é lido da conta do dono, só se estiver verificado, e nunca entra em log, erro ou evento. O evento da fila tem só o ID do aviso.

## Ligar o e-mail

Pré-requisitos:

- o PR G no ar: a tela da loja encerrada, com o pedido de cópia dos dados e o desfazer do encerramento. O e-mail manda o dono a essa tela; sem ela, não há onde pedir a cópia nem desfazer. Com ela, o link e o botão do e-mail passam a apontar para essa tela (só a rota, sem token), e só então a flag liga;
- domínio de envio verificado no Resend;
- segredos `RESEND_API_KEY` e `AUTH_EMAIL_FROM`, que a autenticação já usa;
- `BETTER_AUTH_BASE_URL`, que monta o link;
- `AUTH_HYPERDRIVE`, pelo qual a função lê o endereço da conta (o papel de autenticação, não o de privacidade).

Passos:

1. Ligue primeiro em staging, com um endereço de teste. Nunca com um cliente real.
2. O responsável põe `CLOSURE_NOTICE_EMAIL_ENABLED` = `"true"` no Worker e faz o deploy. A flag fica `"false"` em todos os ambientes do `wrangler.jsonc` até ele decidir.
3. Na primeira hora, o repasse da varredura de privacidade envia o aviso devido mais recente de cada ciclo e grava os anteriores devidos como pulados. O dono não recebe avisos antigos em sequência.

O repasse pega até 20 lojas por execução. Uma loja sem aviso devido a quem ainda é dono não entra (nada dela sairia; o caminho é reemitir). As lojas entram pela última vez em que uma tentativa achou o e-mail sem verificação: as nunca achadas assim vêm primeiro, e cada tentativa sem verificação manda a loja para o fim da fila. Assim, avisos que não podem sair agora revezam no fim do lote e não impedem os que podem. Um aviso que falha por um erro passageiro do provedor não muda de lugar; com o provedor fora do ar, todos esperam juntos.

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

**Reemitir** serve quando o `d7` foi pulado ou falhou, ou foi gravado para quem deixou de ser dono, e precisa sair de novo, depois que a causa foi corrigida. Chama-se a rota de reemissão do caso (`POST /support-cases/:caseId/closure-notice/reissue`), com o identificador da organização no corpo. Basta um caso de privacidade aberto da organização, em qualquer etapa. Cria um aviso `d7` novo do mesmo ciclo, para o dono atual, com `reissue` 1, 2 e assim por diante; um aviso ainda devido a quem deixou de ser dono fica pulado. Não reemite depois de um `d7` ou `rescheduled` já entregue ou dispensado: isso só adiaria o apagamento.

**Dispensar** serve quando o aviso não pode ser entregue, e o apagamento não pode esperar por ele. É uma decisão do responsável: exige um caso de privacidade de exclusão, pedido pelo dono da loja e aceito por inteiro (o pedido de um titular só serve com `owner_account_deleted`). Chama-se a rota de dispensa do caso (`POST /support-cases/:caseId/closure-notice/dismiss`), com a organização e o motivo. O motivo é um destes, e precisa bater com o que o banco sabe:

- `owner_account_deleted`: a conta do dono foi apagada (as linhas dos avisos dele saem com ela). Só vale sem dono ativo na loja.
- `email_not_verified`: o dono não verificou o endereço. O repasse continua tentando a cada hora, então o suporte pode esperar primeiro. Só vale quando uma tentativa de envio do `d7` achou o endereço do dono sem verificação (`unverified_at` no aviso): com o e-mail desligado não há tentativa, e a dispensa por esse motivo é recusada. E só vale se o e-mail continua sem verificação na hora da dispensa: o banco confere a conta do dono nesse momento (só se está verificada, sem ler o endereço). Se o dono verificou depois da tentativa, a dispensa é recusada: o aviso continua devido, e o repasse o envia.
- `email_undeliverable`: o provedor recusou o endereço (`email_rejected`) e o dono não o corrigiu. Só vale com um `d7` do ciclo recusado para quem ainda é dono e nenhum aviso ainda devido a um dono.

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
| `privacy_case_not_deletion` (dispensa) | o caso não é um pedido de exclusão | use o caso de exclusão do dono |
| `privacy_requester_not_owner` (dispensa) | o pedido não foi feito pelo dono | use o caso de exclusão do dono |
| `privacy_case_not_accepted` (dispensa) | o pedido ainda não foi decidido ou não foi aceito por inteiro | registre a decisão no caso, depois dispense |
| `closure_notice_owner_present` (dispensa) | ainda há dono ativo, então a conta não foi apagada | reemita, ou use o motivo que corresponde |
| `closure_notice_not_refused` (dispensa) | nenhum `d7` do ciclo foi recusado pelo provedor para o dono atual, ou ainda há um devido | reemita antes |
| `closure_notice_not_unverified` (dispensa) | nenhuma tentativa de envio do `d7` achou o endereço sem verificação | ligue o e-mail e espere o repasse |
| `closure_notice_owner_verified` (dispensa) | o dono verificou o e-mail depois da tentativa que o achou sem verificação | não dispense: o aviso segue devido e o repasse o envia |
| `closure_notice_pending` (reemissão) | outro aviso do ciclo ainda está devido | deixe o repasse enviá-lo, ou resolva esse aviso antes |
| `closure_notice_no_owner` (reemissão) | não há dono ativo | não há para quem reemitir; a decisão é do caso |
| `closure_notice_delivered` | um `d7` ou `rescheduled` do ciclo já foi entregue ou dispensado | nada a reemitir nem dispensar |

## Desligar

O responsável põe `CLOSURE_NOTICE_EMAIL_ENABLED` = `"false"` e faz o deploy. Os avisos devidos ficam devidos (não viram falhos), e nada é apagado: o apagamento espera um aviso entregue ou dispensado. Com o apagamento automático ligado, as lojas esperando caem em [loja-encerrada-parada](./alertas.md#loja-encerrada-parada). Ao religar, o repasse retoma sozinho.

## Limites

- A chave de idempotência do Resend vale 24 horas. Um reenvio depois desse prazo é outro envio e pode duplicar o e-mail: se o provedor aceitou e a marca de enviado falhou, o repasse do dia seguinte pode mandar o mesmo aviso de novo. Dentro das 24 horas, a mesma chave com outro conteúdo (por exemplo, depois de um deploy que mudou o texto) responde 409 e é tentada de novo até a chave vencer.
- Só a resposta 400 ou 422 com `validation_error` sobre o campo `to` dá o aviso por falho (`email_rejected`). Um `validation_error` sobre outro campo (o `reply_to`, por exemplo), um remetente errado (`invalid_from_address`), uma chave errada ou uma cota estourada fazem o aviso ser tentado de novo e acendem [aviso-de-encerramento-falhando](./alertas.md#aviso-de-encerramento-falhando): corrija a configuração, e o repasse envia. Antes de ligar em produção, faça um envio de teste no staging.
- Não há webhook de bounce. Uma recusa que chega depois de o provedor aceitar o envio não aparece, e o aviso conta como enviado.
- O link leva à raiz da aplicação, que exige login. A tela de encerramento depende do roteamento do PR G, e por isso a flag só liga com ele no ar (ver [Ligar o e-mail](#ligar-o-e-mail)).
- O texto é fixo por aviso (a mesma chave de idempotência sempre manda a mesma mensagem), escrito pela data do marco, não pela hora do envio. Um aviso do pedido, de D − 30 ou de D − 7 enviado depois de D (o e-mail ligado tarde, ou a fila atrasada) ainda diz "peça até D" e "faltam 30 (ou 7) dias".
- O texto do pedido de cópia segue o limite do servidor: até a meia-noite que abre D, no fuso da organização (`request_closed_export` recusa a partir desse instante). O pedido, D − 30 e o `d7` do job escrevem esse limite. D, o `d7` reemitido e o `rescheduled` não afirmam que o prazo terminou: pedem que o dono peça a cópia agora.
- A revisão jurídica dos prazos segue a do [ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md).
