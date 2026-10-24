# t294: capturas da rodada do PR 281

Tiradas sobre o head `59d65c5808bfd689ceed77b604fc0b956f389b8b` (feat/v51-t286), depois do último commit, a 360x740 e 1280x800, nos temas claro e escuro. Servidor e laboratório simulados pelo teste (Playwright, chromium-desktop, build offline-poc).

| Arquivo (prefixo) | Estado |
|---|---|
| `estoque-sem-custo-sem-internet-*` | Estoque aberto por `?filtro=sem-custo`, sem rede: sem contagem; lista diz "Sem internet. A lista de variantes sem custo só carrega com conexão." (laboratório das telas offline) |
| `produtos-produto-erro-*` | `/products?produto=<uuid>` com o servidor fora: um alerta só, o da lista, com "Tentar novamente" |
| `produtos-produto-recuperado-*` | Mesmo endereço depois do servidor voltar e do "Tentar novamente": painel do produto aberto (o foco no título é provado no e2e, não aparece na imagem) |

Substituem `estoque-sem-custo-sem-internet-*` e `produtos-produto-erro-*` da captura anterior (af38de5).
