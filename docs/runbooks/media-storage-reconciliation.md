# Reconciliador de mídia no R2

Este runbook cobre o staging, os derivados privados e a limpeza de masters órfãos do PR35. Não provisiona nem altera recursos de produção.

## Identidades e recursos

- Antes de usar Neon CLI, siga [CLI profile policy](./cli-profile-policy.md): somente perfil `junior-pessoal`, identidade `juniordiniz56@gmail.com`, e confirme o projeto/branch descartável. Não use o plugin/conector Neon.
- Antes de usar Cloudflare CLI, confirme o perfil `junior-pessoal` e a identidade `contato.juniordiniz@gmail.com`; passe `--profile junior-pessoal` em cada comando.
- O bucket `polaris-media` permanece privado. Não habilite domínio público nem cache CDN para masters ou derivados.
- A Worker binding `MEDIA_CLEANUP_HYPERDRIVE` usa uma credencial login dedicada, membro apenas de `polaris_media_cleanup_runtime`. O grupo recebe somente EXECUTE em `claim_media_storage_key_for_cleanup(text)`; a role tenant `polaris_pr11_runtime` não recebe esse EXECUTE.
- `MEDIA_CLEANUP_HYPERDRIVE` é separada da Hyperdrive tenant e mantém query caching desabilitado. Limite de conexões recomendado para o cron é 5. A Worker falha se o binding ou o bucket estiver ausente.
- O cron roda a cada hora no minuto 17 UTC. O reconciliador pode ser executado novamente: claims e exclusões são idempotentes.

## Provisionamento de uma role cleanup

A migration 0026 cria `polaris_media_cleanup_owner` e `polaris_media_cleanup_runtime` como roles sem login, sem SUPERUSER, sem CREATEROLE e sem BYPASSRLS. A role `cleanup_owner` possui as funções SECURITY DEFINER e os grants estritamente necessários; a tabela de claims tem FORCE RLS e só policy para essa role.

Para produção, crie uma role login dedicada, com senha gerenciada fora do código, e conceda membership ao grupo runtime:

```sql
CREATE ROLE polaris_media_cleanup_login
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT polaris_media_cleanup_runtime TO polaris_media_cleanup_login;
```

Confirme `rolsuper = false`, `rolbypassrls = false`, `rolcreaterole = false` e que a única membership funcional da role login é `polaris_media_cleanup_runtime`. A role login não deve ter SELECT em `media_assets` nem em `media_cleanup_claims`; a leitura global da chave ocorre apenas dentro da função SECURITY DEFINER.

