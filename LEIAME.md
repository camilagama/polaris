# Capturas da t308 (cadastro de produto, colunas pela largura do cartão)

- **antes**: `origin/main` 61bcc26. **depois**: 320, 360 e 768 px do head `28acee6` (sem mudança de código desde então nessas larguras); **900, 1024 e 1280 px refeitas (t311) no head `564ca1a`** da branch `fix/menores-pr286`, com o limite de três colunas em `@min-[46rem]` (736 px de cartão), tiradas depois do último commit de código.
- Formulário "Novo produto" preenchido (nome, preço, quantidade e custo), só o cartão (`locator.screenshot`), build do laboratório (`playwright.offline-poc.config.ts`, chromium-desktop), API respondida pelo teste (spec temporário, não commitado).
- Larguras da janela: 320, 360, 768, 900, 1024 e 1280 px (o cartão mede janela menos 288 px a partir de 768 px). Temas claro e escuro.
- Arquivos: `cadastro-{antes|depois}-{largura}-{claro|escuro}.png`. O antes não tem 900 (tirado só depois, para a faixa de duas colunas).

| Janela | Cartão | Antes | Depois |
|---|---|---|---|
| 360 | 328 px | 1 coluna | 1 coluna (igual) |
| 768 | 480 px | 3 colunas, rótulos em 2 e 3 linhas (39 e 58 px) | 1 coluna, rótulos em 1 linha (19 px) |
| 900 | 612 px | (não tirado; pela regra antiga eram 3 colunas) | 2 colunas, 1 linha (refeita no `564ca1a`, igual) |
| 1024 | 736 px | 3 colunas, 1 linha | **3 colunas, 1 linha** (limite em 736 px de cartão; antes de t311 eram 2 colunas; refeita no `564ca1a`) |
| 1280 | 992 px | 3 colunas, 1 linha | 3 colunas (igual; refeita no `564ca1a`) |
