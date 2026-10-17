# Gate 4 — núcleo de vendas (Fase 4)

Gatilho: fechamento da Fase 4 (clientes e vendas online, PR36–PR47) e qualquer mudança posterior em venda, estoque de venda, cancelamento, devolução, atribuição de cliente ou datas da venda.

O Gate 4 prova seis propriedades: venda atômica, estoque correto, dinheiro correto, cancelamento correto, devoluções corretas e reconciliação de cliente que não altera a economia. Ele combina os gates por etapa (profundidade, cada mecanismo isolado) com um cenário ponta a ponta (composição, tudo junto, contra um oráculo independente).

## Pré-requisitos de acesso

- Siga a [política de perfis de CLI](./cli-profile-policy.md): Neon CLI com o perfil `junior-pessoal` (conta `juniordiniz56@gmail.com`). Não use o plugin ou conector Neon.
- Nenhuma connection string, senha ou token é impressa, gravada em arquivo ou colada em chat. A URL do gate vive só nas variáveis de ambiente do processo e é removida ao final.
- Alvo seguro: uma **branch Neon nova e descartável** (schema-only a partir de `production`, expiração de 24 h) com um banco novo `polaris_prNN_gate`. Nunca reutilize uma branch expirada e nunca copie dados de produção. O banco é recriado do zero: as migrations (0000 em diante) são reaplicadas do começo.
- O plano Neon limita as branches raiz. Apague apenas as branches de gate que você mesmo criou e que já terminaram antes de criar a próxima.
- **Pegada no Neon ([ADR 0025](../adr/0025-estrategia-de-testes-de-banco.md), emenda da issue #115).** O CI já roda todos os gates a cada pull request, então no Neon rode, por pull request, só o gate novo e os gates dos objetos que o PR tocou, numa única branch reaproveitada e apagada logo depois (uma branch nova só quando uma migration ainda não publicada é emendada; rode então o gate novo primeiro). A suíte completa (`gates:all` ou `ci`) fica para uma vez por fase, antes de uma liberação e quando mudam o executor, o suporte comum dos gates ou os privilégios de forma ampla. Diga no relatório do PR o que rodou em Neon e por quê (quais objetos tocados justificam cada gate: não há uma tabela objeto→gate, então cobre-se isso na revisão). "Branch reaproveitada" não muda as regras acima: cada execução do executor recria um banco novo do zero dentro da branch, a reutilização vale só enquanto a branch não expirou e dois gates nunca rodam ao mesmo tempo no mesmo banco. A suíte completa por fase é disparada por quem entrega o último PR da fase (ou pelo responsável) e fica registrada numa linha "Suíte completa em Neon" na seção da fase em `doc/status-implementacao.md`.
- Não rode dois gates ao mesmo tempo no mesmo banco: os gates de falha injetada criam gatilhos nas tabelas compartilhadas e contaminam a execução do outro.

## Passos

1. Criar a branch e o banco (descarte a saída: o comando `neon branches create` imprime a connection string).

       neon branches create --name pr471-review-gate --parent production --schema-only --expires-at <agora+24h, UTC, hora cheia> --project-id green-tooth-16857010 --profile junior-pessoal | Out-Null
       neon databases create --name polaris_pr471_gate --owner-name neondb_owner --branch pr471-review-gate --project-id green-tooth-16857010 --profile junior-pessoal | Out-Null

   O nome da branch precisa casar `^pr\d+-[a-z0-9-]+-gate$`.
2. Em um processo que obtenha a URL direta (sem pooler) com `neon connection-string ... --database-name polaris_pr471_gate --role-name neondb_owner --profile junior-pessoal`, exporte somente neste processo `DATABASE_URL`, `POLARIS_GATE_DATABASE_URL`, `POLARIS_GATE_BRANCH` e `POLARIS_GATE_DATABASE`. Confirme que o host tem o formato `ep-…sa-east-1.aws.neon.tech`, sem `pooler`.
3. Aplicar as migrations do zero (a role `polaris_pr11_runtime` precisa existir antes: ela vem da branch de produção; ver o checklist de go-live): `bun run --filter @polaris/db db:migrate`.
4. Rodar o executor de gates, que roda **em sequência** no mesmo banco, cria o login temporário que alguns gates exigem e o remove ao final:

       bun run --filter @polaris/db gates:gate4   # núcleo de vendas (+ clientes)
       bun run --filter @polaris/db gates:gate3   # catálogo, estoque e mídia
       bun run --filter @polaris/db gates:all     # tudo

   Também é possível escolher gates pelo nome: `bun scripts/run-gates.ts sale-return gate4`. Cada gate termina com `"status": "passed"`; o executor imprime só o resumo (e a cauda redigida de um gate que falhar), nunca a URL.
5. Limpar o ambiente do processo (todas as variáveis acima) e, depois do gate, apagar a branch descartável própria: `neon branches delete <nome> --project-id green-tooth-16857010 --profile junior-pessoal`. A expiração de 24 h cobre o esquecimento, mas não libera o limite de branches raiz antes disso.

Gates avulsos continuam existindo (`poc:sales:verify`, `poc:sales:transaction:verify`, `poc:sales:customer-link:verify`, `poc:sales:cancellation:verify`, `poc:sales:return:verify`, `poc:sales:dates:verify`, `poc:gate4:verify`, `poc:review-hardening:verify`) e usam as variáveis `POLARIS_SALES_GATE_*`; o executor é o caminho recomendado.
## O que prova cada propriedade

| Propriedade | Gate por etapa (profundidade) | Cenário ponta a ponta (`poc:gate4:verify`) |
| --- | --- | --- |
| Venda atômica | `poc:sales:transaction:verify`: falha injetada em cada ponto da transação com rollback conjunto, corridas do mesmo `commandId`, gatilhos deferidos que recusam venda parcial. `poc:sales:verify`: agregado sem venda parcial. | Venda com a segunda linha sem estoque não deixa cabeçalho, item, pagamento, movimento, saldo nem auditoria; repetir uma venda confirmada não muda nada. |
| Estoque correto | Ordem de locks sem deadlock, saldo nunca negativo, custo médio, movimento por item no custo do snapshot. | Um movimento `sale` por item ao custo do snapshot, saldos 47 e 18, média intocada, e o razão explica todos os saldos depois de cada etapa. |
| Dinheiro correto | Biblioteca de dinheiro (PR39), ajustes (PR40), pagamentos (PR41), perfis (PR42): decimal exato, meio-para-cima uma vez por valor. | Subtotal, desconto, frete e total devido coincidem com um oráculo independente em centavos inteiros e com as linhas persistidas; o pagamento único é igual ao total. |
| Cancelamento correto | `poc:sales:cancellation:verify`: reposição ao custo do item, regra da média, corridas cancelamento × cancelamento e × venda, gatilho de completude. | Quantidade inteira volta ao estoque ao custo original, a venda e os movimentos originais não são editados, repetir o comando é replay, a venda cancelada mantém os totais e não aceita devolução. |
| Devoluções corretas | `poc:sales:return:verify`: `returned ≤ disponível`, `restocked ≤ returned`, sequência aleatória contra um modelo, exclusão mútua com o cancelamento, guardas do banco. | Devolvido e reposto são separados, só o reposto movimenta estoque, devolução acima do disponível é recusada, venda com devoluções não cancela, a venda nunca é editada. |
| Reconciliação de cliente não altera a economia | `poc:sales:customer-link:verify`: histórico versionado, concorrência, cliente arquivado. | Atribuir, reatribuir, conflito de versão e remover (inclusive em venda cancelada) mantêm vendas, itens, ajustes, pagamentos, movimentos e saldos idênticos byte a byte. |
| Endurecimentos da revisão do checkpoint | poc:review-hardening:verify: instantes 	imestamptz mesmo com fuso de sessão +14h, timeouts por transação, sequência e reconciliação razão × saldo, cancelamento com produto removido, regra da média na reposição, namespaces de commandId, datas de estoque, grants por coluna, limites, chave de mídia, roles auth × tenant, funções endurecidas. | (coberto pelo gate próprio) |
| Datas (PR47) | `poc:sales:dates:verify`: janela retroativa no calendário da organização e tolerância de futuro (valores em [tempo e datas](../business-rules/time-and-dates.md)), data do razão = data comercial, replay e conflito de `recorded_at`. | Venda de 10 dias atrás grava o movimento na sua data comercial. |

## Limites conhecidos

- Os gates não cobrem a interface no navegador: os modelos de visão têm testes unitários, mas não houve verificação ponta a ponta nem em 360 px nesta fase.
- Só existe o papel `owner`; a janela retroativa por papel e a capability de cada operação só foram exercidas para ele.
- O replay de uma venda **fora** da janela retroativa é provado envelhecendo a linha como dono da tabela (o runtime nunca consegue editá-la); o envelhecimento natural pelo calendário não é observável num gate.
- Não há reembolso nem valor monetário de devolução: a decisão do projeto é que o impacto em vendas líquidas pertence ao motor de métricas.

## Rollback ou forward-fix

O gate não altera recursos persistentes: ele roda só na branch descartável. Se um gate falhar, não prossiga para a próxima etapa; corrija na etapa dona do mecanismo, repita o gate falho e depois todos os anteriores. Escalonamento: responsável pelo projeto.
