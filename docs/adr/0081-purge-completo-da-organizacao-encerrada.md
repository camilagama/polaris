---
status: proposto
---

# Purge completo da organização encerrada

## Contexto

O encerramento (ADR 0074) revoga o acesso na hora e deixa os dados intactos durante 30 dias. Depois, a organização fica `closed` e o plano (PR107) pede o purge: banco, masters e derivados de imagem no R2, cache do catálogo, referências locais e recursos relacionados, de forma idempotente. Três ADRs deixaram requisitos para cá:

- **ADR 0078 (exportação):** apagar `exports/v1/{organização}/` no R2 **antes** das linhas (com `ON DELETE CASCADE`, os ZIPs ficariam sem dono, com dado pessoal de clientes); não seguir para o banco se o prefixo falhar; tratar a exportação em andamento; varrer o prefixo uma segunda vez.
- **ADR 0077 (casos de privacidade):** os casos (`privacy_cases`, `privacy_case_actions` e o caso de suporte) têm chave estrangeira restritiva para a organização, forçam RLS e precisam sobreviver a ela como evidência do atendimento.
- **ADR 0080 (deletion ledger):** gravar o tombstone `organization`/`purge` antes das linhas e na mesma transação, com o `INSERT` e a política do papel de privacidade nesta migration.

O registro de retenção (ADR 0079) deixa `closed_organization` em `proposta`: a janela de 30 dias está aprovada, mas o atraso entre `closed` e o purge não. Várias classes apagadas pelo purge têm base legal ainda proposta (vendas, estoque, despesas, auditoria do tenant).

Há também um limite físico no banco. O cascade a partir de `organizations` não funciona: as tabelas do tenant se referenciam com `RESTRICT` (item de venda para variante, movimento de estoque para variante, vínculo de imagem para asset). Dois gatilhos bloqueiam o `DELETE` de qualquer papel: `stock_movements` é append-only, e os vínculos de imagem de um produto removido ficam congelados.

## Decisão

- **O gatilho é administrativo, nunca um job.** Enquanto `closed_organization` estiver em `proposta`, nada agenda um purge. Um operador do Admin, com a capacidade nova `organization:purge` e o caso de privacidade aberto da exclusão (ver abaixo), chama `admin_schedule_organization_purge` (`POST /support-cases/{caso}/purge`). O corpo nomeia a organização (`organizationId`): é uma confirmação, não a autoridade, porque a organização vem do caso no banco.
  - **O caso certo.** Só vale o caso de privacidade (ADR 0077) que seja, ao mesmo tempo:
    - do tipo **exclusão** (`deletion`);
    - pedido pelo **dono da organização** (`organization_owner`), nunca por titular, autoridade ou outro solicitante;
    - decidido com **`accept` integral** (etapa `decided` ou `executed`): `partially_accept`, recusa, encaminhamento e pedido ainda sem decisão não bastam;
    - com o **escopo exato da organização inteira**: as categorias `organization_profile`, `customers`, `sales`, `inventory_catalog`, `media` e `audit_logs`, que são tudo o que o purge apaga do tenant (`ORGANIZATION_PURGE_REQUIRED_SCOPE` no domínio, repetido na função), nem uma a menos, nem uma a mais. Conta, autenticação e cobrança **não podem constar**: o purge as mantém, e um caso que as reivindicasse registraria uma decisão que o purge não cumpre (a Polaris continua controladora desses dados, ADR 0079). Quem precisar apagar conta ou cobrança abre outro pedido; este caso é recusado, não aceito em parte.

    **Um caso de suporte comum não basta**, mesmo de uma organização `closed`: o encerramento foi um pedido do dono, mas apagar de vez exige a decisão registrada de que ele pediu a exclusão e de que ela vale para tudo.
  - **Recusas (409, nada muda):**
    - `organization_mismatch`: a organização nomeada não é a do caso.
    - `organization_not_closed`: a organização está ativa, suspensa ou ainda em `closing`, ou não tem registro de encerramento.
    - `recovery_window_open`: a janela de recuperação não acabou.
    - `tenant_access_active`: há acesso temporário vigente à organização.
    - `paid_access_running`: a cobrança está `trialing`, `active` ou `grace` com acesso vigente (um trial pode virar cobrança).
    - `privacy_case_required`: o caso é de suporte comum, sem fluxo de privacidade.
    - `privacy_case_not_deletion`: o caso de privacidade não é de exclusão (acesso, correção, portabilidade, oposição, restrição ou outro).
    - `privacy_requester_not_owner`: quem pediu não é o dono da organização.
    - `privacy_case_not_accepted`: o caso ainda não está decidido (`decided` ou `executed`) ou a decisão não é `accept` integral. Um pedido recusado, aceito em parte, encaminhado ou ainda sem decisão nunca apaga dado do tenant (ADR 0077).
    - `privacy_scope_incomplete`: o escopo do caso não cobre toda categoria de tenant que o purge apaga (dito primeiro, mesmo que o escopo também traga categoria mantida).
    - `privacy_scope_covers_kept_data`: o escopo cobre tudo o que o purge apaga, mas também traz conta, autenticação ou cobrança, que ele mantém. A resposta do Admin traz uma frase em português que diz isso e quais categorias registrar.
    As recusas do caso vêm antes das do estado da organização: um caso que não serve é recusado seja qual for o estado dela.
  - **O que o agendamento faz:** muda o status para `purge_pending`, cria a linha em `organization_purges` (quem agendou, sob qual caso de privacidade, a partir de quando) e audita `organization.purge_scheduled`.
  - **O atraso:** o início mínimo é o fim da janela mais o atraso de `closed_organization` lido do registro (`purgeDelayAfterWindowMs`, zero enquanto a classe está proposta). Nenhum prazo foi inventado aqui.
  - `automaticPurgeSchedulingAllowed` só fica verdadeiro com a classe aprovada e um prazo. O registro declara o purge em `ADMIN_TRIGGERED_REMOVALS`, separado de `RETENTION_PURGE_JOBS`, e um teste falha se uma classe proposta tiver job.
