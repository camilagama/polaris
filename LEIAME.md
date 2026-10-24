# Capturas da t319: o Início sem conexão (F2, PR 6)

Tiradas sobre o head `611667cc88ef7b0409f476ae1880b71a5e9d9598` da `feat/f2-inicio-offline`, com o app de `build:offline-poc` (runtime offline ligado) e o servidor simulado do `e2e/home.e2e.ts` (relógio em 23/10/2026 12:00 de Brasília), chromium, página inteira (a barra do celular aparece no meio das capturas de 360 px porque é fixa), tema pelo `prefers-color-scheme`. Nenhuma foi commitada no PR.

| Estado | Como foi produzido |
| --- | --- |
| sem-rede-com-copia | lido com rede (meta em andamento), depois `setOffline(true)`: cópia, "Último resultado confirmado", "Você pode vender sem internet…", "Avisos do estoque só com conexão." |
| sem-rede-sem-copia | a cópia apagada antes de a rede cair: "Sem internet e sem números guardados neste aparelho", "Metas só com conexão." |
| sem-rede-copia-de-25-h | reaberto sem resposta do Worker (navigator.onLine verdadeiro) 25 h depois da leitura: aviso de desatualizado e "Sem números de hoje neste aparelho" |
| sem-rede-meta-terminou | meta que termina em 23/10, reaberto sem rede em 24/10 01:00: "Esta meta terminou. O resultado sai com conexão." |
| sem-rede-copia-sem-serie | cópia sem `daily` (formato antigo): os totais, sem Hoje, gráfico, miniatura nem comparação |

Cada estado em 360 e 1280 px, claro e escuro (20 arquivos, todos do SHA acima).
