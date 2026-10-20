---
status: proposto
---

# Apagamento automático da loja encerrada, sem caso de privacidade

> O número deste ADR (0102) é o próximo livre na `main` e nos PRs abertos no momento da escrita (o 0101 é o último na `main` e o 0099 está reservado ao backup); pode mudar se outro entrar antes. A migration é a 0087 (`0087_apagamento_automatico.sql`), também provisória.

## Contexto

O purge da organização encerrada ([ADR 0081](0081-purge-completo-da-organizacao-encerrada.md)) só começava por ato de um operador do Admin, amparado num caso de privacidade de exclusão aceito do dono. O registro de retenção deixava `closed_organization` em `proposta` e nenhum job agendava o purge. O corte do modo somente leitura (decisão L2) e o desenho t107 (§3 e §4, com a consolidação de 19/10/2026 21:25, revisado por Filipe Luís, Rodrigo Caio e Diego Alves) pedem o contrário: o lojista que encerra a loja sabe, pela tela, pelos termos e pelo e-mail, que os dados são apagados **a partir de D**, e isso precisa acontecer sem que alguém se lembre de abrir um caso.

D é a data local do pedido de encerramento mais 90 dias de calendário, no fuso da organização, a partir do primeiro instante desse dia local (`closureDeadlines` no domínio e `closure_deadlines` no banco, a mesma regra, comparadas por gate). O dono pode pedir a cópia até D ([ADR 0078](0078-exportacao-de-dados-da-organizacao.md), emendado em 19/10/2026).

## Decisão

1. **A regra.** O purge da organização encerrada pelo dono é agendado sozinho, sem caso de privacidade: 90 dias de calendário depois do encerramento, sem legal hold. A base é o fim do tratamento (LGPD, arts. 15 e 16): o Polaris é operador desses dados e a obrigação fiscal de guardá-los é do lojista, que tem a exportação. A classe `closed_organization` passa a `aprovada` no registro de retenção, com o período `closure_calendar_days` de 90 dias e o job `privacy.closure_purge_schedule` declarado (aprovação do usuário de 19/10/2026, `retencao-aprovada-2026-10-19.md`). O caminho do Admin com caso de privacidade continua, para as exceções.
2. **Quem agenda e quando.** A varredura horária de privacidade (`privacy.maintenance`) chama `schedule_closed_organization_purges(p_limit)` depois de fechar as janelas de recuperação vencidas, em lotes de 100 e no máximo 10 por execução. A função escolhe as organizações `closed` cuja janela de recuperação acabou e cujo **D menos 7 dias locais** chegou (o pedido mais 83 dias de calendário), as mais antigas primeiro. Trava a linha da organização (`FOR UPDATE SKIP LOCKED`, o mesmo lock do agendamento do Admin, da trava legal e do purge), confere tudo de novo sob o lock, passa a organização a `purge_pending` e grava `organization_purges` com `trigger = 'closure_period'`. Uma organização já agendada não está mais `closed`, então duas execuções ao mesmo tempo, ou uma repetida, agendam uma vez só.
3. **A data mínima.** `not_before` é o maior entre **D mais 48 horas** e **o agendamento mais 7 dias** (`closurePurgeNotBefore` no domínio; no banco, `interval '48 hours'` e `interval '168 hours'`, em horas para que o fuso da sessão não mude a conta). Com a varredura em dia, são 9 dias entre agendar e executar e o purge só roda dois dias depois de D, quando o aviso do dia já saiu e o prazo de pedir a cópia (D) já passou. Com a varredura atrasada, o lojista ainda tem 7 dias de aviso. O bloqueio do purge (`organization_purge_blocker`) continua exigindo o pedido mais 90 dias, que vem antes de D mais 48 horas.
4. **O que faz esperar.** A organização não é agendada (`closed_organization_purge_wait`) enquanto houver:
   - legal hold vigente;
   - acesso temporário do Admin vigente;
   - um cancelamento de purge pelo Admin **posterior ao pedido deste encerramento**. O cancelamento pausa o caminho automático da loja, e quem cancelou decide o próximo passo (pôr uma trava ou agendar de novo pelo Admin). Um cancelamento de um ciclo anterior (antes de desfazer e encerrar de novo) não conta;
   - a renovação ainda viva no provedor: provedor e referência ligados, um estado que dá Pro (`trialing`, `active` ou `grace`) e o cancelamento no fim do período não registrado. É o `renewalAlive` do domínio, com **qualquer** provedor ligado, e o gate `purge-functions` compara os estados. O Admin espera menos: o seu `renewalBlocksPurge` só olha os provedores com porta de saída (hoje o Asaas), porque o `paid_access_running` já segura o resto. No caminho automático, uma renovação viva num provedor sem porta (a Woovi, até a porta dela entrar) deixa a loja `closed` até a pessoa cancelar no provedor, e o alerta de loja parada a mostra. O acesso pago que só falta acabar (renovação já cancelada, ou sem provedor) **não** faz esperar: a loja não pode ser usada e não há reembolso (pergunta F1 do desenho, aceita). No caminho automático isso substitui o `paid_access_running` do Admin, que continua igual.
