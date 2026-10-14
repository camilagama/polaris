---
status: accepted
---

# Derivados privados e reconciliação segura de mídia

O master WebP permanece imutável e é a fonte para dois derivados regeneráveis: caixas máximas 320×320 e 640×640, preservando proporção e nunca ampliando imagens menores. Cloudflare Images aplica `scale-down`, mantém WebP quality 85 e R2 guarda os resultados no bucket privado. Chaves `media/derivatives/v1/{assetId}/{size}.webp` versionam o transform sem adicionar metadados redundantes ao banco. O Worker os gera na primeira leitura tenant-autorizada; o endpoint retorna `private, no-store`.

O upload grava um marker privado em `media/staging/v1/YYYY/MM/DD/HH/{attemptId}.json` antes do master. O prefixo UTC ordena a varredura, enquanto a decisão de expiração usa o `uploaded` real do R2 e uma retenção mínima de 24 horas. O marker só é removido depois do commit confirmado; resultado ambíguo ou falha de compensação preserva o marker para o reconciliador horário.

A checagem “não há asset referenciado” seguida por uma exclusão no R2 é vulnerável a corrida: um insert concorrente poderia tornar a chave referenciada entre as duas operações. Por isso cada tentativa física recebe um UUID próprio na chave `media/v2/{organization}/{product}/{command}/{fingerprint}/{attemptId}.webp`; replays concorrentes nunca tentam referenciar o mesmo objeto físico.

A migration 0026 cria `media_cleanup_claims`, com FORCE RLS e sem acesso direto das roles de aplicação. As funções SECURITY DEFINER usam `search_path` fixo; EXECUTE é revogado de `PUBLIC` e do runtime tenant, e somente o grupo cleanup recebe EXECUTE da função de claim. O migration owner usa SET ROLE temporário para transferir ownership e ajustar essas ACLs; a membership explícita é revogada antes do fim da migration. O trigger `BEFORE INSERT` em `media_assets` e o reconciliador usam o mesmo advisory transaction lock derivado da chave. O reconciliador adquire o lock numa instrução separada, reivindica a chave numa instrução seguinte sob READ COMMITTED e só então apaga o master no R2. O trigger rejeita qualquer insert posterior para chave tombstoned; a exclusão do objeto pode ser repetida sem risco.

A role login de produção deve ser dedicada ao cleanup, sem SUPERUSER, CREATEROLE nem BYPASSRLS, e sem acesso direto às tabelas. Ela herda somente o grupo `polaris_media_cleanup_runtime` e conecta por uma binding Hyperdrive separada, com query caching desabilitado. O cron é horário e falha explicitamente se a binding estiver ausente. A role principal tenant conserva seus grants atuais. Nenhum bucket público ou URL pública é introduzido.

O custo de manter tombstones no banco é deliberado: chaves de tentativa não são reutilizadas e o registro impede uma reintrodução acidental mesmo depois de uma falha parcial do R2. O PR35 não tenta compactar esses tombstones; qualquer retenção futura precisa preservar a garantia de não reutilização.
