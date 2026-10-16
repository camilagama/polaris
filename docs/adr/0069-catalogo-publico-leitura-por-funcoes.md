---
status: accepted
---

# Catálogo público: leitura somente por funções, plano lido a cada pedido

## Contexto

O catálogo público (Fase 8) é a primeira superfície do Polaris aberta a quem não tem sessão. Ela lê dados de uma organização sem usuário, sem membership e sem contexto de tenant, e por isso não pode usar o caminho do ERP (sessão, capability, RLS por contexto de transação). O risco é duplo: vazar o que não é público (organização, custo, estoque, SKU, dados do dono) e continuar servindo depois que o direito acabou (downgrade, concessão vencida, conta encerrada, produto arquivado ou despublicado).

## Decisão

- **O perfil público é escrito, não derivado.** A organização digita um nome público, um endereço (slug, único entre todas as organizações, 3 a 40 caracteres, sem nomes reservados) e contatos opcionais (WhatsApp e Instagram). Nada vem do dono, do login ou do billing. A regra vale no domínio (`normalizePublicProfile`) e de novo no banco (CHECKs).
- **A publicação é uma escolha por produto**, numa tabela própria (`product_publications`), sem copiar dado do produto: o que é público é lido do produto vivo. Arquivar ou apagar um produto o tira do ar sem tocar na escolha; escolher de novo um produto despublicado o publica outra vez.
- **O público não lê tabela alguma.** Um papel NOLOGIN dedicado (`polaris_catalog_runtime`, dono das funções: `polaris_catalog_owner`) tem `EXECUTE` em exatamente quatro funções `SECURITY DEFINER` com `search_path` fixo: `public_catalog_profile`, `public_catalog_products` (páginas de 1 a 60, mais novo primeiro, cursor), `public_catalog_product` (variantes com rótulo e preço de tabela, imagens em ordem) e `public_catalog_media` (só imagem de produto que está sendo exibido). Cada função devolve um JSON com chaves fixas: nunca o ID da organização, custo, estoque ou SKU. A única exceção é a localização privada do arquivo no R2 devolvida por `public_catalog_media` (`storageKey`, que contém o prefixo da organização): ela existe para o Worker ler o objeto e **nunca** é enviada ao navegador, a log nem a cabeçalho; a rota pública (8C) devolve só os bytes. O dono das funções tem apenas `SELECT` por coluna nas colunas de que elas precisam, com políticas próprias; o papel do tenant e o de billing não executam nenhuma delas.
- **O plano é lido a cada chamada**, no banco, com a mesma regra do motor de entitlements (estado de billing, fim do acesso, concessões em vigor, revogadas antes e depois de começar). Um downgrade, uma concessão vencida, uma conta suspensa ou encerrada, um produto arquivado ou despublicado deixam de ser servidos **no pedido seguinte, sem escrita e sem purge**. O gate prova a paridade com o motor em 54 combinações. Subir de plano restaura tudo intacto: nada é apagado.
- **Escrever vale só com o plano.** Reservar um endereço, ligar o catálogo e escolher produtos exigem `public_catalog` no plano em vigor; desligar e despublicar nunca exigem. A capability é própria (`catalog:publish`).
- **Concorrência.** O perfil muda por versão (`expectedVersion`, conflito explícito) e o endereço é único no banco; um endereço ocupado é uma recusa de domínio, e o savepoint impede que ela aborte a transação do chamador.
- **Texto que se publica mostra o que diz.** Nome e descrição recusam caracteres de controle (a descrição aceita quebra de linha), caracteres de largura zero e sobreposições de direção do texto.
- **Auditoria por produto.** Publicar e despublicar gravam um evento por produto que realmente mudou (`product.published_to_catalog` e `product.unpublished_from_catalog`, com o ID do produto); repetir o que já está feito não grava nada. Perfil e interruptor gravam `public_catalog.*`.
- **Mídia** continua privada no R2. A rota pública (`/<endereço>/m/<produto>/<imagem>`, opcional `?s=320` ou `?s=640`) autoriza **cada pedido** por `public_catalog_media` (a imagem precisa ser de um produto que está sendo exibido agora) e só então lê o objeto. Serve o derivado do tamanho pedido se o ERP já o gerou e, enquanto isso, o arquivo original; o Worker público **nunca grava** no bucket nem gera derivados. A resposta leva `Cache-Control: public, max-age=60, s-maxage=60` e `ETag` (um `If-None-Match` é respondido com 304 depois de autorizar): uma imagem retirada pode continuar visível por até um minuto em caches, nunca mais, e não há purge externo a manter. A chave de armazenamento nunca sai do servidor. O binding R2 não pode ser somente leitura; a garantia é de código (a única dependência de armazenamento que a rota recebe é uma função de leitura, `MediaDependencies.getObject`, e a ligação ao binding só chama `get`) e fica registrada como limite.
- **Aplicação.** `apps/catalog` (TanStack Start no Cloudflare Workers) é separada do ERP e liga ao banco por um binding Hyperdrive próprio (`CATALOG_HYPERDRIVE`) com o login do papel público, **sem query cache**. Só importa o leitor (`@polaris/db/public-catalog-reader`): o Biome e as fixtures de fronteira recusam qualquer outro acesso a banco, billing ou auth nesse app. O leitor abre uma conexão por pedido, procura o endereço em minúsculas, devolve `null` para ID ou cursor que não são UUID (nunca um erro de banco), aplica limites de tempo a conexão e consulta e limita a página a 60. As funções do servidor recusam (404, sem abrir conexão) o que não pode ser endereço (3 a 40, minúsculas, dígitos e hífens) nem UUID; uma falha nossa chega ao visitante como uma página genérica em português, nunca a mensagem do driver. O endereço canônico vem de uma variável por ambiente (`CATALOG_ORIGIN`), nunca do cabeçalho do pedido, e um deploy sem ela falha em vez de publicar um endereço de desenvolvimento.

