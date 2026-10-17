---
status: accepted
---

# Admin: suspensão de organização e comandos de cobrança

## Contexto

Os últimos itens da Fase 9 são dois poderes que mudam o estado de uma organização: **suspendê-la** (PR100) e **operar a cobrança** (PR99). O plano pede comandos semânticos, nunca um menu de status, e que a suspensão seja separada da cobrança, mude a época de autorização e revogue as concessões offline. A cobrança tem um único escritor, o papel de billing (ADR 0062 e 0067), e hoje não existe adaptador de provedor de pagamento (as contas sandbox do Gate 7 ainda não existem).

## Decisão

- **Suspender e reativar** são funções do banco (como as dos ADRs 0071 e 0072), que exigem um **operador ativo** e um **caso de suporte aberto** da organização (o motivo registrado). Suspender muda, na mesma transação: o status da organização (`suspended`), a **época de autorização** de todas as suas memberships (+1) e **revoga todas as concessões offline em vigor** com o motivo `organization_suspended`; trava, na ordem, a mesma chave por usuário que a emissão de concessões usa, de modo que uma concessão é emitida antes (e revogada) ou depois (e recusada, a organização já não abre). **A cobrança não é tocada**: plano, assinatura e concessões de entitlement ficam como estavam, e o catálogo público e o resto leem o status por suas regras. Repetir é uma suspensão. Reativar só desfaz uma suspensão: **uma organização encerrada continua encerrada** (o encerramento é um processo próprio), a época não volta e as concessões offline revogadas não renascem (cada aparelho pede de novo). O papel dono das funções ganha apenas o que isso exige: atualizar `status` de `organizations`, a época de `memberships` e a revogação de `offline_grants`, com a leitura de `user_id`.
- **Comandos de cobrança do Admin** (`billing:operate`): por ora **conceder** e **encerrar** um entitlement temporário (os únicos que existem sem provedor), pelos mesmos comandos do produto (`grantEntitlement` e `revokeEntitlementGrant`, com as mesmas validações: autor, motivo, prazo máximo, só eleva, chave do catálogo). O Admin os dá pelo **papel de billing**, num binding próprio (`ADMIN_BILLING_HYPERDRIVE`), nunca escrevendo cobrança com o papel do Admin. O autor é `admin:<id do operador>`, um identificador estável.
- **Registrar antes, fazer, registrar depois.** Como a ação e a auditoria são feitas por papéis diferentes, não há uma transação só; por isso o pedido é gravado na auditoria administrativa (exige caso aberto da organização, devolve a organização do caso) **antes** de o papel de billing agir, e o resultado depois. Nada acontece sem registro prévio; um comando que falha depois do pedido deixa o pedido sem resultado, o que é visível. Se a ação já foi feita e só o registro do resultado falha (o caso fechou entre as duas etapas, o operador foi desativado), a resposta diz que a ação aconteceu e que o resultado não foi gravado (`outcomeRecorded: false`), em vez de relatar uma falha que não houve. Encerrar uma concessão que não existe, que é de outra organização ou que já terminou deixa só o pedido, sem resultado. O pedido de conceder aceita um `commandId` (UUID) do chamador: repetir o mesmo `commandId` é a mesma concessão, não duas. Como o fim de uma concessão é "daqui a N horas", a repetição pede outro instante; por isso, quando o ID já guarda uma concessão, o comando a lê antes e a repetição é a mesma concessão se tudo menos o relógio confere (organização, chave, valor, motivo e autor), sem conceder de novo. Se algo difere, é um conflito (409, `grant_id_conflict`), não um erro de servidor. A revisão do bot do PR #114 achou que a primeira versão falhava nesse caso. Encerrar um entitlement por um caso só vale para uma concessão **da organização do caso** (o comando de billing ganhou o parâmetro opcional de organização, e sem ele se comporta como antes).
- **Comandos que dependem de provedor** (reconciliar com o provedor, cancelar a renovação, reembolsar) **não existem ainda**: exigem o adaptador do provedor (PR77, PR78, PR80) e as contas sandbox do Gate 7, e não se simula um reembolso. Entram quando o adaptador existir, pelo mesmo padrão (registrar, fazer, registrar).
- **Capacidades** (ADR 0070): `organization:suspend` para suspender e reativar, `billing:operate` para os comandos de cobrança.

## Consequências

- Suspender uma organização para o acesso em tempo real (ela deixa de abrir para os próprios usuários) e invalida os aparelhos offline, sem alterar o que ela paga ou o que o plano dá; reativar a devolve sem ressuscitar o que foi revogado.
- Uma compensação a um cliente é um comando auditado, com autor e motivo, que expira sozinho.

## Limites aceitos

- A auditoria dos comandos de cobrança não é atômica com a ação (papéis diferentes): o risco é um pedido sem resultado, nunca uma ação sem pedido.
- Uma transação do tenant que já passou da checagem de status quando a suspensão confirma termina normalmente; a partir da confirmação nenhuma nova começa, e as políticas de RLS de algumas tabelas não olham o status da organização (a barreira é a abertura da transação do tenant).
- Uma membership criada durante a suspensão não tem a época movida; não há fluxo de convite hoje, e quem o criar precisa tratar isso.
- A revogação das concessões offline por suspensão não gera `tenant_audit_event` dentro da organização; o registro é a auditoria administrativa, com o número de concessões.
- O papel de billing é um escritor completo de cobrança e o banco confia no identificador do operador que o Worker do Admin informa: quem controla esse Worker controla o autor do registro.
- A chave de bloqueio por usuário atravessa organizações: suspender uma organização espera a emissão de concessão do mesmo usuário em qualquer outra; um tempo esgotado vira erro 500, e o comando pode ser repetido.
- Qualquer operador com a capacidade pode suspender a organização de um caso aberto; não há aprovação de uma segunda pessoa.
- A suspensão não avisa o cliente.
- Os comandos de provedor (reconciliar, cancelar renovação, reembolsar) e a nova tentativa de eventos falhos pelo Admin ficam para depois do Gate 7.

## Alternativas rejeitadas

- **Escrever cobrança com o papel do Admin:** abre um segundo escritor de cobrança.
- **Funções do banco que reimplementam a concessão:** duplicam as regras do domínio de concessões, que já estão provadas.
- **Registrar só depois da ação:** uma ação sem registro se for interrompida entre as duas etapas.