- **Cancelamento.** O operador que agendou por engano, ou cujo pedido foi retirado pelo dono, chama `admin_cancel_organization_purge` (`POST /support-cases/{caso}/purge/cancel`, corpo `{ organizationId, reason }`), com a mesma capacidade `organization:purge`, o operador sempre o do login e a organização nomeada como confirmação.
  - **Motivo obrigatório:** texto de 1 a 500 caracteres, sem caracteres de controle. Vai para `organization_purge_cancellations`, um histórico só de inserção (quem cancelou, sob qual caso, qual agendamento e o motivo) que o dono do Admin lê e acrescenta, e que ninguém altera nem apaga (sem grant de `UPDATE` e `DELETE`, e um gatilho recusa `UPDATE`, `DELETE` e `TRUNCATE` até do dono da tabela, como na auditoria do Admin). O motivo **não** vai para o evento de auditoria, que não carrega texto livre (a mesma regra da nota do ADR 0077): a auditoria registra `organization.purge_cancelled`, com a organização, o caso e o operador. Agendar de novo recomeça a linha de `organization_purges` do zero, mas o motivo do cancelamento anterior fica no histórico, junto de todos os outros. Como o histórico sobrevive à organização, o motivo é mais um texto livre curto do operador que o purge não reescreve (ver os limites abaixo).
  - **Só enquanto nenhuma execução segura o purge e antes de o armazenamento ser tocado.** A função trava a organização e depois a linha do purge, na mesma ordem do purge, e recusa com `purge_in_progress` se houver concessão vigente (`locked_until` no futuro) e com `purge_storage_touched` se `storage_touched_at` estiver preenchido. Uma execução que pega a linha no mesmo instante vence e o cancelamento é recusado; se o cancelamento vence, a execução não encontra a organização em `purge_pending`.
  - **O que marca o ponto sem volta é o armazenamento, não a tentativa.** O job chama `mark_organization_purge_storage_touched` antes da primeira exclusão no R2 (a do prefixo das exportações), e a função grava `storage_touched_at` na linha do purge, uma vez só (a primeira chamada vale) e só enquanto há concessão vigente e a organização está em `purge_pending`: uma execução cuja concessão venceu, ou cujo purge foi cancelado, é recusada e o job para ali (`purge_mark_storage_failed`), sem tocar o R2. A função não distingue duas execuções: se outra já reivindicou o purge, a execução antiga ainda passa, e isso é inofensivo (a marca é idempotente e as exclusões também). Uma tentativa que falhou antes dessa chamada (concessão perdida, Worker morto, erro de leitura) deixa `attempts` maior que zero e o purge continua cancelável: nada saiu do armazenamento. Depois da marca, o cancelamento é recusado para sempre, mesmo sem execução segurando, porque o R2 já pode ter perdido objetos que o banco ainda aponta. Como a marca vem antes da exclusão, uma exclusão que falhou logo na primeira chamada também fecha o cancelamento: é o lado conservador. A resposta de recusa do Admin traz o código e uma frase que explica o motivo (`purge_storage_touched`: "O purge já começou a apagar arquivos no armazenamento e não pode mais ser cancelado").
  - **Restore.** O purge reaplicado depois de um restore (runbook) entra com `storage_touched_at` preenchido: o tombstone prova que o R2 já foi apagado, então ele também não pode ser cancelado.
  - **Efeito:** a organização volta de `purge_pending` para `closed`, a concessão é limpa e o cancelamento entra no histórico. Nada foi apagado. A organização não é purgada enquanto o status for `closed`: nenhum job a pega.
  - **Outras recusas (409):** `purge_not_scheduled` (a organização não está em `purge_pending`, ou não há purge) e `purge_already_done` (já `purged`: sem volta). Qualquer caso aberto da organização pode cancelar, não só o de privacidade: o cancelamento é o sentido seguro, e o dono pode ter retirado o pedido por outro canal.
  - **Agendar de novo** depois de cancelar é permitido, com um caso que sirva, e recomeça a linha do zero (zera tentativas, concessão, erro e `storage_touched_at`; a auditoria mantém os dois eventos e o histórico mantém o motivo).
