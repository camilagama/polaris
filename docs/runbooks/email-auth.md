# Email de autenticação via Resend

O PR15 envia links de verificação e recuperação com Resend e templates React Email sem imagens. Os callbacks são síncronos, limitados a 10 segundos e usam uma chave de idempotência derivada por SHA-256 do token; o token original aparece apenas no link enviado e não é registrado em logs. As respostas do provider não são devolvidas ao usuário.

A validação e o hash/verify normalizam NFC. O hasher mantém os parâmetros Scrypt e o formato `salt:key` usado pela versão Better Auth aprovada; preserve ambos ao atualizar a dependência.

## Configuração futura

1. Verifique no Resend o domínio que será usado no `from`.
2. No diretório `apps/web`, execute `bunx wrangler secret put RESEND_API_KEY` e informe a chave no prompt oculto. Não a coloque no `wrangler.jsonc`, `.dev.vars` versionado ou código.
3. Configure `AUTH_EMAIL_FROM` com um endereço pertencente ao domínio verificado. `AUTH_EMAIL_REPLY_TO` é opcional e deve ser uma caixa monitorada.
4. `EMAIL_PASSWORD_AUTH_ENABLED` está definido como `false` no Wrangler local. Mantenha-o desligado até o PR16 habilitar rate limiting e Turnstile e até o sender estar configurado. Exceção: o staging o liga desde 22/10/2026, sem Turnstile (ADR 0097, emenda); lá as rotas de senha respondem 503 até o Turnstile existir.
5. Antes de enviar a usuários reais, revise a política de privacidade e os termos/DPA do Resend: o provider processará destinatários, links de verificação/reset e metadados de entrega.

## Desligar a senha no staging

