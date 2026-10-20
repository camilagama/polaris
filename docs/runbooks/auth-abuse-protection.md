# Auth abuse protection

## Status

This runbook describes setup for the Turnstile and Workers Rate Limiting controls introduced in PR16. No Turnstile widget, secret, Cloudflare namespace, or live Worker was provisioned for this PR. `AUTH_ABUSE_PROTECTION_ENABLED` remains `false` by default.

## Before enabling

1. Create a Turnstile widget for each intended environment. Restrict its allowed hostnames to the exact hostname used by `BETTER_AUTH_BASE_URL`.
2. Keep the site key public and expose it to the auth UI as the Worker var `TURNSTILE_SITE_KEY`, read through `GET /api/auth-methods` (ADR 0100). Keep the secret key only in the Worker secret store.
3. Set the secret with `bunx wrangler secret put TURNSTILE_SECRET_KEY` in the intended Wrangler environment. Do not paste it into `wrangler.jsonc`, `.dev.vars`, CI logs, or this runbook.
4. Replace `namespace_id` values `901016` and `901017` in `apps/web/wrangler.jsonc` with integers confirmed unique for the Cloudflare account and environment. Do this before a remote deployment; these values are placeholders, not provisioned namespaces.
5. Set `AUTH_ABUSE_PROTECTION_ENABLED=true` only after the UI can render Turnstile and attach its token. Enable `EMAIL_PASSWORD_AUTH_ENABLED` only after Resend, its verified sender domain, and the UI are configured too.

## Request contract

The UI must obtain a fresh token for every protected request and send it in `x-turnstile-token`:

| Endpoint | Turnstile action | Additional email-send limit |
| --- | --- | --- |
| `POST /api/auth/sign-up/email` | `signup` | Yes |
| `POST /api/auth/sign-in/email` | `login` | No |
| `POST /api/auth/request-password-reset` | `password_reset_request` | Yes |
| `POST /api/auth/reset-password` | `password_reset` | No |
| `POST /api/auth/send-verification-email` | `verification_email` | Yes |

The Worker calls Siteverify and checks `success`, the exact action above, and the hostname derived from `BETTER_AUTH_BASE_URL`. The Worker does not send `CF-Connecting-IP` to Siteverify. Turnstile tokens expire after five minutes and can only be validated once; on a rejected or interrupted attempt, the UI must request a new token.

