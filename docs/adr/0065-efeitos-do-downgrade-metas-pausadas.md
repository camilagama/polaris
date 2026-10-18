---
status: accepted
---

# Efeitos do downgrade sobre metas, imagens, lease offline e catálogo público

## Contexto

O plano (PR83) pede, para quem sai do Pro, quatro efeitos além das variantes (ADR 0064): despublicar o catálogo público, parar novos leases offline, restringir as imagens excedentes e pausar as metas excedentes, "preservando a integridade histórica". Parte já existe: o servidor não emite lease sem `offline.write` e um comando que chega depois do downgrade é recusado (ADR 0058); as adições de imagem acima do limite são recusadas (ADR 0058); o catálogo público ainda não existe. Faltava decidir as **metas** e registrar o que cada um dos outros efeitos significa.

## Decisão

- **Meta pausada é derivada, nunca guardada.** Com mais metas em andamento do que o limite em vigor (`goals.active.max`, concessões incluídas), as mais antigas, até o limite, continuam rodando e as **mais novas** ficam pausadas (`pausedGoalIds`, puro; empate por ID). Uma meta que ainda não começou fica depois das que já começaram (não toma o lugar da meta do período em curso), e uma meta cujo período já terminou não ocupa lugar: a própria leitura a liquida. Nada muda na linha da meta: cancelar uma meta que roda põe a seguinte para rodar, subir de plano ou ganhar uma concessão despausa sozinho, e uma meta futura que começa passa a ser ordenada pela idade como as outras (a que roda pode mudar nesse dia).
- **O que "pausada" significa:** não é medida (não mostra progresso e não conclui por atingir o alvo enquanto pausada), não pode ser editada (`goal_paused_by_plan`, conflito) e continua podendo ser **cancelada**. Uma meta cujo período terminou nunca é pausada: é liquidada na leitura (concluída ou encerrada pelo que o período mediu), então o histórico fica correto e ela não ocupa vaga. Quando uma meta pausada volta a rodar, é medida desde o início do seu período: se já tinha atingido o alvo, conclui na próxima leitura. A leitura de metas informa `paused` por meta; criar uma meta continua recusado acima do limite (ADR 0058).
- **Lease offline:** sem `offline.write` não há lease novo, o lease vigente nunca passa do fim do acesso Pro e um comando que chega depois do downgrade é rejeitado sem perder o que está na fila do aparelho. Já estava implementado e provado (ADR 0058, gate `entitlements`); este PR não o altera.
- **Imagens:** as excedentes são **preservadas**; a restrição é que nenhuma imagem nova entra acima do limite (ADR 0058), e, quando o catálogo público existir, só as que o plano em vigor permite aparecem nele. Não há remoção nem bloqueio da imagem em si.
- **Catálogo público:** não existe ainda. A regra fica registrada para a Fase 8: a página só é servida se a organização tem `public_catalog` no plano em vigor (lido a cada pedido, não gravado como "publicado"), então o downgrade a despublica sem apagar nada e o upgrade a republica.
- **Integridade histórica:** cancelamento e devolução de venda antiga, contagem e baixa de estoque seguem permitidos (ADR 0064); nada aqui altera vendas confirmadas.

## Consequências

- Quem volta ao Free com três metas vê duas pausadas, com o motivo, em vez de metas que somem ou medem sem parar.
- Cada leitura e edição de meta consulta o plano quando há meta em andamento (uma consulta de metas e as de entitlement): o volume é de metas por organização, poucas.
- A pausa vale no servidor (a edição é recusada) e na interface (sem o botão de editar e com o texto do motivo).

## Alternativas rejeitadas

- **Gravar um estado "pausada" na meta:** exigiria um job para pausar e despausar a cada mudança de plano e abriria divergência com o plano em vigor.
- **Pausar as mais antigas:** a meta em curso há mais tempo é a que mais perderia o acompanhamento; a mais nova é a que menos perde.
- **Medir a meta pausada mesmo assim:** o plano não a inclui; a pausa seria só um rótulo.
- **Não liquidar a meta pausada cujo período acabou:** deixaria uma meta vencida ocupando vaga até o plano mudar.
