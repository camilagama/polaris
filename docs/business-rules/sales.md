# Vendas

Este arquivo é a fonte de verdade para as invariantes da venda. O modelo de dados, os fluxos, os locks e os triggers estão em [sales-data-model.md](../architecture/sales-data-model.md); as datas, a janela retroativa e a tolerância de futuro, em [time-and-dates.md](time-and-dates.md); o dinheiro, em [money.md](money.md); as razões, nos [ADR 0019](../adr/0019-venda-atomica-por-constraint-triggers-deferidos.md), [0020](../adr/0020-cancelamento-e-devolucao-compensatorios.md) e [0021](../adr/0021-datas-da-venda-e-janela-retroativa.md).

Itens marcados como "decidido na revisão do checkpoint Gate 4 (13/10/2026)" são decisões já tomadas cujo estado de implementação deve ser conferido no código antes de serem tratadas como vigentes.

## Snapshot e estrutura

- Venda confirmada é snapshot econômico imutável: itens, variantes, quantidades, preços, custos, ajustes, fatos de pagamento e data econômica não são editados depois da confirmação.
- O banco persiste somente vendas confirmadas. `pending`, `syncing`, `rejected` e `needs_attention` pertencem à outbox local; uma transação do servidor grava o cabeçalho confirmado e todos os itens juntos. A V1 não persiste rascunhos de venda.
- Cada item da venda preserva UUID da variante, UUID do produto, rótulo do produto, posição e quantidade inteira positiva. Preço de tabela e preço cobrado são informados no comando da venda; produto e variante não têm preço de catálogo nesta etapa.
- Venda pode não ter cliente. Atribuição de cliente é separada e pode ser reconciliada depois sem mudar a economia da venda.
- Quando necessário, preservar um rótulo do comprador capturado na venda; não copiar telefone e email do cliente para toda venda por padrão.
- Venda offline permanece um command pendente local até o servidor validar e confirmar. Rejeição preserva o trabalho local para correção.
- O Polaris calcula resultado econômico estimado; não afirma que o pagamento foi liquidado em banco. Sinalizar custos e taxas desconhecidos em vez de fingir precisão.

## Preços, ajustes e total

- A negociação por item é a diferença entre `listed_unit_price` e `charged_unit_price`; não registrar também essa mesma diferença como ajuste para evitar contagem duplicada.
- O subtotal é a soma de `charged_unit_price × quantity`. A venda admite desconto e acréscimo fixos ou percentuais; frete e sobretaxa de pagamento são valores fixos.
- Cada ajuste percentual usa o mesmo subtotal após a negociação por item, sem compor sobre outros ajustes. Calcular em decimal exato e arredondar half-up para centavos uma vez por ajuste. A soma dos descontos não pode exceder o subtotal.
- O total devido é subtotal menos descontos, mais acréscimos, frete e sobretaxa de pagamento. A sobretaxa aumenta o valor devido pelo comprador; custos de processamento e antecipação permanecem separados e vêm do perfil de pagamento.
- Decidido na revisão do checkpoint Gate 4 (13/10/2026): percentuais, quantidade de parcelas e prazo esperado passam a ter teto de domínio, de contrato e de banco, para que um valor digitado errado (por exemplo, 250 em vez de 2,50) não seja gravado. Os valores dos tetos são registrados em [money.md](money.md) quando implementados.

## Pagamento e perfil

