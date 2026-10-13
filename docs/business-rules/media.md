# Mídia de produto

- Um asset de mídia pertence a uma organização e pode ser associado a no máximo um produto por `product_media`.
- `variant_media` pode associar esse asset a várias variantes do mesmo produto; o mesmo arquivo não é duplicado por associação.
- As associações de produto e variante armazenam uma `position` não negativa, única dentro do respectivo produto ou variante. A posição define ordenação; não define uma imagem de capa.
- O tombstone de produto preserva assets e associações existentes. Operações normais não fazem hard-delete nem alteram vínculos após o tombstone; o banco rejeita novas associações ou remoções nesses produtos.
- O master é produzido pelo Cloudflare Images em WebP quality 85, com crop antes de `scale-down`, proporção preservada e limite máximo de 1200 px por aresta; imagens menores não são ampliadas. O objeto fica no R2 privado.
- Derivados WebP de 320 e 640 px são limites máximos de `scale-down`, sem upscale e com proporção preservada. São gerados sob demanda pelo endpoint tenant-autorizado e persistidos no R2 como cache regenerável; a chave contém a versão do transform e o asset ID.
- Master e derivados são servidos somente depois da autenticação e autorização tenant-scoped. Respostas de mídia usam `Cache-Control: private, no-store`; nenhum bucket ou endpoint de mídia é público.
- Cada tentativa física de upload usa uma chave de master exclusiva. Um marker privado é escrito no prefixo `media/staging/v1/` antes do master e removido depois do commit confirmado. Commit ambíguo mantém o marker para reconciliação.
- Markers têm retenção mínima de 24 horas baseada no timestamp real do R2. O reconciliador remove o master somente após reivindicar sua chave no banco e comprovar que não há asset referenciado; para chave referenciada, remove apenas o marker.
- A reivindicação usa uma tabela privada com FORCE RLS e funções SECURITY DEFINER de privilégios mínimos. Um advisory lock transacional compartilhado com o trigger de inserção de `media_assets` serializa limpeza e criação da referência. Chaves reivindicadas ficam tombstoned e não podem ser reutilizadas.
- Os limites iniciais de imagens Free/Pro em `PRODUCT.md` são hipóteses comerciais. Enforcement continua no modelo de entitlements; não há bucket público nem quotas comerciais fixadas nas regras de mídia.
