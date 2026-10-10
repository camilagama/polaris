# Perfil permitido para CLIs Cloudflare e Neon

Este runbook vale para todo comando que autentique, consulte ou altere recursos Cloudflare ou Neon, incluindo operações somente leitura.

## Perfil autorizado

- Usar exclusivamente o perfil `junior-pessoal`.
- A identidade desse perfil deve ser `contato.juniordiniz@gmail.com`.
- Não usar o perfil padrão, outro perfil, outra conta ou credenciais fornecidas por uma integração conectada.
- Para Neon, não usar o plugin/conector Neon; acessar somente pela CLI com o perfil autorizado ou por um fluxo de navegador que o usuário tenha permitido.

## Procedimento

1. Consulte a ajuda ou documentação atual do CLI para confirmar como selecionar explicitamente o perfil `junior-pessoal` naquela invocação ou sessão.
2. Verifique a identidade ativa pelo comando de identidade suportado pelo CLI e confirme que o email exibido corresponde exatamente a `contato.juniordiniz@gmail.com`.
3. Se o perfil ou email não puder ser selecionado e verificado, não execute o comando Cloudflare/Neon; pare e peça ao responsável para configurar o perfil autorizado.
4. Mantenha o perfil selecionado em comandos subsequentes da mesma sessão e repita a verificação se houver troca de contexto, token, projeto ou sessão.
5. Não copie tokens, connection strings ou segredos para logs, documentação ou saída compartilhada; redija qualquer evidência antes de registrá-la.

O perfil restrito não substitui a autorização exigida para alterações externas: deploys, mudanças em recursos persistentes e outras ações devem continuar dentro do escopo explicitamente autorizado pelo usuário.
