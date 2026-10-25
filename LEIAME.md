# t376 — quadros com tempo marcado do gráfico do Início (PR 323)

- Código: `aaacf122` da branch `feat/graficos-bklit` (nada commitado nas capturas; tiradas depois do último commit). 360x740, toque, claro e escuro. Dados simulados do `home.e2e.ts`; nenhum dado real.
- Relógio do Playwright pausado: o tempo no nome é o tempo do relógio da página (0 = primeiro passo depois que o desenho entrou na página), não o da captura de tela, que varia. Os passos são deterministas.
- `entrada-<ms>ms-<tema>.png`: entrada do gráfico de 7 dias em 0, 200, 400, 700 e 1100 ms (a revelação dura 1 100 ms).
- `troca-7-para-30-<ms>ms-<tema>.png`: troca 7 → 30 dias (0 = logo depois do toque na aba), mesmos tempos. É o comportamento DEPOIS: o gráfico não remonta, não há nova revelação.
- `antes-troca-7-para-30-<ms>ms-<tema>.png` (e `antes-entrada-*`): o mesmo roteiro com o `home-chart.tsx` do head `19fca67e` (um painel de aba por período, o gráfico de 30 dias é outra instância e revela de novo: vazio a 200 ms, desenhado só perto de 1 100 ms). Só o `home-chart.tsx` difere do "depois".
- O que se vê no "depois": o caminho troca de uma vez (o `AreaChart` do Bklit não faz morph do caminho; o hook `useAnimatedSeriesPath` existe no registry e nenhum bloco o usa) e o eixo Y anima os 500 ms do tween do domínio.
- Não capturados: 320 px, 1280 px, estados vazio/erro/offline (sem mudança nesta rodada; cobertos pelo e2e do Início), vídeo (o Petković não abre vídeo).
