# Organização e acesso

- A organização é dona do catálogo, estoque, clientes, vendas e registros operacionais. Usuário e organização são entidades diferentes.
- No onboarding V1, uma regra de domínio limita o usuário a uma organização; o modelo de membership permite múltiplas organizações no futuro.
- A criação de organização exige email verificado e valida essa condição no servidor; ver [authentication.md](authentication.md).
- A combinação organização/usuário identifica um membership. O único papel tenant usado inicialmente é owner; autorização é verificada por capabilities.
- Os estados de organização são active, suspended e closed. Estados de billing como free, trialing e past_due não são estados da organização.
- A criação da organização, do membership owner e dos defaults é uma operação idempotente. Retry após resposta perdida não pode criar uma segunda organização.
- O ID de organização enviado pelo cliente é contexto solicitado, nunca prova de autorização. O servidor valida autenticação, membership e capability antes de aceitar a operação.
- Suspensão e eventos de segurança invalidam autorização offline. Uma autorização offline não transforma um command em registro oficial.
