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

- **O gatilho é administrativo, nunca um job.** Enquanto `closed_organization` estiver em `proposta`, nada agenda um purge. Um operador do Admin, com a capacidade nova `organization:purge` e um caso aberto da organização, chama `admin_schedule_organization_purge` (`POST /support-cases/{caso}/purge`). O corpo nomeia a organização (`organizationId`): é uma confirmação, não a autoridade, porque a organização vem do caso no banco.
  - **Recusas (409, nada muda):**
    - `organization_mismatch`: a organização nomeada não é a do caso.
    - `organization_not_closed`: a organização está ativa, suspensa ou ainda em `closing`, ou não tem registro de encerramento.
    - `recovery_window_open`: a janela de recuperação não acabou.
    - `tenant_access_active`: há acesso temporário vigente à organização.
    - `paid_access_running`: a cobrança está `trialing`, `active` ou `grace` com acesso vigente (um trial pode virar cobrança).
    - `privacy_case_not_accepted`: o caso é de privacidade e não está decidido com aceitação (`decided` ou `executed`, decisão `accept` ou `partially_accept`). Um pedido recusado, encaminhado ou ainda sem decisão nunca apaga dado do tenant (ADR 0077). Um caso de suporte comum basta, porque quem pediu o encerramento foi o próprio dono.
  - **O que o agendamento faz:** muda o status para `purge_pending`, cria a linha em `organization_purges` (quem agendou, sob qual caso, o caso de privacidade se for um, a partir de quando) e audita `organization.purge_scheduled`.
  - **O atraso:** o início mínimo é o fim da janela mais o atraso de `closed_organization` lido do registro (`purgeDelayAfterWindowMs`, zero enquanto a classe está proposta). Nenhum prazo foi inventado aqui.
  - `automaticPurgeSchedulingAllowed` só fica verdadeiro com a classe aprovada e um prazo. O registro declara o purge em `ADMIN_TRIGGERED_REMOVALS`, separado de `RETENTION_PURGE_JOBS`, e um teste falha se uma classe proposta tiver job.
- **A linha da organização fica, como tombstone.** O purge não apaga `organizations`: troca o nome por `Organização removida` e o status por `purged`. Por isso as chaves estrangeiras restritivas de `support_cases`, `billing_events` e `organization_purges` continuam válidas sem mudar nenhuma constraint, e o que precisa sobreviver sobrevive.
  - Isso emenda o ADR 0080, que dizia "o purge apaga a organização". O ledger continua sem chave estrangeira e sobrevive do mesmo jeito.
- **O que sai e o que fica.**
  - **Sai todo dado do tenant**, que é o controlador e pediu o encerramento: vendas e seus fatos, estoque, catálogo e imagens, clientes, despesas e metas, perfis de pagamento, sincronização e comandos offline, concessões offline, exportações, perfil do catálogo público, auditoria do tenant, registro do encerramento e memberships. São 35 tabelas em ordem, mais as variantes e opções, que saem com o produto pelo cascade.
  - **Fica o registro da própria plataforma:** casos de suporte e de privacidade, acessos temporários do Admin, auditoria do Admin, cobrança (`billing_events`, `organization_billing`, `entitlement_grants`), deletion ledger e o próprio `organization_purges`.
  - A lista está em `packages/db/src/purge-datasets.ts`, com a razão de cada sobrevivente. O gate falha se uma tabela com `organization_id` não estiver em nenhuma lista.
  - Contas de usuário (`user`) são globais e não são apagadas.
- **Ordem das etapas.** O job do papel de privacidade (o mesmo `scheduled` horário, isolado das exportações) faz, por organização:
  1. `claim_organization_purge`: pega o purge vencido mais antigo com `SKIP LOCKED` e concessão de 15 minutos, maior que os 10 da exportação. Uma organização com exportação `running` de concessão vigente espera a hora seguinte.
  2. Apaga `exports/v1/{organização}/` no R2.
  3. `list_organization_purge_media` devolve os assets. O job apaga cada master, os derivados 320 e 640 (cuja chave tem só o asset), em lotes de até 1000 chaves por chamada, e varre `media/v2/{organização}/` (masters de envios que não viraram asset). Um master fora do prefixo da organização para o passo: o purge nunca apaga objeto de outra organização.
  4. `purge_organization_data`, numa transação:
     - confere `purge_pending`, a concessão e o prazo, e recusa se houver exportação `running` vigente;
     - grava o tombstone no `deletion_ledger` (com o caso de privacidade);
     - apaga as tabelas na ordem;
     - roda `SET CONSTRAINTS ALL IMMEDIATE`, para as verificações adiadas das variantes rodarem enquanto as linhas ainda são visíveis ao papel;
     - só então marca `purged`.
  5. Varre os dois prefixos de novo e marca `swept_at`.

  Qualquer falha nos passos 2 ou 3 para antes do banco. A falha é anotada (`purge_<passo>_failed`), o purge continua preso até a concessão vencer e uma execução seguinte recomeça do início.
