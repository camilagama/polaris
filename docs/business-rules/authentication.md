# Autenticação e credenciais

## Email e verificação

- Better Auth é responsável pela identidade e pelas sessões; o domínio Polaris continua responsável por organizações e acesso.
- Contas criadas com email/senha precisam verificar o endereço antes de obter uma sessão de email/senha. Endereços não verificados não podem criar organizações; a operação de criação também precisa validar essa precondição no servidor.
- Tokens de verificação e de recuperação são segredos de uso único: nunca registrar token, URL completa ou payload de email em logs/auditoria. Links de verificação expiram em 24 horas; links de reset expiram em 1 hora.
- Respostas de recuperação não podem revelar se um email existe.

## Senhas

- Para o fluxo de senha como fator único, aceitar de 15 a 128 pontos de código Unicode após normalização NFC. Espaços e caracteres Unicode são permitidos; a aplicação não trunca nem remove espaços.
- Não exigir combinações arbitrárias de maiúsculas, minúsculas, números ou símbolos; não exigir troca periódica. Uma senha comprometida deve ser substituída.
- Antes de armazenar ou alterar uma senha, verificar o valor inteiro contra o corpus de senhas comprometidas do HIBP Pwned Passwords. Calcular SHA-1 somente no Worker, enviar apenas o prefixo de cinco dígitos hexadecimais pelo endpoint k-anonymity com `Add-Padding: true`, comparar os sufixos localmente e nunca enviar a senha ou o hash completo.
- Se a consulta HIBP não puder ser concluída, rejeitar a criação/alteração da senha com erro temporário genérico. Não armazenar a senha sem a verificação.
- Não executar a consulta HIBP durante login: ela é necessária quando a senha é criada ou alterada, não em cada autenticação.
- Reset de senha revoga todas as sessões Better Auth do usuário.

A política de tamanho, Unicode, composição e expiração segue as recomendações de senhas do [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html). A consulta de senhas comprometidas segue a [API oficial Pwned Passwords](https://haveibeenpwned.com/API/v3). O limite máximo de 128 pontos de código é a escolha do produto e supera o mínimo de capacidade recomendado pelo NIST. O NIST também recomenda bloquear valores comuns, esperados ou específicos do serviço; o plano exige a consulta HIBP, e a necessidade de uma lista adicional fica para revisão antes do go-live.

## Sessões

- Uma sessão expira após 7 dias sem renovação (`expiresIn = 7d`); o Worker renova a sessão no máximo a cada 24 horas quando ela é usada (`updateAge = 24h`). O cache de sessão em cookie fica desativado para manter revogação e validade absoluta verificadas no servidor.
- O limite absoluto é 30 dias desde `created_at`. O Worker revoga sessão acima desse limite antes de processar uma rota Better Auth; a trigger PostgreSQL limita `expires_at` em INSERT/UPDATE, mantém `created_at` imutável em UPDATE e ajusta sessões existentes.
- Múltiplas sessões simultâneas são permitidas. `GET /api/auth/list-sessions` lista apenas sessões do usuário autenticado; Better Auth exige sessão fresca, com `created_at` de até 24 horas, para essa operação. Um cliente que liste sessões precisa suportar nova autenticação quando necessário.
- `POST /api/auth/revoke-session` pode revogar uma sessão somente se ela pertencer ao usuário autenticado; `POST /api/auth/sign-out` encerra a sessão atual. Reset de senha revoga todas as sessões.
- O campo `token` retornado pela API nativa de sessões serve como identificador para revogação; autenticar ainda exige o cookie assinado. Não registrar esse campo em logs ou telemetria.
- `session.ip_address` guarda o último IP visto na sessão, pelo IP de origem da requisição. Ele é atualizado na renovação diária e quando o IP muda; em IPv6, a linha da sessão guarda só a rede /64. Uma troca de IP é registrada como renovação de sessão no registro de acesso, e a verificação não faz consulta extra quando o IP é o mesmo. A troca de endereço dentro da mesma rede /64 não gera renovação; o login sempre grava o endereço inteiro. Se a gravação do registro falhar, a linha da sessão não muda e a próxima requisição tenta de novo.
- Login, falha de login, saída e renovação de sessão são registrados no registro de acesso de autenticação, com as regras de guarda e sigilo de [privacidade](privacy.md). O registro nunca impede o login.

A configuração segue a [documentação Better Auth de gerenciamento de sessões](https://www.better-auth.com/docs/concepts/session-management).
## Email transacional

- Verificação de endereço e recuperação de senha dependem de um sender transacional configurado; ausência de configuração deve falhar de forma segura.
- Resend está escolhido para emails transacionais de autenticação; templates são minimalistas e sem imagens. `RESEND_API_KEY` é secret do Worker; `AUTH_EMAIL_FROM` é variável de configuração não secreta e deve pertencer a um domínio verificado. `AUTH_EMAIL_REPLY_TO` é opcional. Não incluir credenciais no repositório.

## Proteção contra abuso

- Antes de encaminhar signup, login por senha, solicitação/conclusão de reset e reenvio de verificação, o Worker exige um token Turnstile de uso único validado pelo Siteverify. O servidor confere a ação esperada para a rota e o hostname de `BETTER_AUTH_BASE_URL`; o cliente não é autoridade para esses valores.
- O token vem no header `x-turnstile-token`; não registrar nem devolver esse valor. Sem token/configuração, com token inválido, ou se a validação externa estiver indisponível, não processar a operação.
- Aplicar um limite geral por IP nas rotas protegidas e limite menor nas rotas que podem enviar email. As chaves usam HMAC e não incluem o IP em claro.
- Os bindings nativos Workers Rate Limiting mantêm contadores aproximados por localidade Cloudflare, não um contador global. Eles são uma camada de contenção; não tratar o resultado como quota global ou como única defesa contra abuso distribuído.
- A autenticação por email/senha permanece desligada até Turnstile, bindings, site key do cliente, Resend e domínio de envio estarem configurados. A interface de login é pré-go-live; ela deve obter um token novo para cada envio e transmiti-lo no header definido.

## Vínculo de contas

- Não associar contas automaticamente durante um login social. O vínculo Google exige uma sessão existente e verificada, iniciada por ação explícita do usuário no fluxo OAuth com redirect/PKCE.
- O email da conta Polaris e o email retornado pelo Google precisam estar verificados e ser iguais sem distinção de caixa. Rejeitar email ausente, não verificado ou diferente.
- Não aceitar `idToken` enviado diretamente pelo cliente para criar vínculo. `trustedProviders` permanece vazio, emails diferentes não são permitidos e o perfil local não é sobrescrito ao vincular.
- Uma sessão Google só pode adicionar senha se o email local estiver verificado; o Worker chama a API server-only do Better Auth, aplica a mesma normalização NFC, tamanho e consulta HIBP da criação de senha e mantém a sessão associada ao mesmo user ID.
- O callback OAuth de vínculo gera evento de segurança com o ID interno do usuário quando a sessão está presente; nunca registrar token, payload ou dados sensíveis do provider.

O fluxo explícito e a API server-side `setPassword` seguem a [documentação Better Auth de usuários e contas](https://www.better-auth.com/docs/concepts/users-accounts).