- **A linha da organização fica, como tombstone.** O purge não apaga `organizations`: troca o nome por `Organização removida` e o status por `purged`. Por isso as chaves estrangeiras restritivas de `support_cases`, `billing_events` e `organization_purges` continuam válidas sem mudar nenhuma constraint, e o que precisa sobreviver sobrevive.
  - Isso emenda o ADR 0080, que dizia "o purge apaga a organização". O ledger continua sem chave estrangeira e sobrevive do mesmo jeito.
- **O que sai e o que fica.**
  - **Sai todo dado do tenant**, que é o controlador e pediu o encerramento: vendas e seus fatos, estoque, catálogo e imagens, clientes, despesas e metas, perfis de pagamento, sincronização e comandos offline, concessões offline, exportações, perfil do catálogo público, auditoria do tenant, eventos do outbox transacional (ADR 0082), o registro de processamento da fila (`queue_processing`, ADR 0084), registro do encerramento e memberships. São 37 tabelas em ordem, mais as variantes e opções, que saem com o produto pelo cascade.
  - **Fica o registro da própria plataforma:** casos de suporte e de privacidade, acessos temporários do Admin, auditoria do Admin, cobrança (`billing_events`, `organization_billing`, `entitlement_grants`), deletion ledger, o próprio `organization_purges` e o histórico de cancelamentos.
  - A lista está em `packages/db/src/purge-datasets.ts`, com a razão de cada sobrevivente. O gate falha se uma tabela com `organization_id` não estiver em nenhuma lista.
  - Contas de usuário (`user`) são globais e não são apagadas.
