# Email de autenticação via Resend

O PR15 envia links de verificação e recuperação com Resend e templates React Email sem imagens. Os callbacks são síncronos, limitados a 10 segundos e usam uma chave de idempotência derivada por SHA-256 do token; o token original aparece apenas no link enviado e não é registrado em logs. As respostas do provider não são devolvidas ao usuário.

A validação e o hash/verify normalizam NFC. O hasher mantém os parâmetros Scrypt e o formato `salt:key` usado pela versão Better Auth aprovada; preserve ambos ao atualizar a dependência.

## Configuração futura

1. Verifique no Resend o domínio que será usado no `from`.
2. No diretório `apps/web`, execute `bunx wrangler secret put RESEND_API_KEY` e informe a chave no prompt oculto. Não a coloque no `wrangler.jsonc`, `.dev.vars` versionado ou código.
3. Configure `AUTH_EMAIL_FROM` com um endereço pertencente ao domínio verificado. `AUTH_EMAIL_REPLY_TO` é opcional e deve ser uma caixa monitorada.
4. `EMAIL_PASSWORD_AUTH_ENABLED` está definido como `false` no Wrangler local. Mantenha-o desligado até o PR16 habilitar rate limiting e Turnstile e até o sender estar configurado.
5. Antes de enviar a usuários reais, revise a política de privacidade e os termos/DPA do Resend: o provider processará destinatários, links de verificação/reset e metadados de entrega.

Os testes usam callbacks fake e fetch mockado. Não enviam mensagens reais. O PR15 não adiciona outbox/Cloudflare Queue nem webhooks duráveis; a proposta inicial de entrega durável fica adiada para hardening pré-go-live. A entrega direta idempotente pode ser tentada novamente, mas não é uma outbox persistente.
