# Autenticação e credenciais

## Email e verificação

- Better Auth é responsável pela identidade e pelas sessões; o domínio Polaris continua responsável por organizações e acesso.
- Contas criadas com email/senha precisam verificar o endereço antes de obter uma sessão de email/senha. Endereços não verificados não podem criar organizações; a operação de criação também precisa validar essa precondição no servidor.
- Tokens de verificação e de recuperação são segredos de uso único: nunca registrar token, URL completa ou payload de email em logs/auditoria. Links de verificação expiram em 24 horas; links de reset expiram em 1 hora.
- Respostas de recuperação não podem revelar se um email existe. O mesmo vale para o cadastro com um e-mail que já tem conta: a resposta é igual e o e-mail de cadastro, de recuperação e de reenvio sai em segundo plano, para o tempo de resposta não revelar a conta. Por isso uma falha do provedor de e-mail nesses fluxos não vira erro na resposta: vira um evento `auth_email_failed`, sem endereço nem token, com alerta ([ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md)). Para quem tem conta Google e tenta se cadastrar com o mesmo e-mail, sai um aviso de que a conta já existe (idempotente por usuário e por dia).
- O token de verificação, de recuperação e de desbloqueio chega ao app no **fragmento** do link, nunca no caminho nem na consulta. O app o tira da barra de endereços antes de carregar qualquer script de terceiro, guarda-o só em memória e o envia no corpo de um POST. O servidor nunca monta link com o token na URL de um documento. Os valores `token`, `newPassword`, `currentPassword` e `email` são redigidos dos logs.

## Senhas

- Para o fluxo de senha como fator único, aceitar de 15 a 128 pontos de código Unicode após normalização NFC. Espaços e caracteres Unicode são permitidos; a aplicação não trunca nem remove espaços.
- Não exigir combinações arbitrárias de maiúsculas, minúsculas, números ou símbolos; não exigir troca periódica. Uma senha comprometida deve ser substituída.
- Antes de armazenar ou alterar uma senha, verificar o valor inteiro contra o corpus de senhas comprometidas do HIBP Pwned Passwords. Calcular SHA-1 somente no Worker, enviar apenas o prefixo de cinco dígitos hexadecimais pelo endpoint k-anonymity com `Add-Padding: true`, comparar os sufixos localmente e nunca enviar a senha ou o hash completo.
- Se a consulta HIBP não puder ser concluída, rejeitar a criação/alteração da senha com erro temporário genérico. Não armazenar a senha sem a verificação.
- Não executar a consulta HIBP durante login: ela é necessária quando a senha é criada ou alterada, não em cada autenticação.
- Reset de senha revoga todas as sessões Better Auth do usuário.
- **Definir** (`set-password`) ou **trocar** (`change-password`) a senha exige uma sessão com login nos últimos 15 minutos. A troca revoga as outras sessões do usuário e troca a época de autorização, o que revoga as concessões de acesso offline vivas; a sessão de quem trocou continua (com token novo) e o token não é devolvido ao JavaScript. As duas operações geram auditoria de segurança (`password_set`, `password_changed`) e um e-mail de aviso à pessoa. O reset de senha grava `password_reset_completed` e limpa o contador de bloqueio.

