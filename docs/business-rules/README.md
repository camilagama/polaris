# Regras de negócio

Este diretório é a fonte de verdade para **invariantes de domínio**: o que é válido, o que é recusado e por quê, em termos de negócio. Mantenha cada regra em um único arquivo e referencie-o em vez de copiar a regra para outros documentos.

O que **não** pertence aqui:

- números de PR, histórico de implementação ou estado de entrega (isso vive em `doc/status-implementacao.md`);
- comportamento de interface (isso vive em [DESIGN.md](../../DESIGN.md));
- modelo de tabelas, locks e triggers (isso vive em [architecture/](../architecture/));
- a razão de uma decisão estrutural (isso vive em [adr/](../adr/)).

Quando uma decisão ainda não está implementada, a regra a marca como "decidido na revisão do checkpoint Gate 4 (13/10/2026)" e indica que o código deve ser conferido. Quando uma regra ainda depende de prova técnica ou validação externa, marque-a como pendente.

## Índice

- Ciclo da organização, membership, acesso e lista de capabilities: [organization-and-access.md](organization-and-access.md).
- Categorias de catálogo, unicidade e lifecycle: [catalog.md](catalog.md).
- Produtos, variantes, SKU e remoção: [products.md](products.md).
- Mídia de produto: [media.md](media.md).
- Identidade, verificação, credenciais e sessões: [authentication.md](authentication.md).
- Quantidades, custo, histórico, reposição e valoração do estoque: [inventory.md](inventory.md).
- Valores monetários e precisão: [money.md](money.md).
- Tempo, timezone, datas da venda, janela retroativa e tolerância de futuro (único lugar): [time-and-dates.md](time-and-dates.md).
- Vendas confirmadas, cancelamento, devoluções e atribuição de cliente: [sales.md](sales.md).
- Cadastro, contato e lifecycle de clientes: [customers.md](customers.md).
- Despesas, competência, resultado e metas: [expenses-and-results.md](expenses-and-results.md).
- Planos, reconciliação de providers e entitlements: [billing-and-entitlements.md](billing-and-entitlements.md).
- Perfil público, publicação de produtos e o que o catálogo público mostra: [public-catalog.md](public-catalog.md).
- Operadores da plataforma, identidade do Admin e capacidades de plataforma: [platform-admin.md](platform-admin.md).
- Minimização, encerramento, exportação e retenção: [privacy.md](privacy.md).
