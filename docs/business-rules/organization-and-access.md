# Organização e acesso

- A organização é dona do catálogo, estoque, clientes, vendas e registros operacionais. Usuário e organização são entidades diferentes.
- No onboarding V1, uma regra de domínio limita o usuário a uma organização; a chave de membership é `(organization_id, user_id)` e o modelo permite múltiplas organizações no futuro.
- A criação de organização exige email verificado e valida essa condição no servidor; ver [authentication.md](authentication.md).
- A criação V1 começa com membership `owner` e `active`; o banco limita os valores atuais a esses estados até uma migration adicionar novos valores. Autorização é verificada por capabilities, não pelo papel informado pelo cliente.
- No mapa V1, `owner` recebe `catalog:read`, `product:create`, `product:update`, `inventory:adjust`, `sale:create`, `customer:update`, `expense:create` e `organization:manage`. Roles ou capabilities desconhecidos não concedem acesso.
- Os estados de organização são `active`, `suspended` e `closed`. Estados de billing como `free`, `trialing` e `past_due` não são estados da organização.
- A V1 opera em BRL. Cada organização tem timezone IANA confirmado no onboarding; o servidor valida esse valor, enquanto instantes técnicos são UTC.
- `createInitialOrganization()` é idempotente por usuário: após obter lock transacional, retorna a organização existente sem alterá-la, inclusive em retry com payload diferente. Requests simultâneas para o mesmo usuário não podem criar outra. Se houver mais de um membership preexistente, a operação falha fechado para revisão de dados.
- O use case valida no servidor `user.email_verified` e timezone IANA. Os defaults essenciais atuais são BRL, organization `active`, membership `owner`/`active`; não há seed data adicional definida para onboarding.
- O use case permanece interno até capabilities, contexto de autorização, grants e RLS existirem. O cliente não recebe rota de criação antes desses controles.
- O ID de organização enviado pelo cliente é contexto solicitado, nunca prova de autorização. O servidor valida autenticação, membership e capability antes de aceitar a operação.
- A exclusão física da organização remove seus memberships por cascade no banco. Isso não define política de exclusão/retention de dados; o estado `closed` continua distinto da exclusão física.
- A exclusão física do usuário é bloqueada enquanto houver membership (`ON DELETE RESTRICT`). Transferência de ownership ou encerramento antes da exclusão ainda não tem fluxo definido.
- Suspensão e eventos de segurança invalidam autorização offline. Uma autorização offline não transforma um command em registro oficial.