## Consequências

- Uma falha de aplicação ou um SQL injection na aplicação pública só alcança o que as quatro funções devolvem.
- O custo é uma verificação de plano por pedido (poucas linhas indexadas por organização); um cache de borda de curta duração, quando existir (8C), absorverá o tráfego repetido.
- Os pedidos públicos aceitam um atraso de segundos entre uma despublicação e o fim do cache de borda; não há como o conteúdo reaparecer depois do TTL.

## Limites aceitos

- O Worker do catálogo recebe o binding do bucket de mídia com permissão de escrita (o R2 não oferece binding somente leitura); só `get` é usado. Separar o bucket público de derivados é uma alternativa futura.
- Uma imagem ainda sem derivado do tamanho pedido é servida em tamanho original (até 1200 px). **Hoje nada gera os derivados** (o ERP só os cria na primeira chamada de `?size=`, que a interface não faz), então cartões e `og:image` carregam o original; gerar derivados é pré-requisito do go-live (por exemplo, gerar na primeira leitura autorizada, o que daria ao Worker público o binding de imagens e escrita no bucket, ou gerar no envio).

- Escolha de produto de uma organização fora do plano continua gravada (e volta a valer se ela voltar); a leitura do ERP mostra `enabled=false`.
- O número de páginas e o tamanho do JSON por produto não têm limite além do da lista (60 por página).
- **Trocar o endereço libera o antigo na hora:** outra organização do plano pode registrá-lo e herdar links externos. Um período de reserva do endereço antigo é decisão futura.
- A ordem "mais novo primeiro" é a do ID do produto (UUIDv7); um ID escolhido por quem cria (offline) pode aparecer em outra posição. O cursor continua correto.
- O endereço é procurado como está guardado (minúsculo): a aplicação o normaliza antes de chamar.
- A leitura da lista por Admin e o relatório de endereços reservados por organizações encerradas são da Fase 9.

## Alternativas rejeitadas

- **Aplicação pública com o papel do ERP e RLS por slug:** mistura as duas superfícies e deixa uma falha pública perto das tabelas.
- **Cópia (snapshot) do produto ao publicar:** cria um segundo dado que diverge do real e exige invalidar a cópia a cada mudança de preço, de nome ou de imagem.
- **Despublicar por job no downgrade:** cria uma janela em que o conteúdo segue no ar e um estado que precisa ser reconciliado; ler o plano a cada pedido não tem janela.
- **Purge de cache na Cloudflare:** exige credencial de purge no Worker e não é necessário com TTL curto e autorização por pedido.
