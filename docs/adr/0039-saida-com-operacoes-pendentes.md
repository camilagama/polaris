---
status: accepted
---

# Sair com operações pendentes: enviar primeiro, descartar só de propósito, apagar depois

## Contexto

A fila de comandos do aparelho é a única cópia do trabalho que o servidor ainda não viu. Sair da conta (ou trocar de usuário no mesmo navegador) apaga os dados locais do usuário (ADR 0015), então uma saída descuidada perderia vendas feitas no balcão. O PR59 do plano pede: com pendências, tentar sincronizar ou pedir descarte explícito; depois da saída, apagar os dados locais do tenant.

## Decisão

- **Quatro passos, nessa ordem, por organização no aparelho** (`attemptLogout`, `offline/logout-guard.ts`): (1) fila vazia: apagar os dados locais e liberar a saída; (2) fila com comandos: tentar enviar primeiro; se esvaziar, apagar e liberar; (3) caso contrário, a saída é **bloqueada** (`blocked`), com a razão (`offline`, `refused`, `still_pending`), as contagens (inclusive os comandos `sending`, cuja resposta é desconhecida) e o resumo de atenção (ADR 0038) das recusas; (4) nada é apagado em nenhuma organização enquanto qualquer uma ainda tiver trabalho: a pessoa decide antes.
- **Descartar é sempre uma escolha explícita.** `discardAndLogout` exige a confirmação como argumento (`confirmed: true`) e informa quantas operações foram descartadas. Não existe "sair assim mesmo" e não há caminho que descarte por omissão. A janela de diálogo (`LogoutDialog`) tem quatro saídas: tentar enviar de novo, ver o que precisa de atenção (só quando o servidor recusou algo), ficar conectado e "Descartar e sair…", que é de duas etapas e diz quanto será perdido e, se houver comandos já enviados, que o servidor pode tê-los recebido.
- **Apagar os dados locais protege a si mesmo.** `purgeNamespace` remove primeiro o outbox (com os leases assinados dentro), que se recusa a apagar comandos a menos que receba `discardPending`, e só depois as coleções locais; uma recusa deixa as coleções intactas. Mesmo um erro neste código não perde comandos em silêncio.
- **Ordem para quem chama:** primeiro `attemptLogout` ou `discardAndLogout`; encerrar a sessão no servidor só quando o resultado for `ready`. Se a limpeza falhar, a pessoa continua conectada e com os dados, em vez de desconectada com sobras no aparelho.
- **Prova em navegador real.** O laboratório `/offline-logout-lab` (só no modo offline-poc) usa o guarda, a janela e a limpeza reais sobre o outbox em IndexedDB e o banco em OPFS, com rede e servidor simulados. Os cenários (Chromium desktop e Pixel 5 emulado) cobrem: fila vazia apaga na hora; com rede, envia e só então apaga; sem rede, bloqueia sem perder nada, inclusive após recarregar; voltando a rede, tentar de novo conclui; recusa do servidor bloqueia e oferece ver a atenção; descarte em duas etapas.

## Consequências

- Quando o app tiver tela de conta, o botão "Sair" chama `attemptLogout` com um `LogoutWorkspace` por organização (outbox, `syncOutbox` como `trySync`, `purgeNamespace`) e só então o `signOut` do servidor.
- Sem rede, a pessoa que precisa mesmo sair tem o caminho explícito do descarte; o texto avisa o que se perde.
- Trocar de usuário no mesmo navegador usa o mesmo guarda, porque cada usuário e organização tem seu próprio namespace (ADR 0015).

## Alternativas rejeitadas

- **Apagar sempre e avisar depois:** perde trabalho que não existe em outro lugar.
- **Manter os dados ao sair e só trancar a interface:** deixa dados do tenant e leases em um aparelho sem sessão, que é o que a limpeza existe para evitar.
- **"Sair assim mesmo" com um clique:** é o descarte silencioso disfarçado.