- **Imediato, sem deploy:** `wrangler secret delete RESEND_API_KEY --env staging` (em `apps/web`). Sem a chave, `isEmailPasswordAuthEnabled` dá falso e `GET /api/auth-methods` volta `emailPassword: false`; a tela de entrada deixa de mostrar o formulário. Confira com `curl -fsS https://dash.araute.app/api/auth-methods`; com o Turnstile ligado ele volta `"emailPassword": true` antes e `false` depois; a prova extra de que a chave saiu é o 503 `auth_email_unavailable` do cadastro. A chave do Resend é uma só por Worker: apagá-la desliga a senha **e** os avisos de encerramento juntos, e tira o envio de qualquer e-mail do Resend por esse Worker (os de cobrança e as boas-vindas também, [seção própria](#e-mails-de-cobrança-e-dmarc)) ([avisos-de-encerramento](./avisos-de-encerramento.md)). Para ligar de novo, recrie a chave ([staging](./staging.md#5-segredos-do-worker-polaris-web-staging-responsável)).
- **Permanente:** `EMAIL_PASSWORD_AUTH_ENABLED: "false"` em `env.staging.vars` de `apps/web/wrangler.jsonc`, por pull request (vale depois do deploy do staging). `verify:staging-isolation` aceita `"false"` sem exigir remetente, mas ainda recusa remetente ou responder-para fora de `@araute.app`.
- `emailPassword` também fica `false` enquanto a proteção contra abuso não está pronta (flag `AUTH_ABUSE_PROTECTION_ENABLED`, as duas chaves do Turnstile e os limitadores); as rotas de senha continuam respondendo 503 como barreira do servidor ([auth-abuse-protection](./auth-abuse-protection.md)).

## E-mails e links do P8

Com a flag ligada, o Worker envia estes e-mails. Os de verificação e de redefinição levam o link para a página do app com o token no fragmento (`/confirmar-email#token=` e `/redefinir-senha#token=`); o de desbloqueio leva a `/desbloquear#token=`. O link do Better Auth, com o token no caminho ou na consulta, nunca é usado. Os de "você já tem conta" (`/entrar`), de aviso de troca ou definição de senha (`/esqueci-a-senha`) não têm token.

- Chave de idempotência por tipo e token (SHA-256), e no caso de "você já tem conta" por usuário e dia.
- O e-mail de desbloqueio sai em segundo plano, só para conta com senha, uma vez por trava.
- Falha do Resend: o Worker registra `auth_email_delivery_failed` com o tipo do e-mail, a classe do erro, sem endereço, token nem corpo, e a resposta da tela não muda.
- Antes de cada e-mail de verificação o Worker grava em `user.verification_link_expires_at` o fim do link (24 horas, relógio do banco); se a gravação falha (banco lento, linha já apagada), o e-mail não sai, a resposta da tela não muda e o Worker registra `auth_verification_link_record_failed` (classe do erro e SQLSTATE, sem endereço nem ID). O Worker engole o erro, então o evento não aparece em `server_error` nem no sinal [erros-de-banco](./alertas.md#erros-de-banco): ele só existe nos Workers Logs. Quem não recebeu o e-mail pede o reenvio.
- Teto do reenvio: a gravação só casa enquanto o usuário tem menos de 72 horas de criado (`created_at`, relógio do banco). Depois disso o Worker não grava, não envia e a resposta é a mesma (anti-enumeração); isso não é falha e não gera `auth_verification_link_record_failed`. O último link válido vence no máximo 96 horas depois da criação, e o job `auth.unverified_user_purge` apaga o cadastro na execução horária seguinte ([ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md), P10).

## Ordem de implantação da gravação do link e alerta antes da flag da senha

- **A migration 0094 vai ao banco antes do Worker.** Worker novo sem a 0094 = nenhum e-mail de verificação sai: a coluna `user.verification_link_expires_at` não existe (SQLSTATE 42703) e só o evento `auth_verification_link_record_failed` fica no log, sem erro para a pessoa. O Worker antigo sobre o banco novo ainda reenvia, sem gravar a data (janela desprezível com a flag da senha desligada). Se o número da migration mudar no merge, o snapshot e o `_journal.json` mudam juntos.
- **Antes de ligar `EMAIL_PASSWORD_AUTH_ENABLED`:** o evento `auth_verification_link_record_failed` é o sinal [`link-de-verificacao`](./alertas.md#link-de-verificacao) do registro de `packages/observability/src/alerts.ts` (1 ocorrência em 24 horas; `warning`, só no resumo diário). O registro é a definição: ainda não há cron de alertas que a leia (Fase 14, [ADR 0095](../adr/0095-onde-os-alertas-operacionais-vao-rodar.md)), então, enquanto não houver, o responsável confere a consulta à mão nos Workers Logs do Worker (Observability → Query, `event = "auth_verification_link_record_failed"`, janela de 24 horas) depois de cada deploy e nos primeiros dias com a senha ligada. Cada ocorrência é um cadastro sem e-mail de verificação (o item 23 do [checklist de release](./release-checklist.md) cobra isso).

Os testes usam callbacks fake e fetch mockado. Não enviam mensagens reais. O PR15 não adiciona outbox/Cloudflare Queue nem webhooks duráveis; a proposta inicial de entrega durável fica adiada para hardening pré-go-live. A entrega direta idempotente pode ser tentada novamente, mas não é uma outbox persistente.

## E-mails de cobrança e DMARC

Vale para os 10 modelos de e-mail do ciclo de cobrança e as boas-vindas (`apps/web/src/server/billing/emails/`), enviados pelo consumidor de `billing.notice` ([ADR 0104](../adr/0104-autosservico-de-cobranca-do-dono.md), decisão 7 e emenda do consumidor; `apps/web/src/server/billing/notice-consumer.ts`). O que vai ao provedor e por quanto tempo o aviso fica gravado está em [privacidade](../business-rules/privacy.md). Hoje nada disto está ligado: `BILLING_SELF_SERVICE_ENABLED` e `WELCOME_EMAIL_ENABLED` estão `"false"` e `BILLING_SUPPORT_EMAIL` está vazia nos três blocos de `apps/web/wrangler.jsonc`. O que depende do P48 fica com marcador (`[P48: domínio de produção]`, `[P48: caixa de suporte de produção]`, `[P48: e-mail do encarregado]`, `[P48: razão social]`) e **nunca** com valor inventado; nenhum valor de produção (domínio, endereço, registro de DNS, cabeçalho com endereço, captura de tela) entra neste repositório, que é público até o lançamento. O rodapé já traz, no código, uma identificação provisória do fornecedor (`BILLING_EMAIL_SUPPLIER`); ela não é repetida aqui.

### O que cada chave faz

O e-mail de cobrança só sai com **todas** as peças abaixo (`billingNoticeEmailConfig` e `billingNoticeDependenciesOf`); com uma faltando, o aviso não sai e fica `skipped: email_not_configured`, e o Worker registra `billing_notice_email_misconfigured` (nível `warn`, `email = billing` ou `welcome`) quando a chave está ligada e a configuração está incompleta.

| Peça | O que é | Sem ela |
| --- | --- | --- |
| `RESEND_API_KEY` | segredo do Worker, **uma só por Worker** | nenhum e-mail do Resend sai: senha, avisos de encerramento, cobrança e boas-vindas |
| `AUTH_EMAIL_FROM` | remetente, num domínio verificado no Resend (`[P48: domínio de produção]`) | o aviso não sai |
| `BILLING_SUPPORT_EMAIL` | **um** endereço (nunca lista), o da caixa do rodapé e do `reply-to` (`[P48: caixa de suporte de produção]`) | o aviso **não sai** (não sai "sem `reply-to`"): vazia ou inválida desliga cobrança e boas-vindas |
| `BETTER_AUTH_BASE_URL` | a origem do link do botão (`https`, ou `http` só em `localhost` e `127.0.0.1`) | o aviso não sai |
| `AUTH_HYPERDRIVE` | a conexão que lê o endereço do dono | o aviso não sai |
| `BILLING_SELF_SERVICE_ENABLED` | só o texto exato `true`; liga, **juntos**, a página da assinatura, `billing.readPlan`, os comandos do dono (cancelar a renovação, desistir, pagar a pendente) e os e-mails de cobrança (`apps/web/src/server/billing/self-service.ts`) | cobrança `skipped: email_not_configured`, e o dono fica sem a página e sem os comandos |
| `WELCOME_EMAIL_ENABLED` | só o texto exato `true`; liga a varredura horária das boas-vindas e o e-mail delas | a varredura nem grava a linha (ADR 0104, decisão 6) |

### Ordem de ligar

O ADR 0104 (decisão 1) só deixa `BILLING_SELF_SERVICE_ENABLED` ir a `"true"` em produção depois do Gate 7, do PR D-admin na `main` e da P48 completa. Dentro disso, **nesta ordem**, e o que acontece se faltar cada passo:

1. **Remetente verificado**: o domínio criado no Resend, com SPF e DKIM verificados (seção seguinte), `RESEND_API_KEY` e `AUTH_EMAIL_FROM` no Worker. Faltando a chave ou o `AUTH_EMAIL_FROM`, os avisos saem `skipped: email_not_configured`. Com a chave e o remetente no Worker e o **domínio não verificado** no Resend, o código não sabe disso: o Resend recusa (403, ou 422 `invalid_from_address`), o consumidor trata como falha a tentar de novo (`billing_notice_failed`, `outcome = "failure"`) e, 23 horas depois da primeira tentativa, o aviso vira `skipped: delivery_window_passed` (`notice-consumer.ts`; classificação em `closure-notice-email.tsx`, `refusedForGood`). Nos dois casos **o lojista paga e não recebe o comprovante**, e o aviso pulado não é reenviado quando a configuração for corrigida (o consumidor só relê o aviso ainda devido).
2. **`BILLING_SUPPORT_EMAIL` com uma caixa que alguém lê.** O rodapé diz "responda este e-mail ou escreva para" ela. Se estiver vazia ou inválida, nada sai (acima); se a caixa existe e ninguém a lê, o aviso sai e a dúvida do lojista cai no vazio (isto o código não confere: é verificação de quem liga). Os e-mails que o suporte enviar dessa caixa também passam pelo DMARC (seção seguinte).
3. **DMARC em aplicação em produção:** a etapa 2 (`p=quarantine`) ou a 3 (`p=reject`) em vigor, depois dos 14 dias e das 20 mensagens da etapa 1. É o mínimo que o desenho exige para cobrar (ADR 0104, decisão 1; Rodrigo, 28/10/2026); os 14 dias da etapa 2 correm daí em diante e se cumprem antes de ir a `reject`. O código não confere o DMARC. Sem ele, o comprovante pode ir para o spam ou ser recusado, e o lojista também não o recebe.
4. **A versão do Worker com a página da assinatura, os comandos e o consumidor** (ADR 0104, decisão 1: PRs E, E2 e G na `main`), **e o PR D-admin na `main`**. O botão de todo e-mail de cobrança leva à página da assinatura (`/subscription`), a mesma que a chave liga: numa versão sem ela, o botão leva a lugar nenhum.
5. **A razão social definitiva** (`[P48: razão social]`), em dois passos separados, porque são duas fontes e trocar só uma deixa a outra com o nome antigo (ADR 0104): (a) no código, a constante `BILLING_EMAIL_SUPPLIER` em `billing-notice-email.tsx`, que é o rodapé dos e-mails; (b) nos Termos, a variável `VITE_LEGAL_RAZAO_SOCIAL` do build (`vars` do GitHub Actions; o passo do workflow de produção ainda não existe).
6. **Com Pix, o roteiro do operador** (ADR 0104, decisão 8).
7. **A prova no staging, no Gate 7** (passo do Diego, **BLOQUEADO**, não falho, até o Gate 7 chegar): ligar as chaves no staging, receber um e-mail real de cobrança e conferir os cabeçalhos ("Conferir num e-mail real"). Repita a conferência no primeiro e-mail de produção, depois de ligar.
8. **Só então** a chave em produção.

As boas-vindas têm chave própria e as mesmas peças; o código não exige o DMARC para elas (a chave é independente), mas o [checklist de release](./release-checklist.md) só as deixa ligar com a base legal confirmada (decidida em 28/10/2026: LGPD, art. 7º, V, só enquanto o texto for informativo de uso; [privacidade](../business-rules/privacy.md)), com o consumidor no ar e com a P48, que inclui o DMARC em aplicação.

**O domínio de e-mail precisa existir pelo menos 15 dias antes do Gate 7**: os 14 dias da etapa 1 (`p=none`) mais um, para que a etapa 2 já esteja em vigor no Gate 7 (Rodrigo, 28/10/2026; é palpite, revisar depois do primeiro mês de relatório real).

### SPF e DKIM do domínio do remetente

- No painel do Resend, o domínio do remetente só vale quando os registros de SPF e de DKIM aparecem como verificados (os nomes e valores são os que o painel mostra para aquele domínio; **não os cole aqui nem em issue, PR ou comentário**).
- Para conferir fora do painel, consulte no DNS público os mesmos nomes que o painel lista e compare com ele, sem copiar o resultado para o repositório.
- O alinhamento que conta para o DMARC é o do **DKIM** (`header.d` igual ao domínio do `From`). O SPF do Resend costuma ser do subdomínio de retorno, não do `From`, então não conte com o alinhamento do SPF (Rodrigo, 28/10/2026; **não verificado** contra a documentação do Resend nem no domínio real).

### DMARC em etapas

O registro é um TXT em `_dmarc.<domínio do remetente>` (`[P48: domínio de produção]`), da forma `v=DMARC1; p=<etapa>; rua=mailto:<caixa que alguém lê>`. **Só `rua`, nunca `ruf`**: o relatório forense traz o conteúdo e endereços de mensagens, dado pessoal que não precisamos. A caixa do `rua` é uma que alguém lê (`[P48: domínio de produção]`), de acesso restrito (o relatório traz IPs de origem); se ela estiver em outro domínio, esse domínio precisa autorizar o recebimento dos relatórios (RFC 7489, seção 7.1), ou eles não chegam.

| Etapa | Registro | Mínimo | Avança quando | Volta quando |
| --- | --- | --- | --- | --- |
| 1 | `p=none` com `rua` | 14 dias **e** 20 mensagens legítimas avaliadas | 100% das mensagens legítimas do Resend com `dmarc=pass` **pelo DKIM alinhado** | (não há etapa antes) |
| 2 | `p=quarantine`, `pct=100` | 14 dias **e** 20 mensagens legítimas avaliadas | nenhuma mensagem legítima reprovada no período | qualquer mensagem legítima reprovada: volta à etapa 1 |
| 3 | `p=reject` | começa depois dos 14 dias de `quarantine` | (etapa final) | qualquer mensagem legítima reprovada: volta à etapa 2 |

- **`quarantine` é o mínimo para ligar a cobrança** (ADR 0104; desenho t268, §10). `reject` é a etapa final.
- **Antes de avançar, liste todo remetente legítimo do domínio**, não só o Resend: a caixa de suporte (`BILLING_SUPPORT_EMAIL` é o `reply-to`, então o suporte responde de lá) e qualquer outro sistema que envie em nome do domínio. Cada um precisa passar pelo DMARC, por SPF ou DKIM alinhado; sob `quarantine` ou `reject`, o que não passa cai no spam ou é recusado, e a resposta do suporte ao lojista se perde.
- **Volume baixo:** antes do go-live o volume é pequeno e um relatório sem volume não prova nada. Se a etapa não chegar a 20 mensagens, ela continua; quem opera decide e registra se passa de 30 dias.
- **Mudar de etapa ou voltar** é trocar o valor do registro. **Baixe o TTL** do TXT (300 a 3600 s) **antes** de começar e espere o TTL antigo passar antes de trocar a etapa.
- **Ler um relatório sem expor endereço:** o relatório agregado (`rua`) é um XML com os IPs de origem e as contagens por resultado, sem endereço de destinatário. Leia resumindo em contagens: total de mensagens, quantas com `dkim=pass` e `dmarc=pass`, quantas reprovadas e de que origem (a do Resend ou uma desconhecida). **Nunca cole o XML** em repositório, issue, PR ou comentário; só a contagem e o veredito de cada dia entram no registro do Gate 7.
- Uma origem desconhecida que envia como o domínio pode ser um remetente legítimo esquecido (veja a lista acima) ou uma falsificação: identifique antes de avançar.
- Os números (14 dias, 20 mensagens) foram decididos pelo Arrascaeta em 28/10/2026 com o parecer do Rodrigo e são **dado fraco**, sem base de uso: revisar depois do primeiro mês de relatório real.

### Conferir num e-mail real

No staging, com o Gate 7, o Diego envia um e-mail de cobrança a uma caixa de teste e abre o original da mensagem (no Gmail, "Mostrar original"). Procure no cabeçalho `Authentication-Results` e confirme `dkim=pass`, `spf=pass` e `dmarc=pass`, com o `header.d` do DKIM igual ao domínio do `From`. **Registre só os três veredictos e a data**: sem o endereço do destinatário nem do remetente, sem o cabeçalho inteiro, **sem captura de tela nem trecho do cabeçalho** em issue, PR ou comentário. Estado hoje: **não verificado**, pois só se prova no domínio real (P48); o passo está BLOQUEADO até o Gate 7.

### Rastreio de abertura e de clique

- No código: os modelos não têm imagem, pixel nem parâmetro de campanha, e a chamada ao Resend não envia campo de rastreio (`billing-notice-email.tsx`; `closure-notice-email.tsx`, `createResendClosureNoticeSender`).
- No provedor: abertura e clique ficam **desligados** nas configurações do domínio do remetente no painel do Resend (confira que as duas opções aparecem desligadas; os nomes dos controles não foram verificados contra o painel).
- No e-mail recebido: abra o original e confira que não há `<img` e que o endereço do botão é igual ao que o texto escreve em "Se o botão não funcionar, abra este endereço". Link reescrito para outro domínio quer dizer rastreio de clique ligado.
- **Não verificado** no domínio real; BLOQUEADO até o Gate 7.

### Quando o e-mail volta com erro

- **Eventos nos Workers Logs** (tipo, resultado, motivo, IDs opacos e, quando o provedor respondeu, o status HTTP e o código curto de erro dele; nunca endereço, nome da loja nem valor): `billing_notice_failed` (nível `error`; `outcome = "failure"` quando o provedor não respondeu ou recusou por chave, remetente, domínio ou cota, e a fila tenta de novo; `outcome = "rejected"` quando recusou o endereço, e o aviso fica `failed` com o código `email_rejected`, sem nova tentativa), `billing_notice_delivery_window_passed` (nível `error`: um aviso devido que não saiu em 23 horas da primeira tentativa vira `skipped: delivery_window_passed`), `billing_notice_email_misconfigured` (nível `warn`: chave ligada com configuração incompleta, a falha mais provável), `billing_notice_skipped` (com o motivo) e `billing_notice_sent`. A classificação das respostas do provedor é a do [aviso de encerramento falhando](./alertas.md#aviso-de-encerramento-falhando), porque o remetente é o mesmo.
- **Não há alerta** para falha de envio de aviso de cobrança: o registro de `packages/observability/src/alerts.ts` não tem sinal para `billing_notice_*` (só o de `closure_notice_email_failed`, do encerramento). O ADR 0104 e o código preveem o alerta de `delivery_window_passed`; ele ainda não existe no registro. Só o sinal [`dlq`](./alertas.md#dlq) pega, de lado, uma falha que persiste até a fila morta (3 ocorrências em 60 minutos). Uma recusa de endereço, um domínio não verificado e uma janela de 23 horas vencida **não alertam**: até haver sinal, quem opera confere à mão, a cada deploy e nos primeiros dias com a chave ligada, `event = "billing_notice_failed"`, `event = "billing_notice_delivery_window_passed"` e `event = "billing_notice_email_misconfigured"` nos Workers Logs (janela de 24 horas). Item aberto, sem sinal registrado; dono: Filipe.
- **Banco, só leitura**, seguindo a [política de perfis de CLI](./cli-profile-policy.md): `SELECT kind, failure_code, skipped_reason, count(*) FROM billing_notices WHERE recorded_at > now() - interval '24 hours' GROUP BY 1, 2, 3`. A tabela não guarda endereço. Falha de envio é a linha com `failed_at` preenchido; um grupo grande de `skipped_reason = 'email_not_configured'` é configuração incompleta.

### Desligar

Atenção, vale para todos os caminhos: com o e-mail desligado, cada aviso devido que o consumidor processa vira `skipped: email_not_configured`, **definitivo** (a consulta dos avisos devidos só traz os sem envio, falha nem motivo). Nada é reenviado quando o e-mail volta. A gravação do aviso não depende da chave (ADR 0104, emenda do consumidor), então a cobrança segue e **o lojista não é avisado**.

- **Só as boas-vindas:** `WELCOME_EMAIL_ENABLED` = `"false"` em `apps/web/wrangler.jsonc`, por pull request (vale depois do deploy, como a da senha). A varredura para de gravar a linha; as boas-vindas já gravadas e ainda devidas saem `skipped: email_not_configured`. Ligar de novo **não manda atrasadas** (ADR 0104, decisão 6), e quem teve a linha pulada não recebe depois (uma boas-vindas por pessoa).
- **Cobrança:** `BILLING_SELF_SERVICE_ENABLED` = `"false"` desliga os e-mails **e também a página da assinatura, `billing.readPlan` e os comandos do dono**: o lojista fica sem cancelar a renovação, desistir ou pagar a pendente por conta própria, e o suporte precisa atender isso à mão enquanto estiver desligado (o procedimento não está neste runbook). A janela de desistência de 7 dias continua correndo (ADR 0104). Os avisos perdidos são todos os do ciclo: o comprovante, a véspera da primeira cobrança, o lembrete anual, a falha da renovação, o fim do acesso, a renovação cancelada e a devolução.
- **Só o e-mail de cobrança, mantendo a página:** não há chave própria. Esvaziar `BILLING_SUPPORT_EMAIL` (por pull request) o desliga, mas também desliga as boas-vindas, pois a caixa é a mesma, e perde os mesmos avisos.
- **Imediato, sem deploy:** `wrangler secret delete RESEND_API_KEY --env <staging|production>` no Worker, depois de confirmar o perfil e a identidade pela [política de perfis de CLI](./cli-profile-policy.md). A chave é uma só, então isso desliga **também** a senha e os avisos de encerramento (veja [Desligar a senha no staging](#desligar-a-senha-no-staging)), além dos e-mails de cobrança e das boas-vindas.
- **Tudo de uma vez:** as duas chaves em `"false"` por pull request e a chave do Resend apagada, para o efeito já. A prova: `billing_notice_skipped` com `reason = "email_not_configured"` nos Workers Logs, e `billingSelfService: false` na resposta de `organization.listMine`.
- **Retomar:** recoloque a chave do Resend e as chaves em `"true"`, faça o deploy e confira que o aviso `billing_notice_email_misconfigured` não aparece. Vale a mesma ordem de ligar acima; só os avisos gravados dali em diante saem.

### Lacunas que dependem do P48

- `[P48: domínio de produção]`: o domínio do remetente, os registros de SPF, DKIM e DMARC e a caixa do `rua`.
- `[P48: caixa de suporte de produção]`: o valor de `BILLING_SUPPORT_EMAIL`.
- `[P48: e-mail do encarregado]`: o canal do titular para estes avisos ([privacidade](../business-rules/privacy.md)).
- `[P48: razão social]`: a identificação do fornecedor no rodapé (`BILLING_EMAIL_SUPPLIER` em `billing-notice-email.tsx`) e nos Termos (`VITE_LEGAL_RAZAO_SOCIAL`): são dois passos separados, e os dois mudam antes de ligar em produção (ADR 0104; passo 5 da ordem de ligar).
- Região e DPA do Resend (transferência internacional): a confirmar antes de enviar de verdade; não é P48.
- Revisão jurídica do texto: recomendada antes do go-live, sem bloquear.
