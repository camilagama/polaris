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

Registro datado; a decisão original acima permanece como está.

- **Images Hosted fica proibido.** O produto Images Hosted cobra armazenamento e entrega; a mídia continua no R2 privado, com o Images apenas para transformação.
- **Fallback obrigatório acima da franquia de transformações.** Acima de 5.000 transformações únicas no mês, o Images Free retorna o erro 9422 e não cobra; a geração de derivados precisa de fallback — servir o master ou uma variante pré-gerada — para não quebrar a tela. **PENDENTE de implementação pelo time de desenvolvimento** (comportamento do erro 9422 em developers.cloudflare.com/images/pricing).
- **Pendência de go-live:** a cota Pro de 5.000 imagens por organização ([PRODUCT.md](../../PRODUCT.md)), com até 3 transformações por imagem, pode esgotar a franquia mensal de transformações com um único cliente; resolver antes do go-live.
