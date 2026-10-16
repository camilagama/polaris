---
status: accepted
---

# Admin: login pelo Cloudflare Access, principal de plataforma e capacidades

## Contexto

A Fase 9 cria o Admin: a aplicação de quem opera o Polaris (não de um cliente). Ela pode, nas etapas seguintes, ler dados de organizações, revelar dados pessoais, operar cobrança e suspender contas, então a pergunta "quem é essa pessoa e o que ela pode" precisa ter uma resposta que não dependa de um cabeçalho, de um e-mail digitado ou de uma configuração esquecida. O Admin não compartilha sessão com o ERP (arquitetura) e o Cloudflare Access fica na frente, mas uma proteção só na borda deixaria o Worker aceitando qualquer pedido que chegasse por outro caminho (um endereço `workers.dev`, um erro de roteamento).

## Decisão

- **O Worker verifica o token do Access em todo pedido à API** (`apps/admin/src/access-jwt.ts`): assinatura RS256 contra as chaves publicadas pelo time (`/cdn-cgi/access/certs`, em cache de cinco minutos; renovadas quando o token cita uma chave desconhecida, no máximo uma vez por minuto; uma só busca por vez, com limite de três segundos; se a renovação falha, as últimas chaves seguem valendo por até uma hora e a nova tentativa espera dez segundos), emissor exato, audiência da aplicação, janela de validade (com 30 s de tolerância), `sub` presente e tipo `app` e sem `common_name` (um token de serviço, que traz um nome comum em vez de uma pessoa, não é um operador). Só RS256 é aceito: nunca `none` nem algoritmo de segredo compartilhado. O cabeçalho que apenas diz o e-mail do usuário nunca é usado.
- **Falha fechada.** Sem `ACCESS_TEAM_DOMAIN` (que precisa ser `<time>.cloudflareaccess.com`), `ACCESS_AUDIENCE` ou o Hyperdrive, toda requisição à API recebe 503 em vez de rodar sem verificação. Sem chaves alcançáveis e sem cópia recente delas também (503, não "login inválido"). `workers_dev` e as URLs de prévia ficam desligadas no `wrangler.jsonc`.
- **Principal de plataforma** (`platform_principals`): identificado pelo **emissor e subject** do Access (único por par); o e-mail é só um rótulo (`email_snapshot`), nunca acha nem autoriza ninguém. Papel (`platform_owner` na V1) e estado (`active` ou `disabled`) validados no banco. Um login válido que não é um principal recebe 403 sem dizer por quê. **Quem cria principais é o dono do banco** (passo de runbook): o papel do Admin lê, atualiza o rótulo e a última vez visto (a cada cinco minutos no máximo, ou na hora se o e-mail mudou) e não cria, apaga nem muda papel, estado, emissor ou subject.
- **Papel de banco próprio** (`polaris_admin_runtime`, grupo sem login; o login do Admin é membro): sem privilégio em tabela de tenant, de autenticação, de cobrança nem no catálogo, e nenhum papel de tenant lê os principais. As próximas etapas dão a esse papel apenas o que cada caso de uso exige (casos de suporte, acesso temporário com RLS, auditoria), e o Biome e as fixtures de fronteira recusam ao app qualquer outro caminho ao banco.
- **Motor de capacidades de plataforma** (`@polaris/domain/admin/platform-capabilities`): capacidades nomeadas (`platform:read`, `organization:diagnose`, `support_case:manage`, `tenant_access:grant`, `pii:reveal`, `billing:operate`, `organization:suspend`, `privacy_case:manage`) mapeadas por papel, separadas das do tenant (um papel de tenant não tem nenhuma delas e vice-versa). Cada rota pede uma capacidade nomeada; nenhum caso de uso compara o papel pelo nome. Papel desconhecido não tem capacidade nenhuma.
- **Respostas.** Todas com `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` e `Referrer-Policy: no-referrer`; `/health` responde sem login e não diz nada da plataforma; o motivo de uma recusa de token vai só ao registro do operador (nunca o token nem o e-mail).

## Consequências

- Roubar o acesso ao Admin exige um login do Access válido **e** uma linha em `platform_principals` para aquele subject; trocar o e-mail no provedor de identidade não leva a nada.
- Desativar um operador é um UPDATE do dono do banco e vale no pedido seguinte.
- O custo é uma consulta ao banco por pedido (uma linha pelo índice único) e uma busca das chaves a cada cinco minutos por isolate.

## Limites aceitos

- Sem MFA aplicado pelo Worker: o MFA obrigatório é uma política do Access (runbook); o Worker só verifica o token que o Access emitiu.
- Um token roubado vale até expirar (a duração da sessão do Access é configurada lá).
- O isolate guarda as chaves em memória; várias instâncias buscam cada uma a sua.
- Não há tela do Admin ainda (só `/api/whoami`); casos de suporte, acesso temporário, revelação de dados pessoais, comandos de cobrança e suspensão são as próximas etapas da fase.

## Alternativas rejeitadas

- **Confiar só no Access da borda:** um caminho que não passe por ele (um `workers.dev`) abriria o Admin.
- **Achar o operador pelo e-mail:** o e-mail muda e é reutilizável; o subject do emissor é a identidade estável.
- **Criar o principal no primeiro login:** qualquer pessoa que o Access deixasse entrar viraria operador.
- **Reusar o Better Auth do ERP:** mistura as duas populações (clientes e operadores) e as sessões.
