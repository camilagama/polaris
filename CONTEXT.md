# Vocabulário de domínio do Polaris

Este glossário é a fonte de verdade para os termos do produto e do domínio. Ele define linguagem, não arquitetura ou implementação.

## Identidade e acesso

**Usuário (user):** pessoa que possui uma identidade autenticada no Polaris.<br>
**Evitar:** conta, quando o assunto for a pessoa autenticada.

**Organização (organization):** unidade operacional que possui o catálogo, o estoque, as vendas e os registros do revendedor.<br>
**Estado da organização (organization status):** estado operacional `active`, `suspended` ou `closed`; não representa o estado de billing.<br>
**Evitar:** workspace na interface; tenant como nome de produto.

**Membership (vínculo):** relação de acesso entre um usuário e uma organização.

**Owner:** papel inicial do membro responsável pela organização.

**Capability (capacidade):** permissão nomeada para executar uma operação.

**Tenant:** termo de arquitetura para processamento com escopo de organização; não usar na interface do produto.

## Catálogo e estoque

**Produto:** descrição comercial apresentada pelo revendedor ou comprador.

**Categoria de catálogo:** agrupamento opcional de produtos definido pela organização. Não é a categoria usada para classificar despesas.

**Categoria ativa:** categoria disponível para uso no catálogo.

**Variante:** forma vendável de um produto, como modelo, cor ou tamanho.

**SKU:** código comercial opcional associado a uma variante, trocável ou removível sem mudar a identidade estável da variante, e único dentro da organização.

**Opção de variante:** característica escolhida para distinguir formas vendáveis de um produto; nesta etapa, Modelo, Cor ou Tamanho.

**Valor de opção:** escolha concreta de uma opção, como Azul para Cor ou P para Tamanho, atribuída a uma variante.

**Saldo de estoque:** visão atual de quantidade e custo de uma variante.

**Movimento de estoque:** registro de entrada, baixa, inventário, venda, devolução ou outra mudança de estoque.

**Motivo da baixa:** classificação que explica por que uma quantidade deixou de estar disponível para venda.

**Categoria arquivada:** categoria preservada, mas fora das opções ativas do catálogo; pode ser restaurada.

**Categoria removida:** categoria preservada como tombstone para manter histórico e leitura offline; não pode ser restaurada nem apagada fisicamente pela operação normal.

**Tombstone:** registro com `deleted_at` que representa uma remoção lógica e preserva identidade e timestamps para histórico/leitura offline; não é um hard-delete.

**Asset de mídia (asset):** imagem pertencente a uma organização e vinculada a um produto; pode ser associada a várias variantes desse produto sem duplicar o asset.

## Vendas e clientes

**Venda:** transação comercial registrada pelo revendedor, com seus próprios itens e fatos econômicos.

**Negociação por item:** preço cobrado registrado no próprio item em relação ao preço de tabela; não cria um segundo desconto para a mesma diferença.
**Subtotal da venda:** soma dos valores dos itens pelo preço cobrado, antes dos ajustes da venda.
**Ajuste de venda:** desconto, acréscimo, frete cobrado ou sobretaxa de pagamento aplicada à venda.
**Sobretaxa de pagamento:** valor cobrado do comprador por um meio de pagamento; é distinto das taxas de processamento e antecipação pagas pelo negócio.

**Devolução:** registro de itens devolvidos e da quantidade que volta ao estoque vendável.

**Cliente:** pessoa ou organização que o revendedor escolhe cadastrar ou associar a uma venda. Uma venda não exige cliente.

**Atribuição de cliente:** associação registrada entre uma venda e um cliente.

**Command (comando):** pedido para executar uma operação nomeada. Um comando local pendente ainda não é um registro aceito pelo servidor.

## Dinheiro e tempo

**Moeda:** unidade monetária usada para expressar valores econômicos; a V1 opera em BRL.<br>
**Money:** valor econômico expresso na moeda usada pelo negócio.
**Percentual:** taxa expressa em pontos percentuais; por exemplo, `2,5` representa `2,5%`.

**Competência:** período ao qual uma despesa ou resultado pertence, independentemente da data em que o dinheiro foi pago.<br>
**Fuso horário da organização:** zona IANA usada para interpretar datas de negócio daquela organização; instantes técnicos são UTC.

**Resultado operacional estimado:** indicador gerencial obtido das vendas, custos e despesas registrados; não significa lucro líquido nem confirmação de caixa recebido.

## Acesso comercial

**Plano:** oferta comercial, como Free ou Pro.

**Entitlement:** capacidade ou limite que uma organização pode usar, derivado do estado comercial e de eventuais grants válidos.

**Billing provider:** serviço externo que processa um meio de pagamento e reporta fatos ao Polaris.
