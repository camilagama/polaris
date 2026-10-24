# Capturas da t321: rodada 1 do PR 299 (Início sem conexão)

Tiradas sobre o head `42545b5babcaad0f2261da0de116874b33c9b980` da `feat/f2-inicio-offline`, com o app de `build:offline-poc` (runtime offline ligado) e o servidor simulado do `e2e/home.e2e.ts` (relógio em 23/10/2026 12:00 de Brasília), chromium, página inteira (a barra do celular aparece no meio da captura de 360 px porque é fixa), tema por `prefers-color-scheme`. Nenhuma foi commitada no PR.

| Arquivo | Estado | Como foi produzido |
| --- | --- | --- |
| `inicio-sem-rede-com-copia-360-claro.png` | com cópia, sem rede, 360x740, claro | lido com rede, depois `setOffline(true)`: "Último resultado confirmado: 23/10/2026 12:00" sem ponto e "Você pode vender sem internet. A venda é enviada quando a conexão voltar." |
| `inicio-sem-rede-sem-copia-1280-claro.png` | sem cópia, sem rede, 1280x800, claro | cópia apagada e página reaberta sem Worker: Hoje à esquerda, Outubro à direita (mesmo texto), Meta e Precisa de atenção embaixo, "Sem internet: para vender é preciso conexão." |
| `inicio-sem-rede-sem-copia-1280-escuro.png` | o mesmo, tema escuro | idem |
| `inicio-com-rede-1280-claro.png` | com rede, 1280x800, claro | linha "Atualizado até 23/10/2026 12:00" sem ponto |