**Não crie essa role login pelo Neon CLI `roles create` sem restringi-la.** No gate deste projeto, o comando gerou uma role membro de `neon_superuser` com BYPASSRLS; ela foi removida. O gate usa uma role PostgreSQL criada com SQL, NOBYPASSRLS e membership somente no grupo cleanup. O criador CREATEROLE recebe membership administrativa automática com INHERIT e SET falsos; isso, por si só, não permite `ALTER FUNCTION ... OWNER`. A migration concede `SET TRUE` temporariamente ao executor para transferir as funções. Em seguida usa `SET ROLE polaris_media_cleanup_owner` para remover EXECUTE de `PUBLIC` e da role tenant e conceder EXECUTE da função de claim somente ao grupo cleanup; executa `RESET ROLE` e revoga a membership SET explícita. A membership administrativa automática permanece com SET falso; runtime e login cleanup não são membros do owner. PostgreSQL exige poder executar `SET ROLE` para alterar o owner da função ([documentação oficial](https://www.postgresql.org/docs/18/sql-alterfunction.html)); as opções SET/INHERIT/ADMIN são controladas por membership ([documentação oficial](https://www.postgresql.org/docs/18/role-membership.html)).

Após obter a credencial login por um mecanismo seguro e não registrá-la, configure a binding Hyperdrive separada para essa connection string, usando conexão direta ao Neon. Habilite caching SQL como desabilitado; não reutilize a URL de owner, a role tenant ou a role de onboarding.

## Verificações operacionais

1. Consulte logs de invocações agendadas. Sucesso informa contagens de markers lidos, markers removidos, masters órfãos apagados, assets referenciados mantidos e markers recentes ignorados.
2. Em erro transitório de R2 ou Neon, o marker permanece e o cron tenta novamente. Uma chave com marker malformado é mantida para investigação; não apague prefixos em massa.
3. Para o gate de staging, use somente uma branch Neon descartável e prefixos sintéticos. O gate do PR35 confirmou PostgreSQL 18.6, RLS/grants, role cleanup, lock compartilhado e concorrência; a branch descartável expira automaticamente.
4. Para o gate Cloudflare, use somente o perfil autorizado e um Worker/Preview temporário. O gate confirmou Cloudflare Images, R2 privado e a função reconciliadora; após o teste, confirme Worker/Preview/Hyperdrive removidos e prefixos `media/staging/v1/`, `media/derivatives/v1/` e `media/v2/` vazios.
5. Não execute limpeza manual sobre uma chave que possa estar sendo usada por upload. A exclusão operacional deve passar pelo claim transacional da chave e pelo reconciliador.

## Imagens removidas de produtos (ADR 0061)

- O mesmo cron horário também apaga os objetos de imagens removidas de um produto: lista os assets sem nenhum vínculo (mais antigos que uma hora), apaga o master e os derivados 320 e 640 no R2 e só então finaliza no banco (a linha do asset sai e a chave vai para o tombstone). Até 150 imagens por execução (três lotes de cinquenta); a seguinte continua. Confirmar na implantação que o teto de chamadas de uma invocação do Worker comporta isso junto com o reconciliador de markers.
- A role login da limpeza ganhou duas funções (`list_unlinked_media_for_cleanup` e `finalize_unlinked_media_cleanup`, com `EXECUTE` só para o grupo de limpeza) e continua sem poder ler `media_assets`, `product_media` ou `media_cleanup_claims` diretamente; a role tenant não executa nenhuma delas. Se isso deixar de valer, trate como falha de privilégio, como acima.
- Nos logs da execução agendada, `media_removed_reconciliation_complete` informa quantas imagens foram lidas e apagadas. Cada falha é registrada como `media_removed_asset_failed` (com o ID do asset e o motivo) ou `media_removed_asset_not_finalized` (o asset ganhou vínculo depois de os objetos serem apagados, o que o gatilho `product_media_new_asset_only` deve impedir: tratar como incidente e verificar se a imagem ainda existe). Uma execução que falha em algum asset termina com `media_removed_reconciliation_incomplete` (o reconciliador de markers roda do mesmo jeito) e tenta de novo na hora seguinte; o asset só sai do banco depois que os objetos saíram do bucket, então uma falha nunca deixa objeto sem dono.
- Uma chave de asset que não parece uma chave de mídia v2 não é tocada e conta como falha para investigação; não apague prefixos em massa.
- Não há prova no R2 real desta etapa (a implantação está adiada pelo responsável): ao implantar, confirmar com um produto de teste que remover uma imagem esvazia `media/v2/` e `media/derivatives/v1/` dela em até uma hora.

## Falhas e escalonamento

- Se a role cleanup conseguir ler diretamente as tabelas ou se a role tenant conseguir executar a função, desabilite a binding de cleanup e trate como falha de privilégio antes de habilitar o cron.
- Se o cron não encontra o binding, corrija a Hyperdrive dedicada na configuração do Worker; não substitua pela URL owner.
- Se masters referenciados estiverem ausentes, interrompa alterações no prefixo e verifique o fluxo de upload/commit. O reconciliador não deve apagar assets que o banco reconhece.
- Responsável pelo banco/Cloudflare: mantenedor Polaris; qualquer alteração persistente de produção exige autorização explícita.
