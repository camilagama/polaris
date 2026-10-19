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
