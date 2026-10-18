# Gate 5 — offline (Fase 5)

Gatilho: fechamento da Fase 5 (PR48 a PR59) e qualquer mudança posterior em dispositivos, lease, change log, bootstrap, outbox, `sync.push`, comandos offline, painel de atenção ou saída com pendências.

O plano define o Gate 5 assim: o offline só é considerado pronto quando (1) um iPhone real funciona, (2) um reinício preserva o outbox, (3) um envio duplicado é seguro, (4) um conflito de estoque não corrompe nada e (5) sair da conta não perde dados em silêncio. O que o software consegue provar sozinho está automatizado abaixo; o que exige o aparelho físico é o **checklist manual** no fim, e **bloqueia ligar a escrita offline em produção** (ADR 0032).

## Pré-requisitos de acesso

- Siga a [política de perfis de CLI](./cli-profile-policy.md): Neon CLI com o perfil `junior-pessoal`. Não use o plugin ou conector Neon.
- Nenhuma connection string, senha ou token é impressa, gravada ou colada em chat; a URL do gate vive só nas variáveis de ambiente do processo e é removida ao final.
- Alvo seguro: uma **branch Neon nova e descartável** (filha da `production` do projeto Neon descartável dos gates, sem `--schema-only`, expiração de 24 h) com um banco novo, as migrations reaplicadas do zero e apenas dados sintéticos. Nunca use um projeto com dados reais de clientes. O procedimento de criação da branch é o do [Gate 4](./gate-4-sales-core.md#prova-antes-de-liberação-em-neon).
- Não rode dois gates ao mesmo tempo no mesmo banco.

## Passos automáticos

    CI=true bun scripts/run-gates.ts gate5     # suíte offline (Fase 5), a partir de packages/db; também roda na suíte ci do CI
    bun run --filter @polaris/db gates:all     # tudo

A suíte `gate5` roda, em sequência: `offline-devices`, `offline-lease`, `sync-log`, `bootstrap`, `sync-push`, `offline-product`, `offline-customer`, `offline-stock`, `offline-sale` e `offline-e2e`. Cada um termina com `"status": "passed"`.

Localmente, `bun run test:offline-browser` (em `apps/web`) roda as duas configurações de navegador. Os cenários do PR62 (recarregar, matar e reabrir, reconectar, duas abas, conflito, atualização pendente) e sua cobertura estão no [ADR 0042](../adr/0042-suite-de-navegador-do-offline-e-versoes.md); a compatibilidade com versões antigas do app está no arquivo dourado de payloads.

No CI, o job **Offline persistence browser gate** roda os cenários de navegador (Chromium desktop e Pixel 5 emulado) da persistência (PR12), das coleções locais (PR50b), do outbox (PR52), do painel de atenção (PR58) e da saída com pendências (PR59); o job de gates PostgreSQL 18 roda a suíte `ci`, que inclui as provas de banco acima.

## O que prova cada critério

| Critério do plano | Prova automática | Onde |
| --- | --- | --- |
| Reinício preserva o outbox | Comandos enfileirados sobrevivem a recarregar e mantêm a ordem; um comando `sending` interrompido volta à fila na mesma posição; o mesmo comando repetido não entra duas vezes; a limpeza recusa apagar comandos sem descarte explícito. | `e2e/offline-outbox.e2e.ts`, `e2e/offline-logout.e2e.ts` (IndexedDB e OPFS reais, Chromium e Pixel 5 emulado) |
| Envio duplicado é seguro | O resultado de cada comando é gravado uma vez por `commandId` e repetido igual; o mesmo ID com conteúdo diferente é recusado sem gravar; oito envios simultâneos executam uma vez; uma resposta perdida é reenviada e repetida, para os sete tipos de comando. | `sync-push`, `offline-product`, `offline-stock`, `offline-sale`, `offline-e2e` |
| Conflito de estoque não corrompe | Uma baixa ou venda que não cabe é recusada inteira, sem rastro (sem venda, pagamento, movimento ou saldo alterado); contagem contra saldo que mudou é recusada; duas contagens e duas baixas concorrentes: uma vence e o saldo nunca fica negativo; o razão explica todos os saldos ao final; a versão que o aparelho prevê é a do servidor. | `offline-stock`, `offline-sale`, `offline-e2e` |
| Conflito se corrige sem "forçar" | Venda recusada é reenviada como comando novo depois de corrigir a causa; contagem obsoleta e SKU em uso são descartadas e refeitas; acesso revogado vira `needs_attention` sem reenvio; não existe botão que force a sincronização. | `offline-e2e`, `e2e/offline-attention.e2e.ts`, testes de marcação do painel |
| Sair não perde dados em silêncio | Com fila: envia primeiro; sem rede ou com recusa, a saída é bloqueada e nada é apagado; descartar exige confirmação em duas etapas e informa quantas operações se perdem; a limpeza do outbox se recusa a apagar comandos sem o flag. | `e2e/offline-logout.e2e.ts`, `logout-guard.test.ts` |
| Autorização e tenant | Lease assinado, épocas, grants e capacidades revalidados a cada comando; um aparelho revogado não confirma nada; outra organização não alcança dados nem IDs. | `offline-devices`, `offline-lease`, `sync-push`, `offline-e2e` |
| Telas leem do aparelho | Com o runtime pronto, clientes e produtos listam das coleções locais, cadastram sem rede com o selo "Aguardando envio", bloqueiam arquivar/restaurar/variantes/imagens sem rede e tudo sobre o que o servidor ainda não confirmou, avisam cliente repetido só com dados do aparelho e, numa segunda visita sem rede, mostram o que ficou; ao voltar a rede o servidor confirma e as ações voltam. | `e2e/offline-screens.e2e.ts` (telas reais sobre o runtime real, [ADR 0045](../adr/0045-telas-lendo-do-aparelho.md)), `customers/local-customers.test.ts`, `catalog/local-products.test.ts` |
| Venda e estoque sem conexão | Sem rede, a venda do formulário real é guardada no aparelho (um comando, ID e instante da tentativa), sem perfil e sem data digitada, o estoque do aparelho já desconta o que está na fila, aparece como não confirmada e o servidor a confirma ao voltar a rede; estoque insuficiente no aparelho avisa e guarda, e a recusa do servidor fica em Pendências; com rede o botão é o do servidor; receber/contar/baixar sem rede ficam na fila sem custo médio e baixa acima do saldo do aparelho é recusada pelo formulário; uma venda travada (sem resposta do servidor) nunca muda de conteúdo e, sem perfil nem data digitada, pode ser guardada no aparelho como a MESMA venda, que o servidor reconhece sem duplicar (gate `offline-sale`, passo 1b). | `e2e/offline-screens.e2e.ts` ([ADR 0046](../adr/0046-venda-e-estoque-sem-conexao.md)), `sales/queue-offline-sale.test.ts`, `sales/offline-sale-model.test.ts`, `offline/local-stock-entries.test.ts`, `inventory/offline-stock.test.ts` |
| Perfil de pagamento sem conexão | Sem rede a tela de venda oferece os perfis da última conexão, guarda a venda com o perfil (id e versão) e o servidor a confirma registrando o perfil e a versão; com o perfil mudado, arquivado ou inexistente a venda é recusada inteira, sem rastro, com código próprio, visível em Pendências com "Reenviar sem perfil de pagamento"; a venda enviada direto e depois pelo aparelho é a mesma venda. | `e2e/offline-screens.e2e.ts` (perfil), gates `offline-sale` (1c a 1e) e `offline-e2e`, `server/sync/handlers/sale-confirm.test.ts`, `offline/sale-confirm.test.ts`, `offline/attention.test.ts`, `lib/payment-profile-cache.test.ts` ([ADR 0049](../adr/0049-perfil-de-pagamento-na-venda-sem-conexao.md)) |
| Edição de cliente sem conexão | Sem rede o cliente é editado e a alteração aparece de imediato com o selo "Alteração aguardando envio" (sobreposta, a linha local não muda); o servidor a aplica só sobre a versão que o aparelho viu; se o cliente mudou em outro aparelho, a alteração é recusada inteira (`customer_version_conflict`), sem sobrescrever nada e sem auditoria, e fica em Pendências só com "Descartar"; repetir o envio devolve o mesmo resultado; cliente inexistente, de outra organização ou perfil inválido são recusados sem rastro. | `offline-customer`, `e2e/offline-screens.e2e.ts` (edição), `offline/customer-update.test.ts`, `server/sync/handlers/customer-update.test.ts` ([ADR 0050](../adr/0050-edicao-de-cliente-sem-conexao.md)) |
| Aparelhos | A tela lista os aparelhos ativos (este primeiro), revogar pede confirmação que diz o que se perde, cancelar não faz nada, revogar mostra quantas autorizações offline foram canceladas e tira o aparelho da lista, este aparelho só sai por "Sair", sem conexão não há como revogar. | `e2e/offline-devices.e2e.ts`, `offline/runtime/devices-model.test.ts` ([ADR 0048](../adr/0048-tela-de-aparelhos.md)) |
| Histórico sem conexão | Sem rede, o histórico lista as vendas recentes do aparelho (últimas 100), filtra por situação, data e cliente, não oferece detalhe nem busca por item; com rede volta a ser o do servidor. | `e2e/offline-screens.e2e.ts` (histórico), `sales/local-history.test.ts` ([ADR 0046](../adr/0046-venda-e-estoque-sem-conexao.md)) |
| Duas abas | O cadastro feito numa aba aparece na outra sem recarregar, com o selo de envio; o aviso é só a notícia (sem dados) e a aba que fechou os armazenamentos deixa de ouvir. | `e2e/offline-screens.e2e.ts` (duas abas), `offline/runtime/offline-runtime.test.ts` ([ADR 0045](../adr/0045-telas-lendo-do-aparelho.md)) |
| App abre sem rede | Depois de uma visita online, o app real abre sem rede com a organização lembrada; sem visita anterior diz que não foi possível carregar; sessão encerrada apaga a cópia e ela não é oferecida nem offline depois; aberto da cópia, a lista verdadeira entra quando a rede volta. | `e2e/offline-entry.e2e.ts`, `lib/organizations-cache.test.ts` ([ADR 0047](../adr/0047-abrir-o-app-sem-rede.md)) |
| Números e invariantes | Totais da venda conferidos em centavos contra um oráculo independente; razão × saldo; saldos nunca negativos; uma saída gravada por comando. | `offline-e2e` |

## Checklist manual em aparelho físico (adiado; bloqueia ligar a escrita offline)

Nada desta lista foi executado. Registre o resultado de cada item com a versão do navegador e do sistema, sem dados reais de clientes.

- [ ] **iPhone real (Safari, e instalado na tela inicial como PWA):** abrir o laboratório offline de persistência, o do outbox e o das coleções locais; confirmar que OPFS e IndexedDB funcionam, que `navigator.storage.persist()` responde e que o armazenamento não é descartado após dias sem uso (política do ITP do Safari para sites não instalados).
- [ ] **Android real (Chrome):** os mesmos laboratórios, e o ciclo completo: criar cliente, produto com estoque, entrada, venda e contagem sem rede; religar a rede; conferir o resultado no servidor.
- [ ] **Telas de clientes e produtos com a chave ligada (build de staging com `VITE_OFFLINE_RUNTIME_ENABLED=true`):** cadastrar um cliente e um produto em modo avião, ver o selo "Aguardando envio", fechar e reabrir o app ainda sem rede (os dois continuam na lista), religar a rede e conferir que o selo some e o servidor tem os dois; tentar arquivar um deles em modo avião (botão desabilitado, com a razão no cartão).
- [ ] **Edição de cliente sem conexão (staging, chave ligada):** em modo avião corrigir o telefone de um cliente já cadastrado e ver "Alteração aguardando envio"; religar a rede e conferir no servidor a versão nova e o selo sumindo; repetir editando o mesmo cliente por outro aparelho com este sem rede e ver, ao religar, "Alteração recusada pelo servidor" e, em Pendências, só "Descartar", com o cadastro do outro aparelho intacto.
- [ ] **Venda de cartão com perfil sem conexão (staging, chave ligada):** abrir a tela de venda com conexão (para guardar os perfis), em modo avião vender no cartão escolhendo o perfil, religar a rede e conferir no servidor que a venda registrou o perfil e a versão; repetir depois de alterar o perfil no servidor com o aparelho sem rede e ver a recusa em Pendências e o "Reenviar sem perfil de pagamento".
- [ ] **Revogar um aparelho perdido (staging, chave ligada):** com dois aparelhos registrados na mesma conta, revogar um pelo outro na tela Aparelhos; o revogado, ao reconectar, não consegue enviar o que tinha guardado (fica recusado) e se registra de novo ao entrar; conferir que as autorizações offline dele foram canceladas.
- [ ] **Abrir o app sem rede (staging, chave ligada):** entrar e abrir o app com rede; fechar; em modo avião abrir de novo (também com o app instalado na tela inicial): a organização aparece e as telas de clientes, produtos, venda e estoque abrem do aparelho; "Sair" e abrir de novo sem rede mostra que não foi possível carregar (a cópia foi apagada).
- [ ] **Venda e estoque sem conexão com a chave ligada (staging):** em modo avião, vender dois itens (com um preço negociado) e ver "Venda guardada neste aparelho" e o saldo do aparelho descer; receber estoque de um item; religar a rede e conferir no servidor a venda confirmada, o movimento e o saldo final; repetir com um item cujo saldo no aparelho não cobre e ver a recusa em Pendências; conferir que, com rede, o botão da venda é "Confirmar venda".
- [ ] **Shell offline (PR60):** instalar o app, ativar o modo avião e abrir de novo: o shell abre, inclusive numa rota interna; no iPhone, repetir com o app instalado na tela inicial e depois de alguns dias sem abrir.
- [ ] **Atualização do app (PR61):** publicar uma build nova em staging com a anterior aberta num aparelho; o aviso aparece sem recarregar a página; com operações na fila, "Enviar e atualizar" envia antes e só recarrega com a fila vazia; sem rede, a atualização fica para depois e nada se perde.
- [ ] **Matar e reabrir o app** no meio de um envio (modo avião durante a sincronização): a fila volta inteira, o comando `sending` é reenviado e confirmado uma vez.
- [ ] **Duas abas** do mesmo usuário e organização: a fila e as coleções são as mesmas; um comando não é enviado duas vezes.
- [ ] **Sair com pendências** no aparelho: bloqueia, oferece tentar de novo e descartar em duas etapas; depois de sair, os dados locais da organização somem.
- [ ] **Relógio do aparelho** adiantado e atrasado em horas: comandos com instante de criação fora do lease são recusados com `invalid_creation_time` e a venda não é perdida.

## Ordem de publicação

O servidor vai ao ar antes do app que usa um campo novo de comando: o payload da venda é estrito e um app mais novo que o servidor tem a venda recusada (`invalid_payload`). Nunca remova nem reinterprete um campo de comando; o arquivo dourado de payloads falha quando um construtor muda.

## Rollback ou forward-fix

Os gates não alteram recursos persistentes: use apenas a branch descartável própria e apague-a ao final (`neon branches delete <nome> --project-id green-tooth-16857010 --profile junior-pessoal`). Uma falha de gate é corrigida com um commit novo; nunca com reset ou force-push.

## Escalonamento

Responsável pelo projeto. Uma falha em qualquer critério acima impede ligar a escrita offline; a leitura offline (coleções locais) pode seguir independentemente.
