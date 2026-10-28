---
status: accepted
---

# Suíte de navegador do offline e compatibilidade entre versões

## Contexto

O PR62 do plano pede automatizar: recarregar, matar e reabrir, reconectar, duas abas, conflito, versão antiga do app e atualização pendente, e completar o Gate de Safari físico antes do go-live. Quase todos já tinham prova no nível certo, em PRs anteriores; faltavam três e uma visão do conjunto.

## Decisão

- **Cada cenário é provado no nível mais barato que o prova de verdade**, e o conjunto está mapeado no runbook do Gate 5:
  - recarregar e matar/reabrir: outbox em IndexedDB e coleções em OPFS reais, em Chromium desktop e Pixel 5 emulado (`e2e/offline-outbox`, `offline-local-collections`, `offline-poc`);
  - reconectar: a saída com pendências que, voltando a rede, envia a fila e conclui (`e2e/offline-logout`);
  - conflito: o painel de atenção sobre o outbox real (`e2e/offline-attention`) e os gates de banco (`offline-stock`, `offline-sale`, `offline-e2e`);
  - duas abas: **novo**, duas abas do mesmo usuário compartilham a fila e um comando em envio não é enviado de novo pela outra aba; o próximo vai quando o primeiro é confirmado (`e2e/offline-outbox`); a coordenação das coleções entre abas já era do PR12;
  - atualização pendente: **novo**, com duas builds reais do app (`e2e-pwa/update*.e2e.ts`). Desde a emenda de 28/10/2026 do ADR 0041 a build nova entra sozinha num momento seguro: os testes provam que a aba oculta troca, que um diálogo, uma venda com item ou trabalho na fila seguram, que só a aba sem rascunho troca e a segurada abre um pedaço da build dela, a volta depois de 5 min, a aba ociosa, a decantação de 2 h e o desfazer. O teste faz o papel do outbox por um gancho que só existe na build de verificação (`--mode pwa-e2e`, ausente da build de produção);
  - versão antiga do app: **novo**, um arquivo dourado com o payload e a versão-base que cada tipo de comando põe hoje no outbox (`server/sync/__golden__/command-payloads.json`).
- **O arquivo dourado torna a compatibilidade uma decisão deliberada.** Mudar o que um construtor emite quebra o primeiro teste (que compara com o arquivo), e é nesse momento que se escolhe: manter o servidor aceitando o formato antigo (o segundo teste, que passa cada payload do arquivo pelo `parse` dos manipuladores registrados, precisa continuar passando e cobre todos os tipos registrados) ou dar ao comando um tipo ou versão novos. Atualizar o arquivo é consciente (`vitest -u`).
- **Regra de versões.** O contrato só cresce: campos opcionais novos, tipos novos, nunca um campo removido ou reinterpretado. O servidor vai ao ar antes do app que usa um campo novo, porque o payload da venda é estrito e recusa campos que não conhece (`invalid_payload`: a venda de um app mais novo que o servidor volta como recusada, nunca aplicada pela metade; um teste prova isso). Uma build antiga convive com o servidor novo enquanto a regra for cumprida.
- **Execução.** `bun run test:offline-browser` (em `apps/web`) roda as duas configurações de navegador; o CI roda ambas no job de navegador. A configuração `pwa` inclui, desde 28/10/2026, a regressão visual, que usa o navegador de uma imagem Docker fixa ([testes-de-tela](../runbooks/testes-de-tela.md#regressão-visual)). O PWA é verificado em série, porque os cenários de atualização recompilam o diretório compartilhado.
- **Alcance da regressão visual.** Nova venda, Detalhe da venda, Histórico, Estoque, Despesas, Catálogo público e Pendências são capturados pelo laboratório das telas, sem o shell. A regressão do shell (barra, navegação, Mais) fica coberta só pelos estados que o têm: Início, Assinatura e 404.

## Consequências

- O que a suíte automatizada não alcança continua sendo o aparelho físico (Safari de iPhone e Chrome de Android reais), no checklist do Gate 5, que ainda bloqueia ligar a escrita offline.
- Um novo tipo de comando offline é obrigado a entrar no arquivo dourado (o teste cobre todos os tipos registrados), o que o amarra à regra de compatibilidade desde o primeiro dia.

## Alternativas rejeitadas

- **Testar a compatibilidade rodando duas builds do app contra o servidor:** caro e lento para o que um arquivo dourado mais o `parse` real dos manipuladores já garante.
- **Aceitar campos desconhecidos na venda:** deixaria um app novo gravar uma venda sem os campos que o servidor não entende, em silêncio.
