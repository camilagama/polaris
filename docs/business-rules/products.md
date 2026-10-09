# Produtos

- Produto pertence a uma organização; ID é UUIDv7. Nome é obrigatório e aparado, mas nomes repetidos dentro da organização são permitidos. A fonte não define comprimento máximo, então o schema não inventa um limite.
- Descrição é opcional; texto em branco após aparar espaços é tratado como nulo. Categoria de catálogo também é opcional e deve pertencer à mesma organização. Categoria ativa pode ser atribuída; arquivar uma categoria mantém vínculos existentes, mas não permite novas atribuições. Categoria removida não pode ser atribuída.
- Estado do produto é derivado do timestamp archived_at: active quando nulo, archived quando preenchido. Arquivar é reversível, remove o produto das operações normais e impede venda; restaurar retorna a active.
- Todo produto tem ao menos uma variante. PR25 cria uma variante padrão junto com o produto na mesma transação. O banco adia a verificação até o commit, permitindo que ambos sejam inseridos atomicamente e rejeitando produto sem variante.
- version começa em 1 e incrementa em cada alteração real do produto, inclusive lifecycle. Updates declaram expectedVersion; versão obsoleta é conflito e não altera dados. Repetir uma transição de lifecycle já aplicada não incrementa versão nem gera audit duplicado.
- Criação, alteração, arquivamento e restauração são auditados na mesma transação da mudança.
- Remoção terminal de categoria é bloqueada enquanto houver produto vinculado. A verificação é sincronizada com atribuições concorrentes e também protegida no banco.
- PR25 não contém estoque, preço, custo, SKU, código de barras, mídia, opções, combinações, comandos offline ou exclusão de produto. SKU pertence à variante e permanece para PR27. Tombstone de produto fica adiado até haver regras de estoque/histórico que definam referências e retenção.
