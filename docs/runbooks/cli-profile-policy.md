# Perfis autorizados para CLIs Cloudflare e Neon

Este runbook vale para comandos que autenticam, consultam ou alteram recursos Cloudflare ou Neon, inclusive operações somente leitura.

## Perfis e identidades autorizados

- **Cloudflare CLI:** usar exclusivamente o perfil `junior-pessoal`; confirmar a identidade `contato.juniordiniz@gmail.com`.
- **Neon CLI:** usar exclusivamente o perfil `junior-pessoal`; confirmar a identidade `juniordiniz56@gmail.com`.
- As identidades são específicas de cada serviço. Não reutilizar a regra de email do Cloudflare para o Neon.
- Não usar perfil padrão, outro perfil, outra conta ou credenciais de integração conectada.
- Para Neon, não usar o plugin/conector Neon; acessar pela CLI com o perfil autorizado ou por um fluxo de navegador permitido pelo usuário.

## Procedimento

1. Consulte a ajuda ou documentação atual do CLI para selecionar explicitamente `junior-pessoal` na invocação ou sessão.
2. Confirme a identidade correspondente ao serviço: no Cloudflare, use o comando de identidade suportado pelo CLI e confira `contato.juniordiniz@gmail.com`; no Neon, execute `neon me --profile junior-pessoal` e confira `juniordiniz56@gmail.com`.
3. Se o perfil ou a identidade não puder ser selecionado e verificado, pare e peça ao responsável para corrigir a autenticação.
4. Mantenha o perfil explícito nos comandos subsequentes e repita a verificação se houver troca de contexto, token, projeto ou sessão.
5. Não copie tokens, connection strings ou segredos para logs, documentação ou saída compartilhada; redija qualquer evidência antes de registrá-la.

O perfil autorizado não substitui a autorização exigida para alterações externas: deploys, mudanças em recursos persistentes e outras ações devem continuar dentro do escopo explicitamente autorizado pelo usuário.
