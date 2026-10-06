# Vocabulário de domínio do Polaris

Este glossário é a fonte de verdade para os termos do produto e do domínio. Ele define linguagem, não arquitetura ou implementação.

## Identidade e acesso

**Usuário (user):** pessoa que possui uma identidade autenticada no Polaris.<br>
**Evitar:** conta, quando o assunto for a pessoa autenticada.

**Organização (organization):** unidade operacional que possui o catálogo, o estoque, as vendas e os registros do revendedor.<br>
**Evitar:** workspace na interface; tenant como nome de produto.

**Membership (vínculo):** relação de acesso entre um usuário e uma organização.

**Owner:** papel inicial do membro responsável pela organização.

**Capability (capacidade):** permissão nomeada para executar uma operação.

**Tenant:** termo de arquitetura para processamento com escopo de organização; não usar na interface do produto.

## Catálogo e estoque

**Produto:** descrição comercial apresentada pelo revendedor ou comprador.

**Variante:** forma vendável de um produto, como modelo, cor ou tamanho.

**Saldo de estoque:** visão atual de quantidade e custo de uma variante.

**Movimento de estoque:** registro de entrada, baixa, inventário, venda, devolução ou outra mudança de estoque.

**Asset:** mídia armazenada, como uma imagem de produto.

## Vendas e clientes

**Venda:** transação comercial registrada pelo revendedor, com seus próprios itens e fatos econômicos.

**Ajuste de venda:** desconto, acréscimo, frete cobrado ou outro ajuste comercial explícito.

**Devolução:** registro de itens devolvidos e da quantidade que volta ao estoque vendável.

**Cliente:** pessoa ou organização que o revendedor escolhe cadastrar ou associar a uma venda. Uma venda não exige cliente.

**Atribuição de cliente:** associação registrada entre uma venda e um cliente.

**Command (comando):** pedido para executar uma operação nomeada. Um comando local pendente ainda não é um registro aceito pelo servidor.

## Dinheiro e tempo

**Money:** valor econômico expresso na moeda usada pelo negócio.

**Competência:** período ao qual uma despesa ou resultado pertence, independentemente da data em que o dinheiro foi pago.

**Resultado operacional estimado:** indicador gerencial obtido das vendas, custos e despesas registrados; não significa lucro líquido nem confirmação de caixa recebido.
## Acesso comercial

**Plano:** oferta comercial, como Free ou Pro.

**Entitlement:** capacidade ou limite que uma organização pode usar, derivado do estado comercial e de eventuais grants válidos.

**Billing provider:** serviço externo que processa um meio de pagamento e reporta fatos ao Polaris.