- A V1 registra no máximo um pagamento por venda, cujo valor é igual ao total devido; não há pagamento parcial nem saldo pendente. Em dinheiro, o registro guarda o valor aplicado à venda, não o dinheiro entregue nem o troco.
- O pagamento registra um dos métodos V1: Pix, dinheiro, cartão de crédito, cartão de débito, transferência bancária ou outro. A escolha do método não comprova liquidação bancária.
- Em novos pagamentos de cartão de crédito, registrar quantidade positiva de parcelas e modalidade `merchant` (parcelamento do lojista) ou `issuer` (parcelamento do emissor); os demais métodos não têm parcelas nem modalidade. O limite antigo de 1–12 do documento de origem foi substituído pela decisão de não impor teto arbitrário; o teto de parcelas decidido na revisão (acima) o substitui. Um registro anterior que não capturou a modalidade pode manter `null` com marcador explícito de modalidade desconhecida.
- A venda escolhe explicitamente um perfil manual da organização, informado como `{ id, expectedVersion }` com a versão que o operador viu, ou `null` para vender sem perfil. O perfil não representa integração nem confirmação de liquidação. Perfil inexistente (ou de outra organização) é não encontrado; perfil arquivado ou com versão diferente da esperada é conflito. Perfil ou regra exata ausente não bloqueia a venda e mantém taxas e prazo desconhecidos.
- Regras de perfil são exatas por método e, para cartão, modalidade e quantidade de parcelas. Cada custo de processamento ou antecipação pode ser desconhecido, zero conhecido, fixo em BRL, percentual efetivo ou a combinação fixa e percentual; valor ausente significa desconhecido, não zero.
- O percentual efetivo de cada taxa incide sobre o total devido da venda. Somar o valor fixo e o percentual em decimal exato e arredondar half-up uma vez para centavos por custo; processamento e antecipação são persistidos separadamente de `payment_surcharge`.
- O operador marca na venda se pretende antecipar. Sem essa marca, o snapshot indica antecipação não aplicável e custo estimado zero; se marcar sem regra conhecida, preservar custo desconhecido. Não inferir que ocorreu liquidação ou antecipação real.
- O prazo esperado é um número inteiro de dias copiado da regra para o snapshot; não cria data real de pagamento nem contas a receber.
- O snapshot registra perfil, versão, regra e entradas/valores de taxa usados. Editar ou arquivar o perfil não altera vendas existentes.

## Custo do item

- O custo unitário é snapshot do custo médio aplicável, com até seis casas decimais, lido pelo servidor sob o lock do saldo. Quando o custo for desconhecido, preservá-lo como `null` e indicar margem indeterminada; nunca inferir custo zero.
- O produto, o rótulo do produto e o custo do item são derivados pelo servidor; o cliente informa somente variante, quantidade, preço de tabela e preço cobrado.
- Venda retroativa usa o custo médio e o estoque **vigentes na confirmação**, não os da data comercial. Decidido na revisão do checkpoint Gate 4 (13/10/2026) como **limitação aceita**: o CMV de uma venda retroativa usa o custo atual, e o saldo "na data D" reconstruído por data comercial pode divergir do físico daquela data. Ver [estoque](inventory.md) e o [ADR 0021](../adr/0021-datas-da-venda-e-janela-retroativa.md).

## Confirmação

- O comando `sale.confirm` (versão 1) confirma a venda inteira em uma única transação do servidor: cabeçalho, itens, ajustes, pagamento, movimentos de estoque com atualização do saldo e evento de auditoria são gravados juntos ou nenhum deles é gravado. Não existem rascunho persistido nem mutations independentes para partes da venda.
- A organização e o usuário vêm da transação tenant autorizada (sessão, membership ativo e capability `sale:create`); o `organizationId` do payload é apenas contexto solicitado.
- `commandId` é único por organização e torna o comando idempotente. Repetir o mesmo `commandId` com o mesmo conteúdo devolve a venda já confirmada (`replayed: true`) sem novos efeitos, mesmo que o perfil de pagamento tenha sido editado depois. O mesmo `commandId` com conteúdo diferente é conflito. Entregas simultâneas do mesmo comando criam uma única venda.
- As datas da venda e a janela retroativa estão em [time-and-dates.md](time-and-dates.md). A data de ledger dos movimentos de venda é sempre a data comercial, e o banco recusa, no commit, movimento `sale` com data diferente.
- Produto arquivado ou removido não é vendável. Variante inexistente na organização é tratada como não encontrada. Linhas repetidas da mesma variante são aceitas e consomem o saldo em sequência.
- O saldo nunca fica negativo: a baixa de cada linha falha com estoque insuficiente sob o lock da linha de saldo.
- O banco impede venda parcial mesmo com permissão de INSERT: no commit, recusa venda sem os itens e ajustes declarados no cabeçalho, sem exatamente um pagamento igual ao total devido, sem o movimento de estoque `sale` correspondente a cada item, ou movimento `sale` sem venda. Itens, ajustes ou pagamentos não podem ser acrescentados depois a uma venda confirmada. O runtime não tem UPDATE, DELETE nem TRUNCATE nas tabelas de venda.
- Erros de validação (400), de recurso inexistente (404) e de conflito (409) carregam o código de domínio estável em `data.reason` (por exemplo `insufficient_stock`, `sale_product_unavailable`, `payment_profile_version_conflict`, `sale_command_conflict`); erros de autorização e inesperados não expõem motivo.
- Contrato de repetição: quando o resultado de uma tentativa é desconhecido (falha de rede, 5xx), o cliente só pode repetir exatamente a mesma tentativa (mesmo `commandId`, mesmo `occurred_at` e mesmo `recorded_at`), que o servidor reconhece como replay se já tiver confirmado. Falhas definitivas com motivo não exigem repetição idêntica: uma tentativa corrigida usa um novo `commandId`.
- A confirmação não cria intents de outbox: ainda não existe outbox transacional no servidor e nenhum consumidor da venda foi definido.

