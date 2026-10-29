# Capturas da t486 (Início enxuto, B2 + B3)

Nomes: `antes-<tela>-<largura>-<tema>.png` e `depois-<tela>-<largura>-<tema>.png`, a 360 px (celular, toque) e 1280 px (mouse), nos temas `claro` e `escuro`. Página inteira.

- **Antes:** `origin/main` em `fd279de1` (já com t480 e t482).
- **Depois:** a branch `ui/inicio-enxuto`, depois do último commit de tela.
- Tiradas com `e2e-pwa/ui-screens.ts` (os mesmos estados da regressão visual), no Chromium do Windows, relógio fixo em 23/10/2026 12:00. Não são as baselines do Docker (amd64): servem para a revisão por olho, não para comparar pixel a pixel.

## Estados

| Arquivo | Estado de `ui-screens.ts` |
|---|---|
| `*-inicio-com-vendas-*` | início com vendas |
| `*-inicio-loja-nova-*` | início loja nova |
| `*-inicio-erro-*` | início erro nos números |
| `*-inicio-sem-rede-com-copia-*` | início sem rede, com cópia |
| `*-inicio-sem-rede-sem-copia-*` | início sem rede, sem cópia |
| `*-resultado-mes-incompleto-*` | resultado mês incompleto e gráfico de vendas |
| `*-resultado-sem-custo-*` | resultado sem custo conhecido |

O estado "carregando" é só para o leitor de tela (esqueleto) e não tem captura própria. O Início com 3 itens de ação a 360 × 740 não está num estado do `ui-screens.ts`: é provado por e2e (`e2e/home.e2e.ts`, "com três itens de ação…").

## Altura da página a 360 px (`document.scrollHeight`, tela cheia; a altura não muda com o tema)

| Estado | Antes | Depois | Diferença |
|---|---|---|---|
| Início com vendas | 2622 px | 2519 px | -103 px |
| Início, loja nova | 852 px | 740 px | -112 px |
| Início, erro nos números | 840 px | 841 px | +1 px |
| Início, sem rede com cópia | 2412 px | 2236 px | -176 px |
| Início, sem rede sem cópia | 740 px | 740 px | 0 px |
| Resultado, mês incompleto e gráfico de vendas | 2636 px | 2706 px | +70 px |
| Resultado, sem custo conhecido | 2615 px | 2737 px | +122 px |

- **A meta da v4 (≈ 1892 px) não é comparável com o app:** o mockup não tinha o bloco "Ritmo de vendas" e usava 3 itens de ação, e o estado `início com vendas` do app traz o Ritmo e 1 item. No app real o Início com vendas perde 103 px (−3,9 %).
- "Loja nova" depois: 740 px é a altura da janela (a página ficou mais curta que ela).
- **O Resultado cresce** (+70 e +122 px) porque os cartões de KPI dele também passam a uma coluna abaixo de 760 px (a emenda v3 vale para "todo cartão de KPI"). Se quiserem o Resultado com Ticket e Margem lado a lado no celular, é decisão de produto; não fiz.
- A diferença de +1 px em "erro nos números" é arredondamento do cabeçalho.
