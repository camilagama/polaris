---
status: accepted
---

# Tombstone terminal de produto com saldo zero

Um produto pode receber tombstone quando o saldo atual agregado de todas as variantes é zero, mesmo que exista histórico de estoque; movimentos, variantes, UUIDs, SKUs, vínculos e auditoria são preservados, e nenhuma operação normal faz hard-delete. Saldo positivo impede a remoção para não ocultar estoque disponível. O tombstone é terminal, bloqueia novos writes e mantém leituras históricas; esta regra permite retirar do catálogo produtos sem saldo sem apagar evidência econômica ou identidade referenciada.

Decidido na revisão do checkpoint Gate 4 (13/10/2026): o tombstone não impede cancelamento nem devolução de vendas antigas com itens do produto removido; nesses casos a compensação é registrada sem movimento de estoque, conforme o [ADR 0020](0020-cancelamento-e-devolucao-compensatorios.md).

## Emenda: só arquivado, com teto por hora (12/11/2026)

O tombstone passa a exigir produto **arquivado**: excluir produto ativo é recusado com `product_lifecycle_conflict` e arquivar é o desfazer do passo anterior. O servidor, e não só a tela, aplica a regra. A decisão do usuário foi deixar quem chega ao limite do plano Free excluir produto arquivado para liberar vaga; o SKU continua reservado.

Como o ato é permanente, cada loja tem no máximo 50 exclusões concluídas na última hora (`PRODUCT_DELETE_LIMIT_PER_HOUR`, no domínio). A 51ª é recusada com `product_delete_rate_limited`, HTTP 429, com o limite e `retryAfterSeconds`. O teto é guarda de segurança contra engano em massa, não contra o próprio dono. O teto do Free é de 50 **variantes**, não de produtos, e cada produto tem ao menos uma: dentro do limite do Free (até 50 variantes) a limpeza cabe em uma hora; uma loja que voltou do Pro acima do limite (ADR 0058) leva mais de uma hora, 50 por hora. Excluir, recriar e excluir de novo na mesma hora também bate no teto.

- **Mecanismo, sem migration.** Dentro da transação da exclusão, depois do `FOR UPDATE` da linha do produto, toma-se a trava consultiva `polaris.product.delete:<loja>` e conta-se `products.deleted_at` da última hora. Só exclusão concluída conta: a recusa não grava nada, o replay de produto já excluído responde "sem mudança" e não conta.
- **Relógio.** `deleted_at` é gravado com o `now()` do banco, o mesmo relógio da janela.
- **Isolamento.** A exclusão roda em READ COMMITTED. Em REPEATABLE READ a segunda de duas exclusões simultâneas não enxergaria a primeira e as duas passariam; o repositório recusa rodar nesse nível.
- **Só online.** `product.delete` não tem manipulador no `sync.push`: qualquer comando desse tipo recebe `unsupported_command_type`, e um teste falha se alguém registrar um.
- **Ordem das recusas.** Versão velha, saldo diferente de zero e produto ativo são recusados antes do teto.
- **Em lote.** Não existe exclusão em lote. Se um dia existir, exige login recente, como o encerramento da loja.

## Emenda: a tela de Excluir (15/11/2026)

- **Onde.** "Excluir…" existe só no menu "Mais ações" de produto **arquivado** na lista de Arquivados, em grupo próprio depois de "Restaurar" e separado dele por um traço. Nunca no menu de produto ativo (onde está "Arquivar"), nem no diálogo do produto, no painel de variantes ou no Estoque.
- **Confirmação.** Diálogo pequeno com o que acontece (não tem volta, as vendas antigas continuam no histórico, quantas variantes libera, o SKU não volta a ser usado) e o nome do produto digitado, comparado como a regra do nome único (sem diferenciar maiúsculas nem espaços repetidos). O botão diz a escolha ("Excluir produto" / "Manter arquivado"). Esc, o ×, "Manter arquivado" e clicar fora fecham sem excluir.
- **Só online.** A chamada é sempre `product.delete` direto, com a versão vista na lista. A linha local só muda depois que o servidor confirma, e sem conexão o item do menu fica desligado. Sem resposta do servidor, a tela diz que a alteração não foi confirmada e que pode ter sido salva, nunca "excluído".
- **Recusas.** Saldo diferente de zero (a tela lê o saldo e leva ao Estoque), teto por hora (diz a hora de tentar de novo), produto mudado em outro aparelho (relê a lista).
- **Em lote.** Não há seleção múltipla nem "Excluir todos os arquivados". Regra registrada, não implementada: se um dia houver lote, ele exige login recente, como o encerramento da loja.