References: [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) and [Workers Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## Rate limits and limitations

- `AUTH_RATE_LIMITER` is configured for 10 requests per 60 seconds per client IP.
- `AUTH_EMAIL_RATE_LIMITER` is configured for 3 email-sending requests per 60 seconds per client IP.
- Keys are HMACs using the Turnstile secret; raw IP addresses are not passed as binding keys.
- Cloudflare's Workers Rate Limiting counters are local to a Cloudflare location and approximate. They reduce repeated requests reaching that location; they are not a synchronized global quota. Revisit distributed account-level protection before production if the risk assessment requires a global limit.

The general IP limiter runs before Siteverify to avoid spending verification calls after a request has exceeded its configured limit. The email-send limiter runs after a valid challenge, so an invalid token cannot consume another user's email-send allowance. A missing binding or binding error fails closed with HTTP 503; an exceeded counter returns HTTP 429.

## Google sign-in limiter

`AUTH_SOCIAL_RATE_LIMITER` (20 requests per 60 seconds per client IP, ADR 0017 and ADR 0100) covers `POST /api/auth/sign-in/social` and `/api/auth/callback/google`, which calls Google and writes `verification`. It has no Turnstile and does not depend on `AUTH_ABUSE_PROTECTION_ENABLED` or `EMAIL_PASSWORD_AUTH_ENABLED`: Google is on while the password is off.

- The key is an HMAC of the IP with `BETTER_AUTH_SECRET` and the scope `auth-social-ip`; the start and the callback of one IP share the same counter.
- Over the limit, the start answers HTTP 429 with the JSON `auth_rate_limited`. The callback is a browser navigation, so it answers **HTTP 302 to `/entrar?erro=limite`** instead of JSON, and the sign-in page shows the wait text, not the Google error. Both happen before Better Auth, so no state, token or session is read.
- It fails closed: a missing binding, a missing or invalid `cf-connecting-ip`, a binding error or an unreadable answer is HTTP 503 (`auth_rate_limit_unavailable`) on the start. The callback is a navigation, so there it is **HTTP 302 to `/entrar?erro=indisponivel`** (the sign-in page shows "Não conseguimos entrar agora. Tente de novo em instantes."), never JSON on the shopkeeper's screen.
- Namespace ids: `900020` (local), `902020` (staging) and `901020` (production), unique among the ids of `apps/web/wrangler.jsonc`. Like the other ids, they have to be confirmed unique in the Cloudflare account before a remote deployment. After the staging deploy, read the binding back under the staging profile of the [CLI profile policy](cli-profile-policy.md) and check the 20-per-60-seconds setting.
- The counters are local to a Cloudflare location and approximate, like the ones above. Shops behind the same IP (shared internet) share the 20, and a login spends two of them (the start and the callback).
- **Many devices behind the same IP (CGNAT, a shared store network, a mobile carrier).** The limit is 20 requests per minute **per IP**, and one login spends **2** of them, so at most about 10 logins a minute leave one IP. In a store with several phones opening the app at the same time (a shift change, a power cut that restarts every phone), the later ones meet the wait text ("Muitas tentativas em pouco tempo. Espere alguns minutos e tente de novo.") and the limit lifts by itself within the minute. Symptoms to look for: a wave of `auth_rate_limited` on the start, or of `/entrar?erro=limite` on the callback, from one IP, with no attack pattern (different users, normal rhythm). What to do: do not raise the limit on the first complaint; ask the store to space the logins by a minute; if it repeats for the same IP or carrier, raise `limit` in `AUTH_SOCIAL_RATE_LIMITER` for that environment in a pull request with the numbers seen (the namespace ids stay), and register the decision here.
- The callback is a GET that any page can trigger, so a hostile page can spend the 20 of a visitor's IP for 60 seconds; the person sees the wait text and the limit lifts by itself. This is the cost of a limit by IP that ADR 0100 accepts.
- `POST /api/auth/link-social` is not counted: it needs a verified session and the origin check, and the ADR lists only the start and the callback.

## Links dos e-mails e bloqueio da entrada (P8)

- `POST /api/login-unlock {token}` (desbloqueio) e `POST /api/email-verification {token}` (confirmação de e-mail) ficam fora de `/api/auth/*`, passam pelo `originCheck` e pelo limitador `AUTH_RATE_LIMITER` com escopo próprio `auth-link-ip` (HMAC do IP com `BETTER_AUTH_SECRET`). Não têm Turnstile, porque quem chega de um e-mail não tem o desafio. Sem binding, sem `cf-connecting-ip` válido ou com erro do binding, respondem 503 `auth_rate_limit_unavailable`; excedido, 429 `auth_rate_limited`. O limite é o do próprio binding (10 por 60 segundos por IP, como acima), sem configuração nova.
- Com `EMAIL_PASSWORD_AUTH_ENABLED` desligada, as duas rotas respondem 503 `auth_email_unavailable`, antes do limitador.
- `GET /api/auth/verify-email` e `GET /api/auth/reset-password/<token>` respondem 404 `not_found`: o token não vai na URL de um documento.
- Quando a entrada por senha está ligada, uma trava de e-mail responde 429 `auth_login_locked` com `retryAfterSeconds` e o cabeçalho `Retry-After`, igual exista a conta ou não. O registro de acesso guarda `login_failed` sem usuário nessa resposta. A trava não usa o limitador por IP: ela conta por e-mail digitado, no banco (`auth_login_lock`).
- As três rotas de senha (`POST /api/auth/sign-in/email`, `/change-password` e `/set-password`) só valem pelo caminho exato. Variação de caixa, `%2F`, barra no fim, sufixo ou prefixo parecido responde 404 `not_found`, sem chegar ao Better Auth: a trava não aposta no roteador dele. Corpo acima de 8 KiB nessas três rotas responde 413 `payload_too_large`, sem ler o JSON. `POST` com `verify-password` no caminho (qualquer grafia) responde 404.
- Eventos de auditoria novos desta etapa: `login_locked` (quando a trava começa e o e-mail de desbloqueio é enviado), `login_unlocked` (desbloqueio feito pelo link), `password_changed`, `password_set` e `password_reset_completed`. Os valores do enum vêm da migration P8a, em PR próprio.

## Verification and rollback

Before enabling password auth in a shared environment, verify from the deployed hostname:

- missing, invalid, expired, replayed, wrong-action, and wrong-hostname tokens are rejected before Better Auth;
- a valid token is accepted once, then rejected when replayed;
- exceeded IP and email-send counters return HTTP 429;
- Siteverify timeout/unavailability returns HTTP 503, with no request continuing to Better Auth;
- responses and logs contain no token, password, email body, IP address, or provider response payload.

To roll back email/password access, set `EMAIL_PASSWORD_AUTH_ENABLED=false`. Setting `AUTH_ABUSE_PROTECTION_ENABLED=false` while email/password auth is enabled blocks the protected operations by design.

Before production activation, update the privacy notice and review Cloudflare's applicable terms/data-processing settings for Turnstile. The authentication UI is not part of PR16, so do not enable these routes for users until the widget integration is delivered.
