---
status: accepted
---

# Reembolso e chargeback da assinatura

## Contexto

O plano (PR84) pede: reembolso integral remove o Pro; chargeback remove o Pro imediatamente, sem carência e sem nova lease offline; e "testar reversão posterior". O ADR 0062 deixou o estorno de fora (limite aceito): um pagamento estornado mantinha o Pro até o fim do período. O reembolso parcial é um gesto comercial que "pode manter o entitlement".

## Decisão

- **Três fatos novos, todos nomeando o período que concerne** (`periodEndsAt`, o fim do período que o pagamento cobriu, sem dado pessoal): `charge_refunded` (reembolso **integral**; um reembolso parcial não é fato, o adaptador não o reporta), `charge_disputed` (chargeback) e `dispute_reversed` (chargeback decidido a favor do Polaris).
- **O período do fato é o que vale, com a tolerância do provedor.** Dois fins de período a menos de um dia um do outro são o mesmo período (provedores arredondam de um evento para outro). Um fim de período que nenhum provedor reportaria (já passado quando não há o que remover, ou além do maior período pago, 400 dias) é ignorado.
- **Efeito imediato e sem carência.** Um reembolso ou chargeback do período pago em vigor (`active`, ou `grace`, que se apoia no período que acabou) leva ao novo evento da máquina de estados, `access_revoked`: `free`, ou `free_over_limit` se a organização passa do limite Free (e então valem a janela e a escolha do ADR 0064). Como o entitlement é derivado do estado, o lease offline e as demais capacidades Pro somem com ele: nenhum lease novo é emitido e um comando que chega depois é rejeitado sem perder a fila (ADR 0058). Um fato de período **anterior** ao em vigor (uma renovação já o superou) não muda nada.
- **O pagamento tirado fica registrado** em `organization_billing` (`revoked_through`, `revoked_reason`, `revoked_cycle_months`, `revoked_cancel_at_period_end`, todos ou nenhum). Um pagamento tirado (reembolso ou chargeback) **nunca fica guardado sobre um período pago**; o `won` (abaixo) é a única memória que pode ficar, e fica sem ciclo nem cancelamento. Serve a três coisas: a **confirmação tardia do mesmo pagamento** (`charge_succeeded` de período igual ou anterior) nunca revive o acesso; um pagamento de período novo o revive e apaga o registro de reembolso ou chargeback (um `won` é mantido: concerne a um período e não atrapalha outro); e a **reversão** sabe o que restaurar (fim do período, ciclo e se estava cancelada). Uma nova referência de assinatura no provedor (`attachProvider`, um checkout novo) apaga o registro: o pagamento tirado na assinatura antiga não acompanha a nova.
- **Fato que chega antes da cobrança.** Um reembolso ou chargeback de um período ainda não pago no registro (um registro Free, um trial em andamento ou em preparação: a confirmação da cobrança vem depois) também é **registrado**, sem mudar o estado (um trial segue rodando), para que a confirmação, quando chegar, não conceda o que já foi devolvido; um pagamento de período posterior é outra cobrança e passa.
- **Reembolso vence chargeback.** Um reembolso do mesmo pagamento depois do chargeback troca o motivo do registro para reembolso: a reversão do chargeback não restaura nada (o cliente tem o dinheiro e não terá o acesso). Um chargeback depois de um reembolso não acrescenta nada.
- **Ciclo desconhecido não é inventado.** Um chargeback que chega antes da cobrança guarda o ciclo como desconhecido; a confirmação da cobrança, recusada por causa dele, **informa o ciclo** (só o registro muda) e é isso que permite restaurar com o ciclo certo. Se o ciclo nunca foi conhecido, a reversão **não restaura** (só esquece o chargeback): a confirmação da cobrança, se ainda vier, concede com o ciclo dela.
- **Reversão restaura, de forma auditável.** `dispute_reversed` para o chargeback registrado, do mesmo período, restaura o acesso até o fim daquele período, com o ciclo e o cancelamento que a assinatura tinha, pela transição de pagamento (`subscribe`, ou `payment_succeeded` se um trial corre); o razão mostra o estado antes e depois. Se o período já terminou, não há o que restaurar: o registro só esquece o chargeback. Depois de restaurado, o tempo corre como em qualquer assinatura (sem pagamento no fim, entra em carência).
- **Reversão que chega antes do chargeback** (fora de ordem) é registrada como `won` **em qualquer estado**, inclusive com a assinatura ativa ou em carência (a constraint do banco aceita `won`, e só ele, sobre um período pago; a migration 0056 a ajustou depois de a revisão pós-merge do PR #98 achar que o caso normal, assinatura ativa, caía em "ignorado"): o acesso não é tocado, e o chargeback que chega depois não muda nada. Vale para um período ainda à frente e, para um registro num período pago (`active` ou `grace`), também para um que terminou há menos de sete dias (a carência, ou a carência que a varredura ainda vai abrir, se apoia nele); um registro sem período pago só lembra períodos à frente. Um `won` não bloqueia um pagamento real nem uma renovação e é mantido; um reembolso do mesmo período depois dele ainda tira o acesso (o dinheiro foi devolvido). A mesma reversão entregue de novo depois de uma restauração não se distingue de uma que ultrapassou o chargeback: também é lembrada, sem efeito.
- **Fatos de dinheiro nunca são descartados por velhice.** Como o `charge_succeeded`, os três escapam da regra "fato mais antigo que o último aplicado é obsoleto": um reembolso entregue atrás de uma notícia mais nova continua tirando o acesso. O que os protege é o período que nomeiam.
- **Sem estado novo e sem tabela nova.** Os três fatos entram pela mesma caixa de entrada, deduplicados por provedor e ID de evento; as colunas novas são do papel de billing (UPDATE só dele).

## Consequências

- Um adaptador (PR77 e PR78) reduz o reembolso integral, a disputa e a vitória da disputa do seu provedor a esses fatos, informando o fim do período cobrado pelo pagamento em questão; reembolso parcial vira lista vazia. Os fatos devem trazer a referência da assinatura, e o armazenamento a confere: reembolso, chargeback e reversão sem referência, com a referência de outra assinatura (ou ligada a outra organização) ficam registrados como ignorados (`reference_mismatch`), sem efeito; para um registro sem assinatura ligada o fato espera a ligação (falha com `unknown_organization` e o reprocessamento o aplica depois). O [ADR 0087](0087-referencia-do-provedor-em-todos-os-fatos-de-cobranca.md) estende a mesma exigência a todos os fatos e torna o que não confere um incidente operacional.
- A restauração depende de o chargeback ter sido registrado e de a reversão nomear o mesmo período.
- Cada saída do Pro por reembolso ou chargeback começa uma nova janela de adequação (ADR 0064), datada do momento da retirada do acesso.

## Limites aceitos

- Reembolso de uma renovação paga **antes** do fim do período em vigor, entregue antes da confirmação da cobrança, é ignorado (o registro está num período pago e não pode guardá-lo): a confirmação, quando chegar, concede o período. Aceito porque um adaptador só deve reportar o reembolso depois de a cobrança existir.
- Reembolso de um período **anterior** ao em vigor não remove nada, mesmo que o cliente tenha pedido o dinheiro de volta de uma renovação antiga: a assinatura segue paga pelo período novo.
- Um chargeback que atinge o pagamento de uma carência (`grace`) guarda o período que acabou: uma vitória posterior só esquece o registro; não devolve a carência.
- Não há reembolso proporcional nem crédito: é tudo ou nada.
- Um `won` permanece na linha depois do fim do período (inofensivo: só bloqueia um chargeback daquele período exato) até outro registro tomar o lugar.
- **Só um período fica lembrado por vez** (uma coluna de memória por organização): dois chargebacks de períodos diferentes em disputa ao mesmo tempo não cabem; vale o de período posterior, e um `won` não desloca outro de período posterior.
- O que o banco garante e o que só o domínio garante: a CHECK recusa memória de reembolso ou chargeback sobre um período pago e exige que um `won` não traga ciclo nem cancelamento (migration 0058); que o período lembrado seja razoável (à frente, ou terminado há menos de sete dias para quem está num período pago) é regra do domínio.

## Alternativas rejeitadas

- **Encerrar a assinatura inteira a cada reembolso:** reembolsar uma renovação antiga derrubaria um período que continua pago.
- **Chargeback com carência:** o plano o quer imediato e mais severo que a falha de renovação.
- **Restaurar a partir do evento do provedor sem lembrar o ciclo:** a restauração voltaria com um ciclo que não era o da assinatura, e sem o cancelamento.
- **Tratar o fato como obsoleto quando chega atrás de outro:** um reembolso atrasado deixaria o Pro de quem recebeu o dinheiro de volta.
- **Exigir igualdade exata do fim do período:** um arredondamento diferente do provedor reviveria o acesso de um pagamento devolvido ou ignoraria uma reversão legítima.

## Emenda de 23/10/2026: reembolso e chargeback também cancelam a renovação

**Contexto.** No sandbox do Asaas (23/10, desenho t268), reembolsar a cobrança confirmada deixou a assinatura `ACTIVE`; com o vencimento movido para hoje, o Asaas criou uma cobrança nova no cartão guardado. Na Woovi, `POST /api/v1/refund` devolve um Pix e não toca a recorrência. A cobrança seguinte, quando confirmada, é "um pagamento de período novo" e devolveria o Pro (decisão acima), cobrando de novo quem pediu o dinheiro de volta.

**Decisão.**
- **Reembolsar é desistir: o comando de reembolso cancela a renovação antes de reembolsar.** Passo 1: cancelar no provedor e gravar `subscription_cancelled` pela caixa de entrada, com o ID `command:refund_cancel:<requestId>:<digest da referência>` (prefixo próprio, para não ser lido como o cancelamento pedido pelo dono). Passo 2: o reembolso. Um cancelamento que falha não reembolsa nada; um reembolso que falha depois dele deixa "Pro até o fim do período", e repetir o pedido termina o reembolso. Na ordem inversa, uma falha deixaria a loja sem Pro e com a renovação viva.
- **Decide pelo estado, sob a trava da loja.** O comando roda com a trava de comandos da loja (`withOrganizationLock`, `pg_try_advisory_xact_lock` sem fila: ocupada, responde `command_in_progress` na hora, sem nada feito) e lê o registro: se `cancel_at_period_end` já é verdadeiro (o dono, um pedido anterior cujo reembolso falhou, o encerramento), pula o passo 1. Repetir com outro `requestId` não grava um segundo cancelamento. Por ora só o reembolso pega a trava; os comandos de cancelar e o consumidor do encerramento não (um segundo `subscription_cancelled` é ignorado pelo registro), e os comandos do dono passam a pegá-la quando entrarem. O webhook e a manutenção nunca a pegam: a caixa de entrada já ordena os fatos.
- **Um provedor que não pode reembolsar ali não cancela nada.** A porta diz se reembolsa (`refundsEnabled`); na Woovi, enquanto `WOOVI_REFUND_ENABLED` estiver desligada, o comando responde `billing_provider_not_configured` antes do passo 1, e a renovação fica como estava.
- **Com o registro fora do Pro** (o reembolso já tirou o acesso), o passo 1 ainda chama o provedor, para não deixar viva uma assinatura que cobraria, mas não grava fato: o registro não guarda cancelamento fora do Pro e o ignoraria.
- **Chargeback:** não nasce de comando nosso, então não há passo 1 a fazer antes. A renovação de quem contestou é cancelada pela rede de segurança horária (abaixo).
- **Rede de segurança (PR seguinte, com limite por passada e recuo por loja):** a manutenção cancela a renovação de lojas com `revoked_reason` `refund` ou `chargeback` (nunca `won`: o lojista venceu a disputa), vínculo ainda vivo e renovação não cancelada, só no vínculo atual (uma nova assinatura zera os `revoked_*` e não é tocada). Até ela entrar, o operador cancela pelo comando `cancel` do Gate 7.

**Consequências.**
- O reembolso pelo comando do operador (Gate 7) e, depois, o arrependimento do dono têm o mesmo caminho; a resposta não muda (`refund_requested`, `nothing_to_refund`, `not_linked`).
- Pedir o reembolso cancela a renovação mesmo quando o provedor não acha cobrança a devolver: o pedido é de desistência. O comando do dono só chega ao passo 1 com a janela do arrependimento aberta.
- A prova no Gate 7 é a do QA: depois do reembolso, `GET` da assinatura com `deleted: true`, nenhuma cobrança `PENDING` não apagada, uma varredura horária sem fato novo e a mesma contagem em `billing_events`; o controle negativo é o reembolso sem cancelar, que gera a cobrança nova.

**Limites aceitos.**
- O reembolso depois do cancelamento na Woovi não foi provado (S3.2); por isso o comando segue desligado nela.
- A trava segura uma conexão do papel de billing (pool de 3) enquanto o provedor responde, como a do pagador (ADR 0101). Com o comando só no Gate 7, há um por vez; antes de o dono chamar o reembolso, limitar quantas travas ficam abertas por pool.
- A transação da trava termina se ficar 60 s ociosa. Cancelar e reembolsar no Asaas faz até 6 a 8 chamadas de até 8 s: num provedor lento, a trava cai no meio do comando e o `COMMIT` falha com o trabalho feito. Os fatos são idempotentes pelo ID e repetir é seguro.
