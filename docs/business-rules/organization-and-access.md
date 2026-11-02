# Organização e acesso

- **Vocabulário.** No código, nos contratos e nesta documentação o conceito segue "organização" (`organization`). No texto que o lojista lê (telas, avisos, e-mails), a mesma coisa se chama "loja"; renomear identificadores não faz parte dessa regra.
- A organização é dona do catálogo, estoque, clientes, vendas e registros operacionais. Usuário e organização são entidades diferentes.
- No onboarding V1, uma regra de domínio limita o usuário a uma organização; a chave de membership é `(organization_id, user_id)` e o modelo permite múltiplas organizações no futuro.
- A criação de organização exige email verificado e valida essa condição no servidor; ver [authentication.md](authentication.md).
- A criação V1 começa com membership `owner` e `active`; o banco limita os valores atuais a esses estados até uma migration adicionar novos valores. Autorização é verificada por capabilities, não pelo papel informado pelo cliente.
- No mapa V1, `owner` recebe todas as capabilities listadas na seção seguinte, que espelha `packages/domain/src/authorization/capabilities.ts`. Roles ou capabilities desconhecidos não concedem acesso. A razão de serem finas e atribuídas só ao `owner` está no [ADR 0022](../adr/0022-capabilities-finas-apenas-owner.md).
- Os estados de organização são `active`, `suspended`, `closing`, `closed`, `purge_pending` e `purged`. `suspended` é uma medida reversível da plataforma; os quatro últimos são o encerramento (abaixo). Estados de billing como `free`, `trialing` e `past_due` não são estados da organização.
- O **encerramento** é pedido só pelo `owner`, digitando o nome da organização. Revoga o acesso na hora (a organização deixa de abrir, a época de autorização das memberships avança e todas as concessões offline em vigor são revogadas) e **pede o cancelamento da renovação** da assinatura no provedor, sem reembolso: o acesso já pago vai até o fim. O pedido é gravado junto com o encerramento e repetido enquanto a renovação estiver viva; uma falha do provedor nunca desfaz o encerramento, e desfazer o encerramento não recria a assinatura nem cancela o pedido. Em `closing` o dono pode desfazer por 30 dias (a época não volta e as concessões revogadas não renascem: um comando guardado num aparelho antes do encerramento leva a concessão revogada e o servidor o recusa com `authorization_revoked` mesmo depois do desfazer, e nada o reenvia sozinho); passada a janela a organização é `closed` e ele não desfaz mais. `purge_pending` e `purged` pertencem ao purge. Uma organização suspensa não pode ser encerrada pelo dono, e a reativação do Admin não reabre uma organização encerrada. Ver [ADR 0074](../adr/0074-encerramento-de-organizacao.md).
- O dono de uma organização encerrada (`closing`, `closed` ou `purge_pending`) lê o nome, o fuso, a fase, a data do pedido, o fim da janela de desfazer, se ainda pode desfazer, a data D, os marcos (pedido, D-30, D-7 e D) e a situação da renovação: não tratada pelo Polaris (sem provedor ou com um provedor pelo qual o Polaris não cancela), pendente ou cancelada. Essa leitura não abre o tenant: toda capability do tenant continua recusada numa organização não ativa, e quem é membro recebe a recusa `organization_closed`. Quem não é membro, ou a organização não existe, recebe a mesma resposta vazia.
- A fase é só por datas (`closing`, `closed`, `deletion_scheduled` a partir de D-7, `deletable` a partir de D). Uma organização com purge agendado aparece como `closed`, com as mesmas datas: o estado do purge e a trava legal não são mostrados ao dono.
- **Data D** é a data local do pedido de encerramento no fuso da organização mais 90 dias de calendário, contada a partir do primeiro instante desse dia local. A mudança de horário de verão não desloca D. Até D o dono pode pedir uma cópia dos dados da organização encerrada, com o mesmo conteúdo e os mesmos limites da exportação ativa (uma em andamento por vez e três em 24 horas), lida em modo somente leitura. O pedido é recusado depois de D e depois que uma execução reivindica o purge, e também quando o purge já mexeu no armazenamento ou já terminou. Pedir exige sessão aberta há até 15 minutos; baixar a cópia pronta não exige. O mesmo vale para pedir a cópia da organização ativa e para encerrar e desfazer o encerramento: sessão mais velha é recusada e nada muda.
- **Teto por pessoa.** Cada pessoa tem no máximo uma organização aberta (`active` ou `suspended`, a suspensa conta) e duas em encerramento (`closing`, `closed` ou `purge_pending`). `purged` não conta. A conta é pela membership `owner`, e uma organização com dois donos conta para os dois. Com uma aberta, criar uma organização devolve a existente (ou é recusado se ela estiver suspensa). Sem aberta e com duas em encerramento, a criação é recusada. Com menos disso, a pessoa pode abrir outra organização, mesmo tendo encerrado uma.
- **Desfazer recusado.** O dono não desfaz o encerramento enquanto qualquer dono da organização tiver outra organização aberta. A recusa não muda nada.
- A V1 opera em BRL. Cada organização tem timezone IANA confirmado no onboarding; o servidor valida esse valor, enquanto instantes técnicos são UTC.
- `createInitialOrganization()` é idempotente por usuário: após obter lock transacional, retorna a organização existente sem alterá-la, inclusive em retry com payload diferente. Requests simultâneas para o mesmo usuário não podem criar outra. Organizações em encerramento não impedem criar outra, até o teto acima; se houver mais de uma organização aberta preexistente, a operação falha fechado para revisão de dados.
- O use case valida no servidor `user.email_verified` e timezone IANA. Os defaults essenciais atuais são BRL, organization `active`, membership `owner`/`active`; não há seed data adicional definida para onboarding.
- A criação inicial está disponível somente após sessão Better Auth válida; o ator vem da sessão e email verificado é checado no Worker e no banco. O writer usa ONBOARDING_HYPERDRIVE e role dedicada polaris_onboarding_runtime, com EXECUTE apenas na função controlada; a role tenant comum mantém DML negado em organizations/memberships.
- O ID de organização enviado pelo cliente é contexto solicitado, nunca prova de autorização. O servidor valida autenticação, membership e capability antes de aceitar a operação.
- A exclusão física da organização remove seus memberships por cascade no banco. Isso não define política de exclusão/retention de dados; o estado `closed` continua distinto da exclusão física.
- A exclusão física do usuário é bloqueada enquanto houver membership (`ON DELETE RESTRICT`). Transferência de ownership ou encerramento antes da exclusão ainda não tem fluxo definido.
- Uma operação tenant exige sessão Better Auth válida, membership active, organização active e capability concedida pelo mapa de domínio. Membership inexistente/inativo, organização que não esteja active (suspended, closing, closed, purge_pending, purged) e role ou capability desconhecido falham fechado.
- Suspensão e eventos de segurança invalidam autorização offline. Uma autorização offline não transforma um command em registro oficial.

