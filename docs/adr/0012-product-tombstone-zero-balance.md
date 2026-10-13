---
status: accepted
---

# Tombstone terminal de produto com saldo zero

Um produto pode receber tombstone quando o saldo atual agregado de todas as variantes é zero, mesmo que exista histórico de estoque; movimentos, variantes, UUIDs, SKUs, vínculos e auditoria são preservados, e nenhuma operação normal faz hard-delete. Saldo positivo impede a remoção para não ocultar estoque disponível. O tombstone é terminal, bloqueia novos writes e mantém leituras históricas; esta regra permite retirar do catálogo produtos sem saldo sem apagar evidência econômica ou identidade referenciada.

Decidido na revisão do checkpoint Gate 4 (13/10/2026): o tombstone não impede cancelamento nem devolução de vendas antigas com itens do produto removido; nesses casos a compensação é registrada sem movimento de estoque, conforme o [ADR 0020](0020-cancelamento-e-devolucao-compensatorios.md).
