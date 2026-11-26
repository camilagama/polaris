# t1949: capturas

- `antes/`: origin/main db683477 (código de produção das cinco telas revertido a ele).
- `depois/`: branch ui/titleline-configuracoes, código de produção igual ao do PR (último commit de código: ver o PR).
- Tirado com Playwright (chromium-desktop) sobre o build `pwa-e2e` (telas de `e2e-pwa/ui-screens.ts`): 1280 e 360 e 320, claro e escuro; mais 320 com letra de 20 px, claro.
- Estados: categorias lista (laboratório, sem aba), aparelhos lista, seus dados com cópias, assinatura oferta com Pix (casca real, aba Assinatura), ajuda; e despesas lista como referência de uma tela que já segue.
- Resultado pixel a pixel (comparador do Playwright, limiar 0,2): iguais Categorias, Aparelhos e Assinatura (31 de 42 byte a byte; Assinatura 1280 igual no limiar). Mudam Seus dados a 1280 (título numa linha de 32 px) e Ajuda em todas as larguras (4 px a menos entre título e frase de apoio).
- Não há captura de erro/vazio/offline de cada tela: o código dessas telas não mudou além do título.