- **Idempotência.** Apagar o R2 de novo não tem efeito. `purge_organization_data` numa organização `purged` devolve `alreadyPurged` sem tocar nada. Um purge `purged` sem `swept_at` volta só para a varredura. Agendar de novo não muda nada. O tombstone do ledger usa `ON CONFLICT DO NOTHING`, então um purge reaplicado depois de um restore não duplica a linha.
- **Papéis.**
  - **`polaris_purge_owner`** (novo, nunca login) é dono das cinco funções do purge, que só `polaris_privacy_runtime` executa. Ele não amplia o `polaris_privacy_owner`, dono do encerramento e da exportação.
    - Tem `SELECT` e `DELETE` nas tabelas apagadas, com políticas que exigem a organização da linha em `purge_pending`, e `SELECT` nas variantes e opções.
    - Em `organizations`, lê só `id` e `status` e atualiza `name`, `status` e `updated_at` de `purge_pending` para `purged`.
    - Pode inserir em `deletion_ledger` só o tombstone de purge de uma organização em `purge_pending`.
    - Não tem nada em casos, acessos, auditoria do Admin, cobrança, nem para ler o ledger.
  - **O dono do Admin** ganha `INSERT` e `UPDATE` em `organization_purges` e a leitura do fim da janela em `organization_closures`.
- **Exceção estreita em dois gatilhos.** As funções `prevent_stock_movement_mutation` e `guard_media_link_product_not_deleted` são substituídas (`CREATE OR REPLACE`) por versões que deixam passar **só** um `DELETE` feito por `polaris_purge_owner` de uma linha cuja organização está em `purge_pending`. O resto do corpo fica igual, e o gate prova que, fora do purge, os dois continuam recusando. `prevent_stock_movement_mutation` declara `search_path = pg_catalog, public`, o mesmo que a migration 0040 tinha fixado por `ALTER FUNCTION` (o `CREATE OR REPLACE` apagaria essa configuração). É a única mudança não aditiva da migration.
  - A alternativa (`session_replication_role = replica`) desligaria também a integridade referencial e exige superusuário.
- **A exportação não deixa cópia de organização inativa.** Um gatilho novo em `data_export_files` recusa registrar arquivo de organização que não está `active`. A leitura como solicitante já era recusada antes de qualquer gravação no R2, e o gate prova as duas coisas (POL-79).
- **Cache do catálogo e referências locais.** O catálogo público só lê organização `active`. Depois de 30 dias inativa, o cache de 60 segundos das imagens já expirou, e não há KV nem Cache API a limpar. O servidor não alcança o OPFS do aparelho. A concessão offline (até 72 horas) foi revogada no encerramento, e o purge apaga as concessões e as memberships, então o aparelho não volta a sincronizar.

## Consequências

- Uma organização encerrada pode ser removida de fato, sem esperar uma decisão de prazo legal que não cabe ao código, mas só por um ato explícito e auditado de um operador.
- Os casos, a auditoria do Admin e a cobrança continuam consultáveis. O tombstone da organização só tem ID, status, fuso, moeda e datas.
- Uma tabela nova com organização precisa ser classificada em `purge-datasets.ts`, além da classificação de exportação do ADR 0078.
- O restore reaplica o purge pelo ledger: força `purge_pending` e deixa o job refazer as etapas (ver o [runbook](../runbooks/deletion-ledger-restore.md)).

## Limites aceitos e decisões do responsável

- **O purge apaga classes com base legal ainda proposta** (vendas, estoque, despesas, auditoria do tenant) porque o gatilho é a decisão explícita do operador. Se o responsável decidir guardar alguma delas depois do encerramento, essa classe sai da lista de apagadas antes do purge seguinte.
- **A cobrança fica.** `billing_events.fact` é um jsonb normalizado do provedor e pode conter dado do pagador. Apagar, anonimizar ou manter pelo prazo fiscal é decisão do responsável (ADR 0079). O cancelamento da renovação no provedor continua esperando o Gate 7: o purge só exige que o acesso pago tenha terminado.
- **O texto livre dos casos sobrevive.** O motivo e o contexto do caso de suporte e a nota do caso de privacidade são curtos, mas livres (ADR 0077). O purge não os reescreve: caso fechado é imutável.
- **A substituição das duas funções de gatilho** é uma mudança de comportamento numa migration que, fora isso, só acrescenta. Ela precisa do aceite do responsável.
- **Não há desfazer nem cancelar.** Depois de agendado, o purge começa na execução horária seguinte. Um agendamento errado não tem volta além do backup do provedor.
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
