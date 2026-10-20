# Perfis autorizados para CLIs Cloudflare e Neon

Este runbook vale para comandos que autenticam, consultam ou alteram recursos Cloudflare ou Neon, inclusive operações somente leitura.

## Perfis e identidades autorizados

- **Cloudflare CLI:** usar exclusivamente o perfil `junior-pessoal`; confirmar a identidade `<e-mail do responsável no Cloudflare>`.
- **Neon CLI:** usar exclusivamente o perfil `junior-pessoal`; confirmar a identidade `<e-mail do responsável no Neon>`.
- As identidades são específicas de cada serviço. Não reutilizar a regra de email do Cloudflare para o Neon.
- Não usar perfil padrão, outro perfil, outra conta ou credenciais de integração conectada.
- Para Neon, não usar o plugin/conector Neon; acessar pela CLI com o perfil autorizado ou por um fluxo de navegador permitido pelo usuário.

## Procedimento

1. Consulte a ajuda ou documentação atual do CLI para selecionar explicitamente `junior-pessoal` na invocação ou sessão.
2. Confirme a identidade correspondente ao serviço: no Cloudflare, execute `cf auth whoami` e confira `<e-mail do responsável no Cloudflare>`; no Neon, execute `neon me --profile junior-pessoal` e confira `<e-mail do responsável no Neon>`.
3. Se o perfil ou a identidade não puder ser selecionado e verificado, pare e peça ao responsável para corrigir a autenticação.
4. Mantenha o perfil explícito nos comandos subsequentes e repita a verificação se houver troca de contexto, token, projeto ou sessão.
5. Não copie tokens, connection strings ou segredos para logs, documentação ou saída compartilhada; redija qualquer evidência antes de registrá-la.

O perfil autorizado não substitui a autorização exigida para alterações externas: deploys, mudanças em recursos persistentes e outras ações devem continuar dentro do escopo explicitamente autorizado pelo usuário.

## Identificadores pessoais fora do versionamento

O repositório é público (o [ADR 0076](../adr/0076-teto-de-custo-e-free-tier-primeiro.md) registra isso desde 15/10/2026, data a confirmar pelo responsável). Dado pessoal e identificador de infraestrutura (e-mail do responsável; ID de projeto, de branch ou de endpoint do Neon; ID de Hyperdrive) não entram em arquivo versionado. Este runbook, o [Gate 4](./gate-4-sales-core.md), o `doc/status-implementacao.md` e os demais docs usam marcadores: `<e-mail do responsável no Cloudflare>`, `<e-mail do responsável no Neon>`, `<id do projeto Neon dos gates>` e `<id da branch Neon descartável>`.

Quem executa o CLI lê os valores reais fora do repositório (por exemplo, num arquivo local ignorado pelo Git ou no gerenciador de segredos do responsável), confere a identidade antes de cada comando e passa o ID do projeto por variável de ambiente (`NEON_PROJECT_ID`, como nos comandos do Gate 4), sem escrevê-lo no PR, no log nem no resultado da tarefa. Nenhuma connection string, senha ou token é versionado em nenhum caso.

Os valores que já estiveram em commits anteriores continuam no histórico do git. Reescrever o histórico ou trocar o que ele expõe é decisão do responsável, fora deste documento.
