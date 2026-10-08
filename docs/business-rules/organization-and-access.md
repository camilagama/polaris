# Organização e acesso

- A organização é dona do catálogo, estoque, clientes, vendas e registros operacionais. Usuário e organização são entidades diferentes.
- No onboarding V1, uma regra de domínio limita o usuário a uma organização; a chave de membership é `(organization_id, user_id)` e o modelo permite múltiplas organizações no futuro.
- A criação de organização exige email verificado e valida essa condição no servidor; ver [authentication.md](authentication.md).
- A criação V1 começa com membership `owner` e `active`; o banco limita os valores atuais a esses estados até uma migration adicionar novos valores. Autorização é verificada por capabilities, não pelo papel informado pelo cliente.
- Os estados de organização são `active`, `suspended` e `closed`. Estados de billing como `free`, `trialing` e `past_due` não são estados da organização.
- A V1 opera em BRL. Cada organização tem timezone IANA confirmado no onboarding; o servidor valida esse valor, enquanto instantes técnicos são UTC.
- A criação da organização, do membership owner e dos defaults é uma operação idempotente. Retry após resposta perdida não pode criar uma segunda organização; a regra V1 de uma organização por usuário também precisa resistir a requests concorrentes.
- O ID de organização enviado pelo cliente é contexto solicitado, nunca prova de autorização. O servidor valida autenticação, membership e capability antes de aceitar a operação.
- A exclusão física da organização remove seus memberships por cascade no banco. Isso não define política de exclusão/retention de dados; o estado `closed` continua distinto da exclusão física.
- A exclusão física do usuário é bloqueada enquanto houver membership (`ON DELETE RESTRICT`). Transferência de ownership ou encerramento antes da exclusão ainda não tem fluxo definido.
- Suspensão e eventos de segurança invalidam autorização offline. Uma autorização offline não transforma um command em registro oficial.
