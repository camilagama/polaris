# Email de autenticação via Resend

O PR15 envia links de verificação e recuperação com Resend e templates React Email sem imagens. Os callbacks são síncronos, limitados a 10 segundos e usam uma chave de idempotência derivada por SHA-256 do token; o token original aparece apenas no link enviado e não é registrado em logs. As respostas do provider não são devolvidas ao usuário.

A validação e o hash/verify normalizam NFC. O hasher mantém os parâmetros Scrypt e o formato `salt:key` usado pela versão Better Auth aprovada; preserve ambos ao atualizar a dependência.

## Configuração futura

1. Verifique no Resend o domínio que será usado no `from`.
2. No diretório `apps/web`, execute `bunx wrangler secret put RESEND_API_KEY` e informe a chave no prompt oculto. Não a coloque no `wrangler.jsonc`, `.dev.vars` versionado ou código.
3. Configure `AUTH_EMAIL_FROM` com um endereço pertencente ao domínio verificado. `AUTH_EMAIL_REPLY_TO` é opcional e deve ser uma caixa monitorada.
4. `EMAIL_PASSWORD_AUTH_ENABLED` está definido como `false` no Wrangler local. Mantenha-o desligado até o PR16 habilitar rate limiting e Turnstile e até o sender estar configurado.
5. Antes de enviar a usuários reais, revise a política de privacidade e os termos/DPA do Resend: o provider processará destinatários, links de verificação/reset e metadados de entrega.

## E-mails e links do P8

Com a flag ligada, o Worker envia estes e-mails. Os de verificação e de redefinição levam o link para a página do app com o token no fragmento (`/confirmar-email#token=` e `/redefinir-senha#token=`); o de desbloqueio leva a `/desbloquear#token=`. O link do Better Auth, com o token no caminho ou na consulta, nunca é usado. Os de "você já tem conta" (`/entrar`), de aviso de troca ou definição de senha (`/esqueci-a-senha`) não têm token.

- Chave de idempotência por tipo e token (SHA-256), e no caso de "você já tem conta" por usuário e dia.
- O e-mail de desbloqueio sai em segundo plano, só para conta com senha, uma vez por trava.
- Falha do Resend: o Worker registra `auth_email_delivery_failed` com o tipo do e-mail, a classe do erro, sem endereço, token nem corpo, e a resposta da tela não muda.
- Antes de cada e-mail de verificação o Worker grava em `user.verification_link_expires_at` o fim do link (24 horas, relógio do banco); se a gravação falha (banco lento, linha já apagada), o e-mail não sai, a resposta da tela não muda e o Worker registra `auth_verification_link_record_failed` (classe do erro e SQLSTATE, sem endereço nem ID). O Worker engole o erro, então o evento não aparece em `server_error` nem no sinal [erros-de-banco](./alertas.md#erros-de-banco): ele só existe nos Workers Logs. Quem não recebeu o e-mail pede o reenvio.
- Teto do reenvio: a gravação só casa enquanto o usuário tem menos de 72 horas de criado (`created_at`, relógio do banco). Depois disso o Worker não grava, não envia e a resposta é a mesma (anti-enumeração); isso não é falha e não gera `auth_verification_link_record_failed`. O último link válido vence no máximo 96 horas depois da criação, e o job `auth.unverified_user_purge` apaga o cadastro na execução horária seguinte ([ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md), P10).

## Ordem de implantação da gravação do link e alerta antes da flag da senha

- **A migration 0094 vai ao banco antes do Worker.** Worker novo sem a 0094 = nenhum e-mail de verificação sai: a coluna `user.verification_link_expires_at` não existe (SQLSTATE 42703) e só o evento `auth_verification_link_record_failed` fica no log, sem erro para a pessoa. O Worker antigo sobre o banco novo ainda reenvia, sem gravar a data (janela desprezível com a flag da senha desligada). Se o número da migration mudar no merge, o snapshot e o `_journal.json` mudam juntos.
- **Antes de ligar `EMAIL_PASSWORD_AUTH_ENABLED`:** criar o alerta no evento `auth_verification_link_record_failed` nos Workers Logs (alerta manual: o evento ainda não é um sinal do registro de `packages/observability/src/alerts.ts`); um pico significa cadastro sem e-mail de verificação (o item 23 do [checklist de release](./release-checklist.md) cobra isso).

Os testes usam callbacks fake e fetch mockado. Não enviam mensagens reais. O PR15 não adiciona outbox/Cloudflare Queue nem webhooks duráveis; a proposta inicial de entrega durável fica adiada para hardening pré-go-live. A entrega direta idempotente pode ser tentada novamente, mas não é uma outbox persistente.
