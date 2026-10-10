# Mídia de produto

- Um asset de mídia pertence a uma organização e pode ser associado a no máximo um produto por `product_media`.
- `variant_media` pode associar esse asset a várias variantes do mesmo produto; o mesmo arquivo não é duplicado por associação.
- As associações de produto e variante armazenam uma `position` não negativa, única dentro do respectivo produto ou variante. A posição define ordenação; não define uma imagem de capa.
- O tombstone de produto preserva assets e associações existentes. Operações normais não fazem hard-delete nem alteram vínculos após o tombstone; o banco rejeita novas associações ou remoções nesses produtos.
- PR33 cria somente identidade do asset, tenant e vínculos. Upload, crop, locator de storage e metadados do arquivo ficam para PR34, quando o pipeline for implementado. R2 permanece privado; não há rota pública nesta etapa.
- Os limites iniciais de imagens Free/Pro em `PRODUCT.md` são hipóteses comerciais. PR33 não os fixa em constraints; enforcement segue o modelo de entitlements.
