---
status: accepted
---

# Propriedade e ordenação dos assets de produto

Um asset de mídia é escopado por organização e pode pertencer a no máximo um produto; `variant_media` reutiliza o vínculo do `product_media` desse produto para associar o mesmo arquivo a várias variantes sem duplicá-lo. A decisão segue a exigência de deduplicação entre variantes e evita compartilhamento entre produtos com ciclos de vida distintos. `product_media.position` e `variant_media.position` ordenam as imagens dentro de cada alvo, sem introduzir um conceito de capa que o plano não define. O tombstone preserva os vínculos, enquanto a identidade mínima permanece independente de upload; locator e metadados de storage entram no PR34.
