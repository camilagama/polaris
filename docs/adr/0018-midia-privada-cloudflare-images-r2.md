---
status: accepted
---

# Mídia de produto: Cloudflare Images, WebP e R2 privado

## Contexto

O Polaris guarda imagens de produto de revendedores, muitas vezes fotos de celular de vários megabytes, e precisa servi-las nas telas autenticadas e, no futuro, no catálogo público. As decisões de propriedade e de derivados já têm ADR ([0013](0013-product-media-ownership-and-order.md) e [0014](0014-private-media-derivatives-and-reconciliation.md)); faltava registrar a escolha do pipeline e da política de armazenamento que elas pressupõem. As regras de domínio estão em [media.md](../business-rules/media.md); o procedimento operacional, no [runbook de reconciliação](../runbooks/media-storage-reconciliation.md).

## Decisão

Registro retroativo das decisões do PR33 ao PR35, confirmadas na revisão do checkpoint Gate 4 (13/10/2026):

- **Transformação no Cloudflare Images.** O upload passa pelo Worker, que usa o Cloudflare Images para recortar e re-codificar. Só a **saída re-codificada** é persistida: o arquivo original nunca é gravado, o que também deve remover metadados do dispositivo (a prova no provedor real é pendência, abaixo).
- **Formato e tamanho.** Master em WebP com qualidade 85, limite máximo de 1200 px por aresta, proporção preservada e sem ampliação.
- **R2 privado.** Master e derivados vivem em bucket privado do R2, com chaves por UUID (sem nome do arquivo, produto legível ou dado do usuário). Nenhum bucket ou URL de mídia é público; toda leitura passa por autenticação e autorização tenant, com `Cache-Control: private, no-store`.
- **Derivados sob demanda.** Os tamanhos 320 e 640 são caixas máximas regeneráveis a partir do master imutável, gerados na primeira leitura autorizada e guardados no R2 sob chave versionada. Perdê-los não perde dado.
- **Marker antes do master.** Cada tentativa física grava primeiro um marker privado de staging e só depois o master; o marker é removido após o commit confirmado. Falha ou resultado ambíguo preserva o marker para o reconciliador.
- **Retenção de 24 horas.** Markers e masters não referenciados só são removidos depois de pelo menos 24 horas contadas pelo timestamp real do R2, e a remoção do master exige reivindicar a chave no banco (tombstone) e comprovar que nada a referencia, como descrito no ADR 0014.
- **Limites comerciais.** As quantidades Free/Pro de imagens são hipóteses de [PRODUCT.md](../../PRODUCT.md); o enforcement pertence aos entitlements.

## Consequências

- Não há URL pública estável de imagem; o catálogo público, quando existir, precisa de rota própria que reautorize a publicação do conteúdo.
- Cada derivado ausente custa uma transformação na primeira leitura; sem teto de uploads e de transformações por organização, o custo pode ser abusado. Rate limit e quotas de mídia entram antes do go-live (ver [ADR 0027](0027-separacao-de-roles-auth-tenant-e-superficies-poc.md) e o checklist de go-live).
- A orientação EXIF e a remoção de metadados ainda não foram provadas no provedor real; a prova é pendência antes da Fase 5.
- O pico de memória do Worker por upload cresce com o tamanho do arquivo; o teto de upload é um limite explícito de segurança.
- Free permite uma imagem por produto; remover e reordenar existem desde o [ADR 0059](0059-remover-e-reordenar-imagens-de-produto.md), e substituir é remover e depois enviar.

## Alternativas consideradas

- **Guardar o original e derivar tudo dele.** Preserva fidelidade, mas armazena metadados do dispositivo (localização, por exemplo) e multiplica o armazenamento.
- **Bucket público com URLs assinadas ou públicas.** Simplifica a entrega e o cache de borda, mas contraria a minimização de dados e o isolamento por organização.
- **Gerar derivados no upload.** Evita o custo na primeira leitura, mas gera variantes nunca usadas e dificulta mudar os tamanhos.
- **Apagar o master assim que a referência falha.** Simples, porém vulnerável à corrida entre a checagem de referência e a exclusão, motivo do claim com tombstone.

## Emenda (16/10/2026)

Registro datado; a decisão original acima permanece como está. Emenda aceita pelo responsável em 18/10/2026, junto com o [ADR 0076](0076-teto-de-custo-e-free-tier-primeiro.md).

