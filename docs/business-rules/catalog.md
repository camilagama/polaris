# Catálogo

- Categoria de catálogo pertence a uma única organização e é opcional para produto. Não é a categoria usada para classificar despesas.
- O nome é aparado nas extremidades, preserva a caixa exibida e tem no máximo 100 code points. Nomes são únicos por organização sem distinção de caixa ou espaços externos. A unicidade inclui categorias arquivadas e removidas; tombstones continuam reservando o nome.
- Categorias têm os estados derivados `active`, `archived` e `deleted`. `archived` pode voltar a `active`; `deleted` é tombstone terminal. Nenhuma operação normal faz hard-delete.
- Renomear é permitido em categorias ativas ou arquivadas. Criar, renomear ou restaurar uma categoria mantém a regra de unicidade; uma colisão retorna conflito e não altera dados.
- Categoria removida somente quando o domínio não tiver referências dependentes. PR24 ainda não tem tabela products; PR25 deve bloquear o tombstone se algum produto apontar para a categoria.
- `catalog:read` permite listar; `category:create` permite criar; `category:manage` permite rename, archive, restore e tombstone delete. O servidor valida sessão, membership, organização, capability e RLS.
- Criação, rename, archive, restore e tombstone delete são auditados na mesma transação da mutação. Repetir uma transição já aplicada é idempotente e não emite evento duplicado.
- O read contract contém UUID estável, organização, nome, estado e timestamps serializados para futura leitura offline. PR24 não adiciona cache local, comandos offline ou sync.
- A V1 não semeia categorias por padrão. Categorias iniciais vêm da organização.
- Produtos podem manter categoria opcional somente dentro da mesma organização; a remoção terminal de categoria exige ausência de vínculos. Regras completas em [products.md](products.md).
