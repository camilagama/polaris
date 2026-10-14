---
status: accepted
---

# Separar autenticação de acesso à organização

Better Auth é responsável por autenticação e sessões; organizações, memberships, capabilities, billing e entitlements são dados do domínio Polaris. A organização indicada pelo cliente é apenas contexto solicitado; o servidor valida acesso antes de aplicar RLS transaction-local. Isso impede que o provider de identidade vire autoridade sobre a tenancy comercial.
