---
status: accepted
---

# Ledger mínimo de exclusões para restore

## Contexto

A anonimização de cliente (ADR 0075) e o purge de organização (PR107) tiram dado do banco ativo, mas **não alcançam backups do provedor**. Um restore volta o banco a um instante anterior e ressuscita o que já havia sido removido: um cliente anonimizado volta com nome, telefone e email; uma organização purgada volta inteira. As regras de privacidade já dizem que o restore "reaplica o deletion ledger antes de reutilizar o ambiente" ([privacidade](../business-rules/privacy.md)), e o plano (PR106) pede só isto: "criar tombstone mínima, usada em restore, sem business payload". O ADR 0078 e o plano acrescentam uma segunda necessidade ao PR107: depois que a organização some, só o ID dela permite achar de novo os objetos no R2 (`exports/v1/{organização}/`), e é o ledger que deve guardá-lo.

## Decisão

- **Uma tabela, só tombstones.** `deletion_ledger` guarda, por exclusão: o ID da organização, o tipo de registro (`customer` ou `organization`), o ID do registro, a operação (`anonymize` ou `purge`), o caso de privacidade (UUID opaco, opcional) e o instante. Nada mais: nenhuma coluna pode guardar nome, email, telefone, observação ou valor de negócio, e o banco recusa (CHECK) qualquer par fora de `customer`/`anonymize` e `organization`/`purge`, ID que não seja opaco (letras, números, `-` e `_`, até 64), cliente que não seja UUID e purge cujo ID não seja o da própria organização. O domínio (`@polaris/domain/privacy/deletion-ledger`) é a especificação executável e recusa campos além do contrato. "Por qual processo" é o par tipo/operação; "por qual caso", o `privacy_case_id`, que o comando de anonimização de hoje não conhece (fica nulo) e que o purge poderá preencher.
- **Sobrevive ao que registra.** Sem chave estrangeira para a organização nem para o registro: o purge apaga a organização e o ledger continua. Uma exclusão é registrada uma vez só (índice único por tipo, ID e operação).
- **Quem grava.** (1) **Anonimização de cliente**, já neste PR (a migration também grava, uma vez, o tombstone dos clientes que já estavam anonimizados, com o `anonymized_at` como instante): `anonymizeCustomerForPrivacy` grava o tombstone **na mesma transação** do comando (`recordDeletionLedgerEntry`); se a transação desfaz, os dois desfazem, e um comando repetido (`changed: false`) ou recusado não grava nada. O comportamento do comando não muda. (2) **Purge de organização** (PR107): grava o tombstone `organization`/`purge` com o ID da organização **antes e na mesma transação** de apagar as linhas, pelo papel de privacidade; o `INSERT` e a política desse papel entram na migration do PR107, não aqui. O PR107 também decide como o ledger e os casos de privacidade sobrevivem à organização (pendência do ADR 0077).
- **Append-only para todos.** A tabela força RLS e **nenhuma política permite `UPDATE` ou `DELETE`** a qualquer papel; os privilégios também não. O runtime do tenant tem só `INSERT` nas quatro colunas de um tombstone (nunca o caso, o ID ou o instante) e **não lê nada**; a política exige a organização e o usuário da transação (membership ativo, organização ativa) e que o cliente já esteja anonimizado naquela organização (`anonymized_at` marcado; o comando grava o tombstone depois do `UPDATE`, na mesma transação), de modo que um tombstone forjado, de outra organização, de um cliente que não foi anonimizado ou de purge é recusado: no restore, um tombstone falso anonimizaria uma pessoa real. O dono de privacidade (`polaris_privacy_owner`, sem login) só lê, para o restore. Nenhum outro papel tem acesso. O gate prova isso pelo catálogo (privilégios por tabela e por coluna, políticas) e por SQL direto.
- **Como o restore usa.** O procedimento está em [deletion-ledger-restore.md](../runbooks/deletion-ledger-restore.md): antes de substituir um ambiente, lê-se o ledger **do ambiente que será substituído** (a cópia do ledger que vem no backup só tem o que existia no instante do backup); depois do restore e **antes de reabrir o ambiente a usuários e aparelhos**, reaplica-se cada tombstone (anonimização de cliente que reapareceu com dado pessoal; purge da organização que reapareceu) e confere-se por uma consulta de verificação que nenhum tombstone ficou sem efeito. A reaplicação é manual por ora: a automação do restore é da Fase 16, e este PR não a cria.
- **Fora da exportação.** `deletion_ledger` tem `organization_id` e entra na lista de tabelas excluídas da exportação (o papel do tenant só grava, não lê), com a razão registrada em código, como o gate de exportação exige.

## Consequências

