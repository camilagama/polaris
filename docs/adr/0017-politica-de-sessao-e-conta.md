---
status: accepted
---

# Política de sessão e de conta

## Contexto

O [ADR 0004](0004-separar-autenticacao-de-tenancy.md) separou autenticação de tenancy. Faltava registrar as escolhas de política de sessão e de conta tomadas ao implementar Better Auth (Google, e-mail/senha, vínculo de contas, sessões). Elas protegem contra tomada de conta e vazamento de credenciais e são difíceis de mudar depois que existem usuários reais. Os detalhes operacionais vivem em [authentication.md](../business-rules/authentication.md); este ADR guarda o motivo.

## Decisão

Registro retroativo das decisões tomadas nos PR13 a PR18 e confirmadas na revisão do checkpoint Gate 4 (13/10/2026):

- **Duração da sessão.** A sessão expira após 7 dias sem renovação (TTL por inatividade), com renovação no máximo a cada 24 horas de uso, e tem um **teto absoluto de 30 dias** desde a criação, imposto pelo Worker e por um trigger do banco que limita `expires_at` e mantém `created_at` imutável. O cache de sessão em cookie fica desativado, para que revogação e validade absoluta sejam sempre verificadas no servidor.
- **Sem vínculo implícito de contas.** Um login social nunca associa contas automaticamente. O vínculo Google exige sessão existente e verificada, iniciada por ação explícita do usuário, com e-mail verificado e igual nos dois lados; `trustedProviders` fica vazio e `idToken` enviado pelo cliente não cria vínculo.
- **Senhas.** Fator único com 15 a 128 pontos de código Unicode após NFC, sem regras de composição nem expiração periódica, e consulta ao corpus de senhas comprometidas (HIBP, k-anonymity com padding) ao criar ou alterar. A consulta é **fail-closed**: se não puder ser concluída, a senha não é aceita nem armazenada. Reset de senha revoga todas as sessões.
- **Tokens OAuth cifrados.** Os tokens do provider são cifrados pelo Better Auth em repouso e o `id_token` não é persistido.
- **Abuso.** Rotas públicas de autenticação exigem Turnstile validado no servidor e limites por IP (contadores aproximados por localidade, uma camada de contenção e não uma quota global). E-mail/senha permanece desligado até Turnstile, bindings, e-mail transacional e domínio de envio estarem configurados.
- **Auditoria de segurança** registra o ID interno do usuário e o tipo do evento, sem token, payload ou dados pessoais.

## Consequências

- Perder o dispositivo ou a senha tem janela de exposição limitada: no pior caso 30 dias, e a revogação é efetiva na próxima requisição.
- Usuários que dependem de um único provider não ganham vínculo automático; recuperar acesso passa por fluxos explícitos e verificados.
- Falha do serviço HIBP bloqueia criação e troca de senha, mas não o login; é um custo de disponibilidade aceito em favor da segurança.
- Pendências conhecidas antes de ligar e-mail/senha em produção: o Worker deve usar o IP da borda (`cf-connecting-ip`) em vez de `X-Forwarded-For`, o contexto autenticado de `/rpc` deve conferir o teto absoluto da sessão e rate limits cobrem `change-password` e `verify-password`. Elas estão no checklist de go-live dos [runbooks](../runbooks/README.md).

## Alternativas consideradas

- **Sessão longa e deslizante sem teto.** Melhor ergonomia, mas uma sessão roubada nunca expira se continuar sendo usada.
- **Vínculo automático por e-mail verificado.** Reduz atrito, mas permite tomada de conta quando um provider reporta e-mail verificado de forma permissiva.
- **Regras de composição e troca periódica de senha.** Contrariam a orientação do NIST SP 800-63B-4 e pioram a qualidade das senhas.
- **HIBP fail-open.** Mantém o cadastro no ar durante a falha do serviço, mas aceitaria senhas comprometidas justamente quando a verificação não funciona.

## Emenda (19/10/2026, [ADR 0100](0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md))

O ADR 0100 registra a tela de entrada e fecha parte das pendências acima. Sem mudar nada do que está decidido neste ADR:

- **Rota e retorno.** O app ganha `/entrar`. O login social envia `callbackURL = /entrar?voltar=<destino codificado>` e `errorCallbackURL = /entrar?erro=google`, porque o Better Auth 1.6.23 recusa o destino inteiro codificado; `/entrar` valida o `voltar` de novo (caminho do app, sem caracteres de controle, `/api` nem `/rpc`, nunca `/entrar`) e um valor inválido vira `/`.
- **Limitador do login social.** `AUTH_SOCIAL_RATE_LIMITER` (20 por 60 s por IP) cobre o início e o callback do Google e não depende de `AUTH_ABUSE_PROTECTION_ENABLED`. O 429 do início devolve JSON `auth_rate_limited`; o 429 do callback devolve **302 `/entrar?erro=limite`**; sem o binding, 503.
- **Abuso.** O bloqueio por e-mail (5 falhas em 15 minutos travam por 15 minutos, contador no PostgreSQL) soma-se ao Turnstile e ao limite por IP nas rotas de senha. A tela diz "Entrada pausada".
- **Troca de senha.** `change-password` e `set-password` exigem sessão de até 15 minutos; a troca revoga as outras sessões e troca a época dos leases. A pendência de rate limits em `change-password` e `verify-password` continua no checklist de go-live.
- **E-mail e senha continua desligado** até haver domínio de envio verificado; a senha só liga pela flag, depois do P8 e do P9 do ADR 0100.

