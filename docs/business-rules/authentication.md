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

A política de tamanho, Unicode, composição e expiração segue as recomendações de senhas do [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html). A consulta de senhas comprometidas segue a [API oficial Pwned Passwords](https://haveibeenpwned.com/API/v3). O limite máximo de 128 pontos de código é a escolha do produto e supera o mínimo de capacidade recomendado pelo NIST. O NIST também recomenda bloquear valores comuns, esperados ou específicos do serviço; PR15 implementa HIBP conforme o plano, e a necessidade de uma lista adicional fica para revisão antes do go-live.

## Email transacional

- Verificação de endereço e recuperação de senha dependem de um sender transacional configurado; ausência de configuração deve falhar de forma segura.
- Resend está escolhido para emails transacionais de autenticação; templates são minimalistas e sem imagens. `RESEND_API_KEY` é secret do Worker; `AUTH_EMAIL_FROM` é variável de configuração não secreta e deve pertencer a um domínio verificado. `AUTH_EMAIL_REPLY_TO` é opcional. Não incluir credenciais no repositório.