- Uma anonimização feita depois do último backup pode ser refeita num restore, sem guardar o dado que foi removido.
- O purge terá onde deixar o ID da organização, para achar no R2 o que sobrar.
- O ledger **não dá segurança contra perda do próprio banco**: ele mora no mesmo banco. Se o ambiente de origem não puder mais ser lido (perda total), os tombstones posteriores ao último backup se perdem junto. Uma cópia do ledger fora do banco (por exemplo, exportação periódica para o armazenamento) é decisão da Fase 16, junto da automação do restore.
- A retenção do ledger tem classe própria, `deletion_ledger`, proposta no ADR 0079 (ver abaixo).

## Retenção do ledger

O ADR de retenção por classe de dado ([ADR 0079](0079-retencao-por-classe-de-dado.md), `proposto`; este ADR não depende dele) lista `provider_backups` ("restore reaplica o deletion ledger") e a classe própria do ledger, `deletion_ledger`, que também está no registro `@polaris/domain/privacy/retention` (estado `proposta`, sem job). A regra, escrita aqui e espelhada nos dois: a classe (a) **sobrevive à organização** (não é apagada pelo purge); (b) **não expira antes da janela de restauração mais longa do provedor** (enquanto um backup anterior ao tombstone puder ser restaurado, o tombstone precisa existir); (c) não tem job de expurgo por enquanto, e qualquer remoção futura exige uma migration revisada (nenhum papel pode apagar hoje); (d) estado `proposta`, com o prazo a confirmar pelo responsável junto da janela de backup. Enquanto o prazo não for confirmado, o ledger não é apagado por ninguém.

## Limites aceitos

- **O ID opaco é pseudônimo enquanto existir um backup antigo.** O tombstone, sozinho, não identifica ninguém (sem nome nem contato, e o registro anonimizado não tem mais a pessoa), mas um backup anterior ainda liga aquele UUID a uma pessoa; por isso o ledger só vale a pena junto da retenção dos backups.
- **O instante diz quando** a exclusão foi feita, não **por quê**: o caso de privacidade só entra quando o comando de anonimização passar a conhecê-lo (o campo existe e é nulo).
- **A reaplicação do purge depende do PR107** (idempotência do purge e varredura do R2); este PR só deixa o formato do tombstone pronto para ele.
- **Reaplicar uma anonimização é um `UPDATE` privilegiado** do dono do banco (o runtime do tenant não consegue, e nem deve), feito à mão, com o mesmo efeito do comando: nome fixo, sem contatos nem observações, arquivado, `anonymized_at`, versão +1. Os aparelhos aprendem pelo log de mudanças como em qualquer alteração; um aparelho que sincronizou com o ambiente perdido pode ter estado mais novo que o restaurado, o que é um problema geral do restore, não do ledger.
- **`TRUNCATE` e o dono do banco.** Nenhum papel de aplicação trunca a tabela, mas o dono do banco (que ignora RLS na Neon) pode; é o acesso de quem opera o banco, igual ao das outras trilhas.
- **Sem tela, sem aviso, sem listagem na API.** O ledger é um registro de banco para o restore; ninguém o lê pelo aplicativo.

## Emenda (ADR 0081)

O purge não apaga a linha da organização: ela fica como tombstone `purged`, sem nome, e isso substitui a frase "o purge apaga a organização" da Decisão. O tombstone `organization`/`purge` é gravado por `polaris_purge_owner`, papel próprio do purge (não o `polaris_privacy_owner`), com o caso de privacidade do agendamento, antes das linhas e na mesma transação. A política e o `INSERT` estão na migration 0070.

O papel de purge também lê os tombstones de purge do ledger, para a reaplicação depois de um restore. O `SELECT` é só nas colunas `organization_id`, `entity_type`, `entity_id` e `operation`, e só nas linhas `organization`/`purge`; nada mais do ledger é lido por ele. Assim, um purge reaplicado passa pela trava dos 30 dias pelo próprio tombstone, que prova que o prazo já foi cumprido na primeira vez (ADR 0081, decisão 1).

## Alternativas rejeitadas

- **Guardar o payload da exclusão para poder refazê-la:** é exatamente o dado que a exclusão tirou; o tombstone diz "isto foi removido", e quem refaz usa o efeito do comando.
- **Marcar a linha com `deleted_at` em vez de uma tabela:** não existe a linha depois do purge, e a anonimização não apaga a linha; o ledger precisa sobreviver às duas.
- **Chave estrangeira para a organização com `ON DELETE CASCADE`:** o purge apagaria o ledger junto, justamente o que precisa ficar.
- **Deixar o runtime do tenant ler o ledger:** nenhum fluxo do aplicativo precisa dele, e ler tombstones de outras organizações seria um vazamento de quem pediu privacidade.
- **Um gatilho que bloqueia `UPDATE` e `DELETE`:** a RLS forçada, sem política e sem privilégio, já nega aos papéis de aplicação, e um gatilho impediria uma remoção futura que a retenção aprovasse e uma migration revisada fizesse.