A política de tamanho, Unicode, composição e expiração segue as recomendações de senhas do [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html). A consulta de senhas comprometidas segue a [API oficial Pwned Passwords](https://haveibeenpwned.com/API/v3). O limite máximo de 128 pontos de código é a escolha do produto e supera o mínimo de capacidade recomendado pelo NIST. O NIST também recomenda bloquear valores comuns, esperados ou específicos do serviço; o plano exige a consulta HIBP, e a necessidade de uma lista adicional fica para revisão antes do go-live.

## Bloqueio de conta por tentativas

- Cinco falhas de login por senha na mesma janela de 15 minutos travam a entrada por senha daquele e-mail por 15 minutos. O contador é por e-mail digitado, exista a conta ou não, e guarda só um HMAC do e-mail normalizado (NFC, sem espaços nas pontas, minúsculas, igual à normalização do Better Auth), sem e-mail em claro, ID de usuário nem IP.
- A tentativa é reservada antes de conferir a senha, para que nem requisições paralelas passem de cinco conferências por janela. Uma tentativa reservada e perdida por queda do Worker conta como falha.
- Uma conta travada recebe 429 com o tempo de espera, igual exista a conta ou não. Só quando a conta existe sai um e-mail de desbloqueio, em segundo plano, com token de 32 bytes aleatórios guardado só como SHA-256, válido por 1 hora e no máximo um por trava. O desbloqueio é idempotente dentro da hora.
- Entrar com sucesso, redefinir a senha, ou acertar a senha com o e-mail ainda não verificado, zera o contador. O login pelo Google não passa por ele e não é afetado.
- Uma linha do contador dura no máximo 1 dia mais 1 hora ([ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md)). Quem conhece o e-mail de alguém pode travar a entrada por senha dele de 15 em 15 minutos: risco aceito; a pessoa ainda entra pelo Google, desbloqueia pelo e-mail ou redefine a senha.

## Sessões

- Uma sessão expira após 7 dias sem renovação (`expiresIn = 7d`); o Worker renova a sessão no máximo a cada 24 horas quando ela é usada (`updateAge = 24h`). O cache de sessão em cookie fica desativado para manter revogação e validade absoluta verificadas no servidor.
- O limite absoluto é 30 dias desde `created_at`. O Worker revoga sessão acima desse limite antes de processar uma rota Better Auth; a trigger PostgreSQL limita `expires_at` em INSERT/UPDATE, mantém `created_at` imutável em UPDATE e ajusta sessões existentes.
- Múltiplas sessões simultâneas são permitidas. `GET /api/auth/list-sessions` lista apenas sessões do usuário autenticado; Better Auth exige sessão fresca, com `created_at` de até 24 horas, para essa operação. Um cliente que liste sessões precisa suportar nova autenticação quando necessário.
- `POST /api/auth/revoke-session` pode revogar uma sessão somente se ela pertencer ao usuário autenticado; `POST /api/auth/sign-out` encerra a sessão atual. Reset de senha revoga todas as sessões.
- O campo `token` retornado pela API nativa de sessões serve como identificador para revogação; autenticar ainda exige o cookie assinado. Não registrar esse campo em logs ou telemetria.
- `session.ip_address` guarda o último IP visto na sessão, pelo IP de origem da requisição. Ele é atualizado na renovação diária e quando o IP muda; em IPv6, a linha da sessão guarda só a rede /64. Uma troca de IP é registrada como renovação de sessão no registro de acesso, e a verificação não faz consulta extra quando o IP é o mesmo. A troca de endereço dentro da mesma rede /64 não gera renovação; o login sempre grava o endereço inteiro. Se a gravação do registro falhar, a linha da sessão não muda e a próxima requisição tenta de novo.
- Login, falha de login, saída e renovação de sessão são registrados no registro de acesso de autenticação, com as regras de guarda e sigilo de [privacidade](privacy.md). O registro nunca impede o login.
- Uma sessão fica ligada a um aparelho quando o usa: registro do aparelho, autorização offline, sincronização e verificação ao iniciar. Uma sessão ligada a um aparelho revogado é encerrada na revogação; as sessões que não usaram esse aparelho continuam.
- Encerrar as outras sessões do usuário é uma opção separada, desmarcada por padrão. Quando marcada, encerra todas as sessões do usuário, exceto a atual, inclusive as que nunca usaram um aparelho.
- Revogar outro aparelho ou encerrar as outras sessões exige login nos últimos 15 minutos. Revogar o próprio aparelho, o que a sessão atual registrou, não exige esse login recente; usar um aparelho não o torna próprio.
- Todo aparelho que passa de vivo a revogado gera um registro `device_revoked` na auditoria de autenticação, com a sessão e o aparelho de quem revogou, mesmo sem nenhuma sessão ligada a ele. A repetição de uma revogação só é registrada quando encerra alguma sessão.

A configuração segue a [documentação Better Auth de gerenciamento de sessões](https://www.better-auth.com/docs/concepts/session-management).
## Email transacional

- Verificação de endereço e recuperação de senha dependem de um sender transacional configurado; ausência de configuração deve falhar de forma segura.
- Resend está escolhido para emails transacionais de autenticação; templates são minimalistas e sem imagens. `RESEND_API_KEY` é secret do Worker; `AUTH_EMAIL_FROM` é variável de configuração não secreta e deve pertencer a um domínio verificado. `AUTH_EMAIL_REPLY_TO` é opcional. Não incluir credenciais no repositório.

## Proteção contra abuso

- Antes de encaminhar signup, login por senha, solicitação/conclusão de reset e reenvio de verificação, o Worker exige um token Turnstile de uso único validado pelo Siteverify. O servidor confere a ação esperada para a rota e o hostname de `BETTER_AUTH_BASE_URL`; o cliente não é autoridade para esses valores.
- O token vem no header `x-turnstile-token`; não registrar nem devolver esse valor. Sem token/configuração, com token inválido, ou se a validação externa estiver indisponível, não processar a operação.
- O login social tem limitador próprio por IP (20 por 60 segundos), que cobre também o retorno do Google e não depende da flag de proteção das rotas de senha; o excesso no retorno do Google volta ao app com um erro de limite, não com JSON. Sem o binding, 503.
- O Turnstile só é carregado nas rotas de entrada, com uma CSP própria que acrescenta apenas `https://challenges.cloudflare.com` a `script-src` e a `frame-src`; o resto do app não a recebe. A site key é pública e vem do Worker. O hostname e a ação continuam conferidos no servidor.
- Aplicar um limite geral por IP nas rotas protegidas e limite menor nas rotas que podem enviar email. As chaves usam HMAC e não incluem o IP em claro.
- Os bindings nativos Workers Rate Limiting mantêm contadores aproximados por localidade Cloudflare, não um contador global. Eles são uma camada de contenção; não tratar o resultado como quota global ou como única defesa contra abuso distribuído.
- A autenticação por email/senha permanece desligada até Turnstile, bindings, site key do cliente, Resend e domínio de envio estarem configurados. A interface de login é pré-go-live; ela deve obter um token novo para cada envio e transmiti-lo no header definido.

## Retorno após a entrada

- O destino depois de entrar viaja como `voltar` no `callbackURL` do app (`/entrar?voltar=<destino codificado>`) e é validado de novo na volta. Só vale caminho do próprio app, decodificado antes da validação, de até 200 caracteres, de rota conhecida, sem caracteres de controle e nunca `/entrar`, `/api` ou `/rpc`. Um valor inválido vira `/`. Um destino que não seja do app nunca vira `Location`.
- O login social envia ao `errorCallbackURL` do app (`/entrar?erro=google`). Quem criou a conta por e-mail e senha e tenta o Google recebe o erro genérico, porque o vínculo implícito continua proibido.

## Aceite dos termos e da política de privacidade

- O aceite dos termos de uso e da política de privacidade é **por usuário**, registrado por versão de cada documento com o SHA-256 do texto aceito e o instante do banco. Só se acrescenta: nada é alterado ou apagado. Não guarda IP nem navegador, e a linha não tem chave estrangeira para o usuário, para sobreviver à exclusão da conta ([ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md)).
- O cadastro por senha só é aceito com as versões vigentes dos dois documentos, e sem elas não cria o usuário. O primeiro acesso por Google e cada versão abaixo do piso `minAcceptedVersion` pedem o aceite antes de liberar o uso.
- **O servidor é o único ponto de controle**, em todo pedido autenticado (RPC, sync, lease e rotas `/api/*` autenticadas), exceto os procedimentos que consultam e registram o aceite e as rotas de sessão do Better Auth. O cliente não é barreira.
- A recusa por aceite pendente **não é recusa de sessão**: não encerra a sessão, não apaga a cópia local, o lease nem a fila de comandos, e não rejeita comando nenhum. A sincronização só pausa até o aceite ([ADR 0047](../adr/0047-abrir-o-app-sem-rede.md), emenda).
- Subir só a versão vigente de um texto não obriga novo aceite; quem sobe `minAcceptedVersion` é decisão do responsável com o jurídico.

## Vínculo de contas

- Não associar contas automaticamente durante um login social. O vínculo Google exige uma sessão existente e verificada, iniciada por ação explícita do usuário no fluxo OAuth com redirect/PKCE.
- O email da conta Polaris e o email retornado pelo Google precisam estar verificados e ser iguais sem distinção de caixa. Rejeitar email ausente, não verificado ou diferente.
- Não aceitar `idToken` enviado diretamente pelo cliente para criar vínculo. `trustedProviders` permanece vazio, emails diferentes não são permitidos e o perfil local não é sobrescrito ao vincular.
- Uma sessão Google só pode adicionar senha se o email local estiver verificado; o Worker chama a API server-only do Better Auth, aplica a mesma normalização NFC, tamanho e consulta HIBP da criação de senha e mantém a sessão associada ao mesmo user ID.
- O callback OAuth de vínculo gera evento de segurança com o ID interno do usuário quando a sessão está presente; nunca registrar token, payload ou dados sensíveis do provider.

O fluxo explícito e a API server-side `setPassword` seguem a [documentação Better Auth de usuários e contas](https://www.better-auth.com/docs/concepts/users-accounts).
