# Capturas da t305 (rodada do PR 286)

Tiradas no head `ef5e38b` da branch `feat/f2-produto-estoque-abertura`, depois do último commit, com o build do laboratório (`playwright.offline-poc.config.ts`, chromium-desktop) e a API respondida pelo teste (spec temporário, não commitado).

Larguras: 320x740, 360x740, 768x800 (só o formulário) e 1280x800. Temas claro e escuro (`prefers-color-scheme`). Página inteira (`fullPage`): a barra de baixo, fixa, aparece no meio das capturas de 320/360 com formulário aberto.

| Arquivo | Estado |
|---|---|
| formulario-preenchido-* | Formulário com nome, "Preço de tabela · Opcional" 49,90, quantidade 10 e "Custo de cada unidade · Opcional" 12,50 |
| sucesso-com-estoque-* | Online (servidor): "Produto “Camiseta básica” cadastrado com 10 unidades." |
| sucesso-sem-estoque-* | Online (servidor), sem quantidade: "Produto “Camiseta básica” cadastrado." |
| aparelho-sucesso-com-estoque-* | Laboratório offline, sem rede: "Produto “Camiseta básica” salvo neste aparelho com 10 unidades. Ele será enviado quando a conexão voltar." |
| aparelho-sucesso-sem-estoque-* | Laboratório offline, sem rede, sem quantidade: "Produto “Caneca” salvo neste aparelho. Ele será enviado quando a conexão voltar." |

Notas:
- No modo servidor o aviso aparece sobre "Nenhum produto ainda": o servidor simulado não devolve a lista depois do cadastro (não é defeito da tela).
- A 768 px os rótulos das três colunas quebram em duas ou três linhas e o campo do custo fica mais baixo que os outros. O "(opcional)" de antes também quebrava. Fica como pendência para o Petković.