- **Ordem das etapas.** O job do papel de privacidade (o mesmo `scheduled` horário, isolado das exportações) faz, por organização:
  1. `claim_organization_purge`: pega o purge vencido mais antigo com `SKIP LOCKED` e concessão de 15 minutos, maior que os 10 da exportação. Uma organização com exportação `running` de concessão vigente espera a hora seguinte.
  2. `mark_organization_purge_storage_touched` (o ponto sem volta do cancelamento) e então apaga `exports/v1/{organização}/` no R2.
  3. `list_organization_purge_media` devolve os assets. O job apaga cada master, os derivados 320 e 640 (cuja chave tem só o asset), em lotes de até 1000 chaves por chamada, e varre `media/v2/{organização}/` (masters de envios que não viraram asset). Um master fora do prefixo da organização para o passo: o purge nunca apaga objeto de outra organização.
  4. `purge_organization_data`, numa transação:
     - confere `purge_pending`, a concessão e o prazo, e recusa se houver exportação `running` vigente;
     - grava o tombstone no `deletion_ledger` (com o caso de privacidade);
     - apaga as tabelas na ordem;
     - roda `SET CONSTRAINTS ALL IMMEDIATE`, para as verificações adiadas das variantes rodarem enquanto as linhas ainda são visíveis ao papel;
     - só então marca `purged` e audita a conclusão (`organization.purge_completed`, ver abaixo).
  5. Varre os dois prefixos de novo e marca `swept_at`.

  Qualquer falha nos passos 2 ou 3 para antes do banco. A falha é anotada (`purge_<passo>_failed`), o purge continua preso até a concessão vencer e uma execução seguinte recomeça do início.
- **Auditoria da conclusão.** O passo do banco grava `organization.purge_completed` em `platform_audit_events`, na mesma transação em que a organização passa a `purged`. O evento tem só IDs (a organização como entidade, o caso e o operador que agendou, que é o principal: o job não tem um), sem detalhe e sem dado pessoal. Um purge reaplicado depois de um restore grava outro evento; um `purge_organization_data` numa organização já `purged` não grava nada. Somados ao `purge_scheduled` e ao `purge_cancelled`, os três eventos contam a história do purge na auditoria do Admin.
- **Idempotência.** Apagar o R2 de novo não tem efeito. `purge_organization_data` numa organização `purged` devolve `alreadyPurged` sem tocar nada. Um purge `purged` sem `swept_at` volta só para a varredura. Agendar de novo não muda nada. O tombstone do ledger usa `ON CONFLICT DO NOTHING`, então um purge reaplicado depois de um restore não duplica a linha.
- **Papéis.**
  - **`polaris_purge_owner`** (novo, nunca login) é dono das seis funções do purge (reivindicar, marcar o armazenamento como tocado, listar as imagens, apagar as linhas, anotar a falha e fechar a varredura), que só `polaris_privacy_runtime` executa. Ele não amplia o `polaris_privacy_owner`, dono do encerramento e da exportação.
    - Tem `SELECT` e `DELETE` nas tabelas apagadas, com políticas que exigem a organização da linha em `purge_pending`, e `SELECT` nas variantes e opções.
    - Em `organizations`, lê só `id` e `status` e atualiza `name`, `status` e `updated_at` de `purge_pending` para `purged`.
    - Pode inserir em `deletion_ledger` só o tombstone de purge de uma organização em `purge_pending`.
    - Pode inserir em `platform_audit_events` só o evento `organization.purge_completed` (sem detalhe, da própria organização, que já está `purged`, com o principal e o caso do próprio `organization_purges`). Não lê, não altera nem apaga a auditoria.
    - Não tem nada em casos, acessos, cobrança, nem para ler o ledger.
  - **O dono do Admin** ganha `INSERT` e `UPDATE` em `organization_purges`, `INSERT` e `SELECT` (nunca `UPDATE` nem `DELETE`) em `organization_purge_cancellations` e a leitura do fim da janela em `organization_closures`. `admin_cancel_organization_purge` é executada só por `polaris_admin_runtime`.