5. **Trava solta depois do agendamento (AC-61).** O purge não segue sozinho. `admin_release_organization_legal_hold` empurra o `not_before` de um purge do período (`trigger = 'closure_period'`, ainda não executado) para o maior entre o valor atual e **a soltura mais 7 dias**, na mesma transação da soltura. Nunca antecipa. O aviso novo de 7 dias ao dono é do PR dos avisos (marco `rescheduled`). Um purge agendado pelo Admin segue como antes: quem solta a trava decide.
6. **Freio e alerta.** O Worker só chama a função com `CLOSURE_AUTO_PURGE_ENABLED` igual a `true` (texto exato). A chave está desligada em todos os ambientes do `wrangler.jsonc`, e um teste confere isso. Liga-se em produção só no go-live (N1 do corte), depois da prova de fiação em staging. Desligada, a loja segue `closed`, o painel segue com "a partir de D" e o caminho do Admin continua valendo. A função devolve também quantas lojas o período agendou nas últimas 24 horas; acima de 5, o job emite `closure_auto_purge_volume_high`, sinal `apagamento-automatico` do [runbook de alertas](../runbooks/alertas.md) (crítico). Devolve também quantas lojas continuam `closed` 30 dias depois de D sem trava legal (um cancelamento do Admin, uma renovação viva ou um acesso temporário as segura): acima de zero, o job emite `closure_purge_overdue`, sinal `loja-encerrada-parada` (aviso no resumo diário). As duas contagens só existem com a chave ligada (T17 do corte), porque desligada nenhuma loja seria apagada sozinha.
7. **Banco (migration 0087, só expand, [ADR 0096](0096-migrations-compativeis-com-a-versao-anterior-do-worker.md)):**
   - `organization_purges.trigger` (`admin` por padrão, ou `closure_period`). `scheduled_by`, `support_case_id` e `privacy_case_id` passam a aceitar nulo, com um CHECK de coerência: no Admin, os três preenchidos; no período, os três nulos.
   - `platform_audit_events.actor` (`principal` por padrão, ou `system`) e `principal_id` anulável. Um CHECK exige o principal para `principal` e, para `system`, nem principal nem caso, e só nos tipos `organization.purge_scheduled` e `organization.purge_completed`. O agendamento e a conclusão do purge do período são auditados como do sistema, só com IDs.
   - As duas funções novas são do `polaris_purge_owner`, e só o `polaris_privacy_runtime` executa o agendamento. A função de espera é interna. Nenhuma recebe organização como argumento. O papel do purge ganha leitura só do que a decisão 4 precisa (organizações `closed` e o fuso, o encerramento, o acesso temporário, a data dos cancelamentos e cinco colunas da cobrança, cada política só para organização `closed`), o `INSERT` de um purge do período (política) e a passagem de `closed` a `purge_pending`.
   - As duas políticas de `UPDATE` em `organizations` somadas deixariam o papel levar uma loja `closed` direto a `purged`, ou renomear uma que espera. O gatilho `organizations_purge_owner_transition`, só para esse papel, admite exatamente os dois movimentos: `closed` para `purge_pending` sem outra mudança, e `purge_pending` para `purged`.
   - Funções recriadas com a mesma assinatura, dono e permissões:
     - `purge_organization_data`: audita a conclusão do sistema e recusa pelo nome uma organização que não está `purge_pending`, agora que o papel vê as `closed`;
     - `admin_schedule_organization_purge`: agendar de novo sobre uma linha do período a devolve ao Admin;
     - `admin_release_organization_legal_hold`: a decisão 5.

     O gate `purge-functions` passa a conferir também as duas funções novas.
   - A lápide do deletion ledger já aceitava `privacy_case_id` nulo. O restore reaplica o purge do período como o do Admin (o [runbook](../runbooks/deletion-ledger-restore.md) diz como).
