# Vocabulário de domínio do Polaris

Este glossário é a fonte de verdade para os termos do produto e do domínio. Ele define linguagem, não arquitetura ou implementação.

## Identidade e acesso

**Usuário (user):** pessoa que possui uma identidade autenticada no Polaris.<br>
**Evitar:** conta, quando o assunto for a pessoa autenticada.

**Organização (organization):** unidade operacional que possui o catálogo, o estoque, as vendas e os registros do revendedor.<br>
**Estado da organização (organization status):** `active` e `suspended` (operacionais) e `closing`, `closed`, `purge_pending` e `purged` (o encerramento); não representa o estado de billing.<br>
**Encerramento (closure) e janela de recuperação:** o dono encerra a organização digitando o nome; o acesso acaba na hora e, por 30 dias (`closing`), ele pode desfazer. Distinto da suspensão (medida da plataforma) e da exclusão física (purge).<br>
**Evitar:** workspace na interface; tenant como nome de produto.

**Anonimização de cliente (customer anonymization):** a pessoa sai do cadastro (nome fixo, sem telefone, email nem observações) e o registro fica, para que as vendas ligadas a ele mantenham seus fatos econômicos. Irreversível; distinta de arquivar.<br>

**Caso de privacidade (privacy case):** o fluxo interno de um pedido sobre dado pessoal, do pedido à resolução, com o papel do Polaris (controlador ou operador) determinado antes da decisão. Guarda só códigos, uma referência opaca e uma nota curta; nunca o dado pessoal. É um caso de suporte de um tipo próprio.<br>

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

**Tombstone:** registro que representa uma remoção lógica e preserva identidade e datas para histórico e leitura offline; não é um hard-delete.

**Asset de mídia (asset):** imagem pertencente a uma organização e vinculada a um produto; pode ser associada a várias variantes desse produto sem duplicar o asset.

## Vendas e clientes

**Venda:** transação comercial registrada pelo revendedor, com seus próprios itens e fatos econômicos.

**Negociação por item:** preço cobrado registrado no próprio item em relação ao preço de tabela; não cria um segundo desconto para a mesma diferença.
**Subtotal da venda:** soma dos valores dos itens pelo preço cobrado, antes dos ajustes da venda.
**Ajuste de venda:** desconto, acréscimo, frete cobrado ou sobretaxa de pagamento aplicada à venda.
**Sobretaxa de pagamento:** valor cobrado do comprador por um meio de pagamento; é distinto das taxas de processamento e antecipação pagas pelo negócio.
**Parcela:** divisão de uma cobrança no cartão de crédito; a quantidade de parcelas é registrada na venda.
**Modalidade do parcelamento:** classificação registrada no cartão de crédito como `merchant` (parcelamento do lojista) ou `issuer` (parcelamento do emissor); não é evidência de liquidação.
**Perfil de pagamento:** configuração manual da organização que descreve regras de taxa por método e, para cartão, modalidade e quantidade de parcelas. O operador seleciona o perfil na venda; o snapshot registra a regra aplicada.
**Prazo esperado de recebimento:** estimativa em número de dias da regra de pagamento; não cria data de liquidação nem contas a receber.

**Devolução:** registro de itens devolvidos e da quantidade que volta ao estoque vendável.
**Registro compensatório:** registro novo que corrige uma venda confirmada sem editá-la; cancelamento e devolução são registros compensatórios.
**Cancelamento da venda:** registro compensatório que desfaz a venda inteira devolvendo ao estoque as quantidades de todos os itens; a venda confirmada e seus movimentos originais permanecem. Regras em [vendas](docs/business-rules/sales.md).
**Quantidade devolvida e quantidade reposta:** em cada linha de devolução, a quantidade que o comprador devolveu e a parte dela que volta ao estoque vendável; as duas são registradas separadamente.
**Momento comercial:** o instante em que a venda aconteceu, informado pelo operador.
**Data comercial:** a data do momento comercial no calendário da organização; é a data dos movimentos de estoque da venda.
**Evidência local:** o horário do dispositivo ao criar a venda; não decide nenhuma regra.
**Confirmação da venda:** o momento em que o servidor aceita a venda, pelo relógio do servidor.
**Janela retroativa:** quantos dias de calendário, no fuso da organização, um papel pode voltar ao registrar uma venda. O valor e as demais regras de datas estão em [tempo e datas](docs/business-rules/time-and-dates.md).

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

**Free acima do limite:** estado de uma organização no Free que mantém mais variantes do que o plano permite. Nada é apagado; só as **variantes operacionais** (as que ela escolheu, ou as vendidas mais recentemente quando não escolheu) recebem nova atividade comercial.

**Janela de adequação:** os sete dias depois do fim do acesso Pro em que a organização ainda pode trocar quais variantes ficam operacionais; depois dela a escolha só cresce.

**Meta pausada:** meta em andamento que o plano em vigor não comporta (a organização tem mais metas do que o limite). Não é medida nem editada, pode ser cancelada e volta quando o plano permitir; a pausa é derivada, nunca guardada.

**Pagamento tirado:** pagamento de um período que foi reembolsado integralmente ou sofreu chargeback. O Polaris o lembra (e o período que cobria) para que sua confirmação tardia não devolva o acesso e para que um chargeback revertido o restaure.

**Concessão temporária:** entitlement dado por Polaris (compensação, parceria, apoio) além do plano, com autor, motivo, início e fim; só eleva, sempre expira e nunca é uma assinatura. Ao terminar, a organização que mantém mais do que o Free permite entra na janela de adequação.

**Catálogo público:** o que a organização escolheu mostrar a quem não tem conta: um perfil público (nome, endereço e contatos que ela digitou) e produtos publicados. É lido a cada pedido pelo plano em vigor; sair do plano o tira do ar sem apagar a escolha.

**Endereço público:** o slug do catálogo, único entre todas as organizações (`/loja-da-ana`).

**Principal de plataforma:** a pessoa que opera o Polaris, identificada pelo emissor e subject do Cloudflare Access (nunca pelo e-mail). Só entra no Admin se o dono do banco a cadastrou e ela está ativa.

**Caso de suporte:** o motivo registrado pelo qual um operador olha uma organização (suporte ou privacidade); dele pendem os acessos temporários.

**Acesso temporário:** permissão de somente leitura de um operador a uma organização, ligada a um caso aberto, com prazo curto (60 minutos por padrão, de 5 a 240); dar outro acesso é uma nova decisão registrada; é a única porta do Admin para registros do tenant.

**Revelação:** a ação explícita de ver um campo real de um cliente que o Admin vê mascarado; sempre auditada, sem guardar o valor.

**Capacidade de plataforma:** permissão nomeada do Admin (por exemplo `pii:reveal`), separada das capacidades de tenant; cada rota do Admin pede uma, nenhum caso de uso compara o papel pelo nome.

**Billing provider:** serviço externo que processa um meio de pagamento e reporta fatos ao Polaris.