## Atribuição de cliente

- A atribuição de cliente é separada da venda confirmada: o comando de confirmação não recebe cliente e a atribuição nunca altera cabeçalho, itens, ajustes, pagamento, movimentos de estoque nem saldos. A venda continua válida sem cliente.
- A atribuição é um histórico versionado e somente de acréscimo: cada mudança grava uma nova versão (`assign`, `reassign` ou `unassign`) e nenhuma linha é alterada ou apagada. A atribuição atual é a versão mais alta; `unassign` registra "sem cliente" e a venda que nunca teve atribuição está na versão 0.
- Os comandos `sale.assignCustomer`, `sale.reassignCustomer` e `sale.unassignCustomer` exigem `expectedVersion`, a versão que o operador viu; versão antiga é conflito. `assign` só vale quando a venda está sem cliente, `reassign` só troca por um cliente diferente do atual e `unassign` só remove um cliente existente. Repetir uma ação que já vale (mesmo cliente, ou remover quando já não há cliente) não cria versão nem auditoria. Mudanças concorrentes sobre a mesma versão resultam em exatamente uma vencedora; as demais recebem conflito.
- Somente clientes ativos podem ser associados ou usados em uma troca. Um cliente já associado que for arquivado depois continua associado e visível no histórico, e pode ser removido ou substituído. Cliente de outra organização ou inexistente é tratado como não encontrado, e o mesmo vale para a venda.
- A capability dedicada é `sale:assign_customer`, exigida para ler e para alterar a atribuição. Listar clientes para escolher exige `customer:update`, conforme [customers.md](customers.md).
- Cada mudança grava um evento de auditoria na mesma transação (`sale_customer_link.assigned`, `.reassigned` ou `.unassigned`) contendo apenas o tipo da entidade e o UUID da versão; nome, contatos e observações do cliente não vão para auditoria nem logs. O histórico guarda somente IDs.
- A atribuição continua permitida em uma venda cancelada, porque nunca altera a economia da venda; o histórico é preservado.

## Cancelamento da venda