## Capabilities

Cada operação exige uma capability própria, verificada no procedimento e repetida no repositório. Hoje todas pertencem somente ao papel `owner`.

| Capability | Permite |
| --- | --- |
| `catalog:read` | Listar categorias e produtos, ler variantes e servir mídia de produto. |
| `category:create` | Criar categoria de catálogo. |
| `category:manage` | Renomear, arquivar, restaurar e remover (tombstone) categoria. |
| `product:create` | Criar produto. |
| `product:update` | Editar, arquivar, restaurar e remover (tombstone) produto; configurar variantes e SKU; enviar mídia. |
| `inventory:read` | Ler saldo e versão de estoque. |
| `inventory:adjust` | Receber, dar baixa e contar estoque. |
| `sale:create` | Confirmar venda. |
| `sale:read` | Listar e ler vendas. |
| `sale:cancel` | Cancelar venda por inteiro. |
| `sale:return` | Registrar devolução parcial. |
| `sale:assign_customer` | Ler e alterar a atribuição de cliente de uma venda. |
| `customer:update` | Listar, buscar duplicados, criar, editar, arquivar e restaurar clientes. Na V1 não há `customer:read`, então a leitura de clientes também exige esta capability. |
| `report:read` | Ler o resultado econômico de um período (vendas líquidas, CMV, margem e resultado estimado), que expõe custo e margem. |
| `goal:manage` | Criar, editar, cancelar e ler metas (o progresso delas usa o resultado do período). |
| `catalog:publish` | Gerir o perfil público, ligar e desligar o catálogo público e escolher os produtos publicados ([public-catalog.md](public-catalog.md)). |
| `organization:manage` | Gerenciar perfis de pagamento da organização. |
| `customer:anonymize` | Anonimizar um cliente por privacidade (irreversível). |
| `organization:close` | Encerrar a organização (o pedido de encerramento, com a confirmação do nome). |
| `organization:export` | Pedir uma cópia dos dados da organização e baixá-la ([data-export.md](privacy.md)). |
| `billing:manage` | Iniciar a assinatura do Pro (o checkout no provedor de pagamento), com ou sem o teste grátis ([billing-and-entitlements.md](billing-and-entitlements.md)). |
| `organization:closed_export` | Pedir a cópia dos dados de uma organização encerrada, até a data D, e baixá-la. Só o `owner`; não abre o tenant ([ADR 0078](../adr/0078-exportacao-de-dados-da-organizacao.md)). |
| `expense:create` | Listar, criar, editar, anular e reativar despesas e gerir as categorias de despesa. Na V1 não há `expense:read`, então a leitura de despesas também exige esta capability. |

Um papel novo exige um ADR e a revisão dos pontos em que uma capability de escrita ou de administração faz as vezes de leitura (por exemplo, clientes e perfis de pagamento), para que um papel somente de venda não perca acesso nem ganhe acesso demais.