- **Exceção estreita em dois gatilhos.** As funções `prevent_stock_movement_mutation` e `guard_media_link_product_not_deleted` são substituídas (`CREATE OR REPLACE`) por versões que deixam passar **só** um `DELETE` feito por `polaris_purge_owner` de uma linha cuja organização está em `purge_pending`. O resto do corpo fica igual, e o gate prova que, fora do purge, os dois continuam recusando. `prevent_stock_movement_mutation` declara `search_path = pg_catalog, public`, o mesmo que a migration 0040 tinha fixado por `ALTER FUNCTION` (o `CREATE OR REPLACE` apagaria essa configuração). É a única mudança não aditiva da migration.
  - A alternativa (`session_replication_role = replica`) desligaria também a integridade referencial e exige superusuário.
- **A exportação não deixa cópia de organização inativa.** Um gatilho novo em `data_export_files` recusa registrar arquivo de organização que não está `active`. A leitura como solicitante já era recusada antes de qualquer gravação no R2, e o gate prova as duas coisas (POL-79).
- **Cache do catálogo e referências locais.** O catálogo público só lê organização `active`. Depois de 30 dias inativa, o cache de 60 segundos das imagens já expirou, e não há KV nem Cache API a limpar. O servidor não alcança o OPFS do aparelho. A concessão offline (até 72 horas) foi revogada no encerramento, e o purge apaga as concessões e as memberships, então o aparelho não volta a sincronizar.

## Consequências

- Uma organização encerrada pode ser removida de fato, sem esperar uma decisão de prazo legal que não cabe ao código, mas só por um ato explícito e auditado de um operador, amparado no caso de exclusão aceito do dono. Um agendamento errado pode ser cancelado, com motivo, até a primeira exclusão no armazenamento.
- Os casos, a auditoria do Admin e a cobrança continuam consultáveis. O tombstone da organização só tem ID, status, fuso, moeda e datas.
- Uma tabela nova com organização precisa ser classificada em `purge-datasets.ts`, além da classificação de exportação do ADR 0078.
- O restore reaplica o purge pelo ledger: força `purge_pending` e deixa o job refazer as etapas (ver o [runbook](../runbooks/deletion-ledger-restore.md)).

## Limites aceitos e decisões do responsável