- O cancelamento total é uma operação compensatória (`sale.cancel`): a venda confirmada, seus itens, ajustes, pagamento e seus movimentos de estoque originais nunca são editados nem apagados. O cancelamento grava um registro próprio e um movimento inverso de ledger (`sale_cancellation`) por item, com a quantidade do item de volta ao saldo, tudo na mesma transação.
- Uma venda só pode ser cancelada uma vez e o cancelamento não pode ser desfeito. O comando é idempotente por `commandId`: repetir o mesmo conteúdo devolve o cancelamento já gravado (`replayed: true`) sem novos efeitos; o mesmo `commandId` com outro motivo é conflito; outro `commandId` sobre uma venda já cancelada é conflito (`sale_already_cancelled`). O `commandId` do cancelamento não pode ser o da venda. Cancelamentos simultâneos da mesma venda resultam em exatamente um vencedor e o estoque volta uma vez.
- O motivo é opcional e estruturado: `customer_request`, `entry_error`, `payment_issue` ou `other`. A nota (até 500 pontos de código Unicode, aparada) só existe com um motivo e é obrigatória para `other`. A lista de motivos é decisão do projeto. Quem cancelou é o usuário da transação autorizada e o horário é o do servidor; a data de ledger do movimento é a data do momento do cancelamento no fuso horário da organização.
- Valoração do estoque devolvido: cada unidade volta ao custo unitário capturado no próprio item da venda, com a regra da média descrita em [estoque](inventory.md#reposição-por-cancelamento-ou-devolução). O cancelamento nunca é bloqueado por custo e nunca inventa custo zero.
- Produto arquivado ainda recebe o estoque de volta.
- Produto removido (tombstone): decidido na revisão do checkpoint Gate 4 (13/10/2026) que o cancelamento **passa a ser permitido** para venda com item de produto removido, **sem movimento de estoque para esses itens** (o saldo do produto removido é zero e imutável); a compensação é registrada e auditada. O comportamento anterior (recusa com `sale_product_unavailable`) é substituído, e a implementação deve ser conferida no código.
- A capability dedicada é `sale:cancel`; a leitura das vendas (`sale.list`, `sale.get`) usa `sale:read`. A auditoria grava `sale.cancelled` com o UUID do cancelamento, sem dados pessoais.
- O banco reforça o modelo: no commit recusa cancelamento sem os movimentos inversos de todos os itens (quantidade, produto, variante e custo corretos) e com o `commandId` da venda. O runtime tem SELECT e INSERT sob FORCE RLS, sem UPDATE, DELETE ou TRUNCATE, e `cancelled_by` precisa ser o usuário autorizado.
- `sale.list` devolve as vendas mais recentes (até 100 por página) com status `confirmed` ou `cancelled`, total devido, método de pagamento e cliente atual; `sale.get` devolve o snapshot completo, o cancelamento, as devoluções e o cliente atual. O total vem das linhas persistidas.

## Devoluções parciais

- A devolução parcial é uma operação compensatória (`sale.return`): a venda confirmada e seus movimentos originais nunca são editados. Cada devolução grava um registro com suas linhas, um movimento inverso de ledger (`sale_return`) por linha que volta ao estoque, os saldos e a auditoria `sale.returned`, tudo na mesma transação. Uma venda pode ter várias devoluções, até que todas as unidades tenham sido devolvidas.
- Cada linha identifica o item da venda pela sua posição e registra duas quantidades separadas: a devolvida e a que volta ao estoque vendável. As regras são `returned <= available_to_return` (vendido menos o já devolvido em devoluções anteriores) e `restocked <= returned`; a quantidade devolvida é positiva e a que volta ao estoque pode ser zero (por exemplo, devolvidas 2 e 1 volta ao estoque quando uma unidade voltou danificada). Cada item aparece no máximo uma vez por devolução e a devolução tem ao menos uma linha. Uma linha inválida rejeita a devolução inteira, sem nenhum efeito.
- Somente as unidades que voltam ao estoque geram movimento, ao custo capturado no próprio item da venda, com a mesma regra de média do cancelamento. Uma devolução que não repõe nada grava o registro e a auditoria, e nenhum movimento nem alteração de saldo.
- Produto removido (tombstone): decidido na revisão do checkpoint Gate 4 (13/10/2026) que a devolução **passa a ser permitida** para venda com item de produto removido, **sem movimento de estoque para esses itens**; a compensação é registrada e auditada. Produto arquivado recebe normalmente.
- O comando é idempotente por `commandId`: repetir o mesmo conteúdo devolve a devolução já registrada (`replayed: true`) mesmo que a venda já tenha sido totalmente devolvida; outro conteúdo com o mesmo `commandId` é conflito; o `commandId` não pode ser o da venda. Devoluções simultâneas das mesmas unidades têm tantos vencedores quantos couberem no disponível; as demais falham por disponibilidade, nunca com erro de banco.
- Devolução e cancelamento total se excluem: uma venda cancelada não recebe devoluções (`sale_not_returnable`) e uma venda com devoluções não pode ser cancelada por inteira (`sale_has_returns`). Os dois comandos serializam por venda e o banco repete a regra no commit. A exclusão mútua impede devolver duas vezes as mesmas unidades ao estoque.
- Motivo estruturado opcional da devolução (lista V1 definida pelo projeto): `customer_request`, `defective`, `wrong_item` ou `other`, com nota obrigatória apenas para `other`; a nota tem até 500 pontos de código, e NUL e surrogates soltos são rejeitados.
- Esta fase não registra valor monetário da devolução, estorno nem status de reembolso: o Polaris não processa o dinheiro devolvido ao comprador, e o impacto das devoluções nas vendas líquidas é derivado pelo motor de resultado econômico, que rateia o desconto da venda entre as unidades devolvidas e não devolve acréscimo, frete nem sobretaxa ([expenses-and-results.md](expenses-and-results.md), [ADR 0053](../adr/0053-motor-de-resultado-economico.md)). Troca continua sendo devolução mais nova venda.
- A capability dedicada é `sale:return`. A leitura (`sale.get`) devolve as devoluções com suas linhas e, por item, o vendido, o devolvido, o reposto e o ainda disponível; `sale.list` indica `hasReturns`.
- O banco reforça o modelo: no commit recusa devolução sem linhas, com quantidade acima da vendida, sem os movimentos exatos das unidades repostas, em venda cancelada, e devolução com o `commandId` da venda. O runtime tem SELECT e INSERT sob FORCE RLS, sem UPDATE, DELETE nem TRUNCATE, e `returned_by` precisa ser o usuário autorizado.