8. **Trava legal e o que o lojista vê (T7, AC-29).** Com trava, o purge não é agendado nem executado, e o painel mostra as mesmas datas e textos de uma loja sem trava. As fases e as datas vêm só das datas do encerramento.

## Consequências

- Uma loja encerrada chega a `purged` sem ato de operador, a partir de D mais 48 horas, quando o freio estiver ligado. O Admin continua podendo cancelar (até a primeira exclusão no armazenamento), pôr trava ou agendar pelo caso de privacidade.
- A auditoria do Admin passa a ter eventos sem principal. As telas de caso do Admin filtram por caso, e um evento do sistema nunca tem caso (CHECK), então elas não os listam. O gate prova a lista de um caso de uma organização com purge automático (risco R4 do desenho).
- O `privacy.maintenance` passa a ser um job de expurgo de uma classe aprovada (`privacy.closure_purge_schedule`, no registro de jobs).
- A prova em staging (T-123c e Gate de go-live, V7 do Diego) usa datas retroagidas: num staging sem dado real, o operador recua `requested_at`, `recover_until` e `closed_at` de uma loja sintética encerrada, liga o freio só no staging e vê a varredura agendar e, depois de recuar também o `not_before`, executar. O mecanismo está descrito no PR desta mudança; não há script versionado.

## Limites e pendências

- **Avisos.** Os marcos (D − 30, D − 7, D e o reagendamento depois da trava) e o e-mail são dos PRs D e E. Até lá o painel mostra as datas e nenhum e-mail sai.
- **Reconferência só no agendamento.** O acesso temporário do Admin e a renovação viva são conferidos ao agendar, não na execução (9 dias depois, no mínimo), que confere a trava, os 90 dias e a exportação em andamento. Um acesso concedido depois do agendamento não segura o purge, como no caminho do Admin (limite aceito do ADR 0081); `admin_grant_tenant_access` não toma o lock da organização. Uma renovação que volte a ficar viva depois do cancelamento é regressão do provedor, e o purge não espera por ela.
- **O fuso é de cada organização.** A varredura lê `closure_deadlines` com o fuso de cada loja; um fuso que a base deixasse de reconhecer (mudança do tzdata) derrubaria a varredura inteira, e não só aquela loja. O fuso é validado na criação e não muda.
- **Plano anual pago (R7).** Encerrado no começo do período, o purge sai com o acesso pago ainda vigente, sem reembolso (decisão B8).
- **Freio.** Desligar a chave para só os agendamentos novos: um purge já agendado segue até o `not_before`. Para parar um agendado, o Admin cancela. A chave controla o Worker, não o banco: quem tem a conexão do papel de privacidade executa a função com ela desligada. Também não há teto diário na função: o alerta de volume avisa depois do agendamento, e o freio real são os 7 dias até a execução.
- **Co-donos.** O agendamento é por organização, não por dono; nada muda para co-donos.

## Alternativas descartadas

- **Agendar em D e executar em D + 7:** as datas do e-mail e dos termos ficariam 7 dias erradas.
- **`not_before = D`:** o aviso do dia poderia chegar depois do purge, e o prazo de pedir a cópia cairia antes de D.
- **Principal "sistema" em `platform_principals`:** passaria pelos controles de `admin_require_principal`. Uma coluna `actor` é mais estreita.
- **Função do dono de privacidade (`polaris_privacy_owner`) ou do Admin (`polaris_admin_owner`):** os dois já podem mudar o status de uma organização, mas são donos de funções que o runtime do tenant ou do Admin executam. Um defeito numa delas agendaria purges. O papel do purge só é alcançado pelo runtime de privacidade.
- **Contar 90 dias absolutos (`requested_at + interval '90 days'`):** a data mostrada ao lojista é um dia do calendário dele, e a mudança de horário de verão moveria o instante.
