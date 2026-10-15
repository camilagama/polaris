---
status: accepted
---

# Despesas: categorias e lançamentos

## Contexto

A Fase 6 do plano começa pelas despesas: o dono precisa registrar quanto a operação custou, por competência, para que o resultado do período (PR67 em diante) não dependa de planilha. O documento inicial fixa o escopo (sem fornecedor estruturado, conta a pagar, conciliação, centro de custo ou rateio), os cinco grupos de categoria e que uma despesa tem uma categoria e pode apontar para uma venda. Faltavam as decisões de modelo: de onde vêm as categorias, o que se pode corrigir e como, que limites a data de competência tem e que capability governa.

## Decisão

- **Cinco grupos fixos, categorias da organização.** Os grupos (Comercial, Operacional/Administrativa, Financeira, Impostos, Outras) são uma lista fechada no domínio e uma restrição no banco; as categorias dentro deles são da organização, que cria, renomeia, arquiva e restaura. O grupo de uma categoria **não muda** depois de criada (um relatório por grupo não pode mudar de passado). Categorias nunca são apagadas: despesas continuam apontando para elas.
- **Uma categoria por despesa e nome único por organização.** O nome é único na organização inteira, sem diferenciar grupo nem caixa: a lista da tela não pode ter dois "Aluguel". Um nome livre numa organização continua livre nas outras.
- **A organização começa com categorias padrão.** Uma organização sem nenhuma categoria recebe, na primeira leitura ou criação, as 14 padrão (Marketing, Aluguel, Contador, Impostos…), com uma `system_key` estável que sobrevive a renomeação e serve a relatórios futuros. São categorias comuns da organização; a semeadura acontece uma vez (qualquer linha existente, mesmo arquivada, a impede) e duas primeiras chamadas simultâneas deixam um só conjunto.
- **O lançamento é pequeno.** Valor (BRL, decimal exato com duas casas, maior que zero), categoria, data de competência (data de calendário da organização), descrição (obrigatória, até 200 caracteres), favorecido (opcional, até 120) e venda (opcional). Sem anexos, sem forma de pagamento e sem data de pagamento: a despesa pertence ao período de referência, como diz a regra de competência.
- **Corrigir é editar com versão; errar é anular.** Editar usa `expectedVersion` como o cliente; uma edição idêntica não muda versão nem auditoria. Uma despesa lançada por engano é **anulada** (continua gravada, auditada, fora das listas e dos totais por padrão) e pode ser reativada; ninguém apaga despesa, e a anulada é somente leitura até ser reativada.
- **A data de competência tem janela.** Não pode ser anterior a 2000-01-01 (também restrição do banco) nem mais de 366 dias depois de "hoje" no calendário da organização. Diferente da venda, que aconteceu, a competência pode ser futura (o aluguel do mês que vem) ou antiga (uma correção). A janela só é conferida quando a data muda: uma despesa antiga continua editável.
- **Só o que muda é revalidado.** Uma despesa numa categoria arquivada depois continua editável; mudar para uma categoria arquivada, ou lançar nela, é recusado. A venda só é conferida quando passa a apontar para outra.
- **O vínculo com a venda é só uma chave.** `sale_id` aponta (chave composta com a organização) para uma venda da mesma organização; venda alheia ou inexistente é recusada. O que ele faz na margem da venda (PR66) é decidido lá; aqui ele apenas existe e pode ser removido.
- **Uma capability para tudo: `expense:create`.** A capability reservada no ADR 0022 governa listar, criar, editar, anular, reativar e gerir categorias; na V1 não há `expense:read` (como no cliente, a leitura exige a capability de escrita). Somente `owner` existe; um papel de leitura futuro exige o ADR e o ajuste de que fala o 0022. A capability é conferida no procedimento e repetida no repositório.
- **Listas por competência, em páginas, com total exato.** A lista é por competência (mais nova primeiro, empate por ID) com cursor, filtro por período e categoria, e devolve a soma **de todo o filtro** (não só da página) em texto decimal exato, calculada no banco. Despesas anuladas só entram quando o estado pede.
- **O banco defende o que o código promete.** RLS (leitura, inserção e atualização, sem exclusão), `FORCE RLS`, `UPDATE` por coluna (identidade, grupo, `system_key` e criação nunca mudam), CHECKs de valor (maior que zero, no máximo duas casas, abaixo de 10¹⁸), texto e data, e chaves estrangeiras compostas com a organização para a categoria e a venda.
- **Não é offline nesta etapa.** Despesas só funcionam com conexão; a leitura offline do painel vem com o PR71, e o lançamento offline, se vier, é decisão própria.

## Consequências

- O primeiro lançamento não exige configuração: as categorias padrão já estão lá.
- O resultado do período (PR67) soma despesas ativas por competência sem tratar anuladas, e a margem da venda (PR66) parte de `sale_id`. As taxas de cartão e antecipação da venda não são despesa e nunca devem ser lançadas aqui; a tela avisa e a regra está em [expenses-and-results.md](../business-rules/expenses-and-results.md).
- Recorrência (PR65) gera ocorrências como despesas comuns; o modelo não precisa mudar, só ganhar a origem.
- O banco fica com a leitura de despesas por organização e competência indexada; os relatórios do PR68 podem ler direto dela.
- Uma despesa só some das listas por anulação; o histórico de mudanças vive nos eventos de auditoria (`expense.created`, `expense.updated`, `expense.voided`, `expense.restored` e os quatro de categoria), que não guardam valores.

## Alternativas rejeitadas

- **Categorias globais fixas:** o dono não poderia chamar a despesa do jeito dele; o documento pede categorias criadas pelo usuário.
- **Semear as categorias padrão numa migration:** não cobriria as organizações criadas depois e exigiria reescrever a migration a cada ajuste da lista; a semeadura preguiçosa cobre as duas coisas.
- **Excluir despesa de verdade:** apaga o que o resultado já mostrou; anular mantém o fato e a auditoria.
- **Mudar o grupo de uma categoria:** relatórios por grupo mudariam o passado; quem precisa de outro grupo cria outra categoria.
- **Uma capability de leitura separada:** não há outro papel que a use; segue o padrão de clientes e perfis de pagamento.