- **Images Hosted fica proibido.** O produto Images Hosted cobra armazenamento e entrega; a mídia continua no R2 privado, com o Images apenas para transformação.
- **Fallback obrigatório acima da franquia de transformações.** Acima de 5.000 transformações únicas no mês, o Images Free retorna o erro 9422 e, segundo a documentação, não cobra (a ausência de cobrança não foi verificada no provedor real; fontes: [preços do Cloudflare Images](https://developers.cloudflare.com/images/pricing) e a descrição do 9422 no [troubleshooting do Images](https://developers.cloudflare.com/images/reference/troubleshooting/)).
  - **Derivados (implementado):** servir o master (já em WebP 1200 px) no lugar do derivado. Na rota de entrega do ERP, o 9422 ao gerar o derivado devolve o master com `Cache-Control: private, max-age=60` e `X-Media-Fallback: master`, sem gravar o master como derivado; o catálogo público já serve o master quando o derivado não existe e não chama o Images.
  - **Upload (implementado):** o upload também consome transformação e o original não pode ser gravado; no erro 9422 durante o upload, o envio é recusado (HTTP 503, código estável `media_transform_quota_exceeded`) com mensagem clara ao usuário, antes de gravar qualquer objeto, e pode ser tentado no próximo ciclo. Os casos emitem o evento `media_transform_quota_exceeded` (`provider: cloudflare_images`, `errorCode: 9422`, `outcome: partial|rejected`) para o alerta futuro. Na entrega, o evento sai no máximo uma vez por minuto por isolate, com o campo `suppressed` (omitido quando 0) contando as entregas em fallback que a janela anterior absorveu; o alerta soma `1 + suppressed` (uma tela com dezenas de miniaturas não gera dezenas de eventos). Cada entrega em fallback ainda relê o master no R2 e tenta o Images, que recusa; sem circuit breaker, a latência extra é aceita enquanto a cota durar. A documentação da Cloudflare não mostra como o binding expõe o 9422; o código aceita `code` 9422 (número ou texto), o número 9422 isolado na mensagem do erro do binding (ou em string lançada; não vale dentro de UUID, de número maior nem como dimensão, e `code` 9412 prevalece) e o cabeçalho `Cf-Resized: err=9422`. Confirmar o formato real no provedor é o item 14 (BLOCK) do [checklist de release](../runbooks/release-checklist.md).
  - **Limites conhecidos da detecção e do log de entrega (apontados na revisão):**
    - *Falso positivo do número 9422 na mensagem.* O número isolado na mensagem do erro do binding poderia aparecer como dimensão (por exemplo, "largura 9422 px"), e o fallback serviria o master sem haver cota estourada. A detecção evita os casos mais prováveis: o número não vale dentro de UUID nem de número maior, e é ignorado quando vem como dimensão: seguido de `px`, `pixel` ou `pixels`, ou de `x` e um número, com ou sem espaço e em maiúscula ou minúscula (`9422 px`, `9422 pixels`, `9422x600`, `9422 X 600`); `9422 x-quota` continua valendo como cota. Risco residual aceito: dimensão que venha antes de outro texto (por exemplo, `600 x 9422` ou "altura 9422"), ou uma mensagem que cite 9422 em outro sentido. O efeito é limitado: servir o master em vez do derivado (no upload, recusar com 503 recuperável), sem gravar objeto nem expor dado de outra organização. O código `code` 9422 e o cabeçalho `Cf-Resized` não têm esse problema; a conferência do item 14 do checklist, inclusive a cada mudança da `compatibility_date` do Worker ou da configuração do binding `images` em `apps/web/wrangler.jsonc` (o binding não tem versão própria), é o que valida o formato real.
    - *Contagem `suppressed` perdida.* O contador da janela em curso vive na memória do isolate e só é emitido quando a janela seguinte abre um novo evento. Se o isolate termina antes disso, as entregas em fallback absorvidas na última janela de 1 minuto não chegam ao log. A subcontagem é aceita: o evento da janela já foi emitido (o alerta dispara), e o `suppressed` serve para dimensionar o volume, não para cobrar nem decidir bloqueio.
  - **Metadados (EXIF/GPS):** o `.output()` do binding aceita só `format`, `quality` e `anim` (documentação do binding, consultada em 18/10/2026); a opção `metadata` (`keep`, `copyright`, `none`) existe só na transformação por URL e `cf.image`. A saída do pipeline é sempre WebP, e a documentação diz que, em WebP e PNG, todos os metadados são sempre descartados (só JPEG pode manter EXIF, com `keep`). Logo não há o que pedir no binding: master e derivados não guardam nem servem EXIF/GPS. Confirmar com uma foto com GPS no teste de provedor real (plano, seção de teste Cloudflare Images).
- **Pendência de go-live:** a cota Pro de 5.000 imagens por organização ([PRODUCT.md](../../PRODUCT.md)), com até 3 transformações por imagem, pode esgotar a franquia mensal de transformações com um único cliente; decidir antes do go-live, junto com o checklist de go-live (`docs/runbooks`).

## Emenda (04/11/2026): miniaturas em lote e cópia no aparelho

Registro datado; a decisão original e a emenda anterior permanecem. Pedido do usuário (miniaturas nas listas de Produtos, na Venda e no Estoque), corte aprovado pelo Arrascaeta em 04/11/2026.

- **`no-store` vale para o HTTP.** Nenhuma resposta de mídia do ERP é guardada por cache do navegador nem por cache compartilhado. A cópia de miniaturas no aparelho, quando existir, vai pelo banco local do namespace (usuário + loja), na mesma classe dos nomes e preços que já ficam offline, e sai com ele ([ADR 0015](0015-offline-persistence-tanstack-db-opfs-indexeddb.md)). O service worker continua sem tocar em `/api/`.
- **Rota em lote.** `GET /api/media/thumbs?organizationId=…&ids=<uuid>,<uuid>,…` entrega até 24 miniaturas numa resposta:
  - 1 a 24 UUIDs separados por vírgula; repetidos (sem diferenciar maiúsculas) são respondidos uma vez, na posição da primeira ocorrência; 0, 25 ou mais, ou um id que não é UUID, dão **400** com o código `invalid_media_thumbs_request`, antes de abrir transação;
  - uma sessão e uma transação tenant com a capability `catalog:read` (a mesma da entrega por imagem); sem sessão, **401**; sem a capability, o mesmo **403** da entrega por imagem;
  - uma consulta resolve todos os ids pelo RLS (imagem vinculada a um produto da organização); só os ids encontrados são lidos no R2, e só o derivado de 320 px;
  - o cabeçalho `X-Polaris-Thumbs` lista os ids na ordem do pedido, separados por vírgula, cada um como `id:bytes` ou `id:missing`; o corpo (`application/octet-stream`, `Cache-Control: private, no-store`, `nosniff`) é a concatenação dos WebP dos ids com `bytes`, na mesma ordem, sem base64 e sem decodificar. O cliente fatia o corpo pelos tamanhos do cabeçalho;
  - **`missing` é uma só resposta** para id de outra organização, inexistente, imagem removida e imagem sem derivado de 320 px: mesmo cabeçalho e mesma forma de corpo. Ids que o RLS não devolve não são consultados no R2, então a leitura do armazenamento também não os distingue;
  - **o lote nunca transforma.** Ele não usa o binding do Images nem gera derivado; o 9422 não o afeta. Imagem sem derivado de 320 px mostra o marcador no aparelho (sem caminho por imagem para gerar o derivado);
  - para pôr os tamanhos no cabeçalho antes do primeiro byte sem guardar os corpos na memória, a rota mede cada derivado com `head` (só metadados) e depois lê os corpos com `get`, um após o outro, com no máximo 6 operações do R2 abertas ao mesmo tempo (o limite de conexões simultâneas do Worker; um corpo aberto sem leitura conta nesse limite). Um derivado que some ou muda de tamanho entre a medida e a leitura corta a resposta (o aparelho vê falha de rede, nunca bytes que não batem com o cabeçalho) e registra `media_thumbs_stream_aborted`. Custo: até 48 operações classe B por lote de 24;
  - falha do R2 ao medir dá **503** `media_processing_unavailable`, como na entrega por imagem.
- **Medida pendente.** O CPU do lote de 24 contra uma entrega por imagem no staging (0 `exceededCpu`, mediana do lote no máximo 5 ms acima) é medida no staging depois do deploy, como critério de aceite do corte das miniaturas.

## Emenda (05/11/2026): o navegador recorta e reduz antes de enviar

Registro datado; a decisão original e as emendas anteriores permanecem. Motivo: no Workers Free, um envio de foto inteira (até 20 MB) passava do teto de 10 ms de CPU por pedido. A leitura do corpo em pedaços, a junção e o SHA-256 do arquivo inteiro custavam a maior parte, e o staging entrou em 1102 em cascata.

- **Preparo no navegador.** Antes de enviar, o painel aplica o recorte, reduz para no máximo 1200 px no lado maior (sem ampliar) e codifica em JPEG 0,9, com fundo branco, porque JPEG não tem transparência. Depois manda `X-Media-Crop` com a imagem inteira (`{x: 0, y: 0, width: 1, height: 1}`). O contrato da rota não muda. O Worker continua re-codificando pelo Images (WebP 85, `scale-down` a 1200 px), e o original nunca é gravado. A foto que entra no Images já não traz os metadados do aparelho, porque o canvas não os copia.
- **Um arquivo preparado por escolha.** O arquivo preparado é gerado uma vez para cada arquivo e recorte escolhidos e reaproveitado nas novas tentativas. Uma nova codificação poderia diferir em um byte, e o servidor responderia 409 ao mesmo comando.
- **Impressão digital sem cópia.** Passa a ser `SHA-256(metadados ‖ 0x00 ‖ SHA-256(bytes))`, e o arquivo não é mais copiado junto dos metadados. A deduplicação e o 409 continuam iguais para o mesmo arquivo preparado. Uma nova tentativa de um comando começado antes do deploy, com a impressão antiga gravada, responde 409. A janela é a de um envio em andamento, e o painel gera um novo id quando o lojista muda o arquivo, o recorte ou as variantes.
- **Derivados no envio.** Medidos localmente, eles são cerca de um terço do CPU que sobra no envio. Ficam como estão até uma decisão própria.