- **O purge apaga classes com base legal ainda proposta** (vendas, estoque, despesas, auditoria do tenant) porque o gatilho é a decisão explícita do operador. Se o responsável decidir guardar alguma delas depois do encerramento, essa classe sai da lista de apagadas antes do purge seguinte.
- **A cobrança fica.** `billing_events.fact` é um jsonb normalizado do provedor e pode conter dado do pagador. Apagar, anonimizar ou manter pelo prazo fiscal é decisão do responsável (ADR 0079). O cancelamento da renovação no provedor continua esperando o Gate 7: o purge só exige que o acesso pago tenha terminado.
- **O texto livre dos casos sobrevive.** O motivo e o contexto do caso de suporte e a nota do caso de privacidade são curtos, mas livres (ADR 0077). O purge não os reescreve: caso fechado é imutável. O mesmo vale para o motivo de cancelamento do histórico, que o operador escreve e que sobrevive à organização (e ao reagendamento) de propósito, para a decisão de cancelar não se perder.
- **A substituição das duas funções de gatilho** é uma mudança de comportamento numa migration que, fora isso, só acrescenta. Ela precisa do aceite do responsável.
- **O cancelamento fecha na primeira exclusão no armazenamento, por padrão conservador.** A regra (`storage_touched_at`, acima) é a que a revisão pediu e fica como padrão até o responsável decidir; as alternativas são deixar o cancelamento aberto enquanto o banco estiver intacto (a organização volta, mas imagens e exportações já removidas do R2 não voltam) ou fechá-lo na primeira tentativa (mais rígido, e fecha purges que nunca chegaram ao R2). Depois que o banco foi apagado (`purged`), não há volta além do backup do provedor. Um purge que falha para sempre depois de tocar o R2 fica sem cancelamento: o caminho é corrigir a causa e deixar o job concluir.
- **Um caso decidido com escopo largo não inicia o purge.** Se o responsável aceitou "apagar tudo" (as nove categorias), o agendamento é recusado com `privacy_scope_covers_kept_data`, e o caminho é um novo caso de exclusão com o escopo exato. Se o Léo quiser permitir corrigir o escopo de um caso já decidido, isso muda o fluxo do ADR 0077 e fica para outra decisão.
- **O escopo "da organização inteira" é uma lista fechada de categorias** do ADR 0077 (as seis que o purge apaga). Se uma categoria nova entrar no purge, a lista, a função e o gate mudam juntos.
- **O principal do evento de conclusão é o operador que agendou.** Um job não tem principal e a coluna é obrigatória; a leitura da auditoria deve tratar `organization.purge_completed` como ato do sistema, sob o agendamento daquele operador.
- O caso de privacidade não ganha uma ação automática: o operador registra `purge_scheduled` pelo fluxo do caso e o resolve depois de ver `purged_at`.
- Os markers de envio (`media/staging/v1/`) não têm a organização na chave. O reconciliador apaga cada marker em 24 horas e o master já foi removido pelo purge.
- Uma exportação que o Worker matou no meio pode ter gravado um objeto antes de a organização mudar de status. A varredura dupla do prefixo o remove, e a regra de ciclo de vida do R2 em `exports/v1/` é a defesa em profundidade (item de go-live).
- **Uma transação só para todas as linhas.** O ADR 0080 pede o tombstone e as linhas na mesma transação, então `purge_organization_data` apaga o tenant inteiro de uma vez. Um tenant muito grande pode estourar o `statement_timeout` do login de privacidade ou o limite de duração de consulta do Hyperdrive. Nesse caso tudo desfaz e a execução seguinte tenta de novo, sem avançar. Medir com volume real antes do go-live e, se preciso, apagar em lotes (exige rever o "mesma transação" do ADR 0080).
- **O R2 é refeito do início a cada tentativa.** As linhas dos assets só saem no passo do banco, então uma tentativa que falha depois do R2 apaga as mesmas chaves de novo na seguinte (sem efeito, mas com custo). Os lotes de 1000 chaves mantêm poucas chamadas mesmo com milhares de imagens. O teto real de chamadas por execução continua a confirmar na conta (ADR 0078).
- **Sem teto de tentativas.** Um purge que falha sempre (por exemplo, o R2 fora do ar) é tentado a cada hora, com o código em `organization_purges.last_error_code`. O alerta sobre isso entra com a observabilidade (Fase 12).
- **Um acesso temporário concedido depois do agendamento** não é recusado (a concessão não olha o status da organização) e o purge não confere de novo. É um operador autorizado e o acesso é registrado; recusar a concessão em `purge_pending` exigiria substituir outra função.
- **Contas de usuário ficam.** Um usuário cuja única organização foi purgada continua com nome, email e sessões (IP e user-agent): é dado de conta, com o Polaris como controlador, e a exclusão da conta é outro fluxo. Também ficam, com a cobrança, o motivo e o autor das concessões de entitlement (texto curto do operador) e a referência do cliente no provedor (`provider_ref`).
- O gate roda o job real com um bucket em memória. O R2 de verdade (paginação, consistência) não é exercitado. O gate também não popula todas as tabelas da lista (por exemplo, concessões offline, devoluções e despesas); a ordem dos `DELETE` contra as chaves estrangeiras foi conferida no catálogo, e o gate prova que nenhuma tabela da lista fica com linha da organização.

## Alternativas rejeitadas

- **Apagar a linha da organização:** exigiria trocar as chaves estrangeiras restritivas de casos, cobrança e acessos (migration não aditiva) ou apagar a evidência que precisa ficar.
- **Job que agenda o purge sozinho depois de um prazo:** o prazo não está aprovado (ADR 0079).
- **Ampliar `polaris_privacy_owner`:** daria `DELETE` em todo o tenant ao dono das funções de encerramento e de exportação.
- **Cascade a partir de `organizations`:** as chaves `RESTRICT` entre tabelas do tenant recusam, e a exceção dos gatilhos não pode depender de quem roda o cascade (as ações referenciais rodam como dono da tabela).
- **Mudar `claim_data_export` para pular organização inativa:** mais uma substituição de função. A recusa da leitura e o gatilho novo no registro do arquivo já impedem a cópia.
