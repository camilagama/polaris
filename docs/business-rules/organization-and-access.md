# Organização e acesso

- A organização é dona do catálogo, estoque, clientes, vendas e registros operacionais. Usuário e organização são entidades diferentes.
- No onboarding V1, uma regra de domínio limita o usuário a uma organização; a chave de membership é `(organization_id, user_id)` e o modelo permite múltiplas organizações no futuro.
- A criação de organização exige email verificado e valida essa condição no servidor; ver [authentication.md](authentication.md).
- A criação V1 começa com membership `owner` e `active`; o banco limita os valores atuais a esses estados até uma migration adicionar novos valores. Autorização é verificada por capabilities, não pelo papel informado pelo cliente.
- No mapa V1, `owner` recebe as 15 capabilities listadas na seção seguinte, que espelha `packages/domain/src/authorization/capabilities.ts`. Roles ou capabilities desconhecidos não concedem acesso. A razão de serem finas e atribuídas só ao `owner` está no [ADR 0022](../adr/0022-capabilities-finas-apenas-owner.md).
- Os estados de organização são `active`, `suspended` e `closed`. Estados de billing como `free`, `trialing` e `past_due` não são estados da organização.
- A V1 opera em BRL. Cada organização tem timezone IANA confirmado no onboarding; o servidor valida esse valor, enquanto instantes técnicos são UTC.
- `createInitialOrganization()` é idempotente por usuário: após obter lock transacional, retorna a organização existente sem alterá-la, inclusive em retry com payload diferente. Requests simultâneas para o mesmo usuário não podem criar outra. Se houver mais de um membership preexistente, a operação falha fechado para revisão de dados.
- O use case valida no servidor `user.email_verified` e timezone IANA. Os defaults essenciais atuais são BRL, organization `active`, membership `owner`/`active`; não há seed data adicional definida para onboarding.
- A criação inicial está disponível somente após sessão Better Auth válida; o ator vem da sessão e email verificado é checado no Worker e no banco. O writer usa ONBOARDING_HYPERDRIVE e role dedicada polaris_onboarding_runtime, com EXECUTE apenas na função controlada; a role tenant comum mantém DML negado em organizations/memberships.
- O ID de organização enviado pelo cliente é contexto solicitado, nunca prova de autorização. O servidor valida autenticação, membership e capability antes de aceitar a operação.
- A exclusão física da organização remove seus memberships por cascade no banco. Isso não define política de exclusão/retention de dados; o estado `closed` continua distinto da exclusão física.
- A exclusão física do usuário é bloqueada enquanto houver membership (`ON DELETE RESTRICT`). Transferência de ownership ou encerramento antes da exclusão ainda não tem fluxo definido.
- Uma operação tenant exige sessão Better Auth válida, membership active, organização active e capability concedida pelo mapa de domínio. Membership inexistente/inativo, organização suspended/closed e role ou capability desconhecido falham fechado.
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
| `expense:create` | Listar, criar, editar, anular e reativar despesas e gerir as categorias de despesa. Na V1 não há `expense:read`, então a leitura de despesas também exige esta capability. |

Um papel novo exige um ADR e a revisão dos pontos em que uma capability de escrita ou de administração faz as vezes de leitura (por exemplo, clientes e perfis de pagamento), para que um papel somente de venda não perca acesso nem ganhe acesso demais.
