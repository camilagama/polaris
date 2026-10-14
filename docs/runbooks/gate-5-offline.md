# Gate 5 — offline (Fase 5)

Gatilho: fechamento da Fase 5 (PR48 a PR59) e qualquer mudança posterior em dispositivos, lease, change log, bootstrap, outbox, `sync.push`, comandos offline, painel de atenção ou saída com pendências.

O plano define o Gate 5 assim: o offline só é considerado pronto quando (1) um iPhone real funciona, (2) um reinício preserva o outbox, (3) um envio duplicado é seguro, (4) um conflito de estoque não corrompe nada e (5) sair da conta não perde dados em silêncio. O que o software consegue provar sozinho está automatizado abaixo; o que exige o aparelho físico é o **checklist manual** no fim, e **bloqueia ligar a escrita offline em produção** (ADR 0032).

## Pré-requisitos de acesso

- Siga a [política de perfis de CLI](./cli-profile-policy.md): Neon CLI com o perfil `junior-pessoal`. Não use o plugin ou conector Neon.
- Nenhuma connection string, senha ou token é impressa, gravada ou colada em chat; a URL do gate vive só nas variáveis de ambiente do processo e é removida ao final.
- Alvo seguro: uma **branch Neon nova e descartável** (schema-only a partir de `production`, expiração de 24 h) com um banco novo, as migrations reaplicadas do zero e apenas dados sintéticos. Nunca copie dados de produção. O procedimento de criação da branch é o do [Gate 4](./gate-4-sales-core.md#passos).
- Não rode dois gates ao mesmo tempo no mesmo banco.

## Passos automáticos

    bun run --filter @polaris/db gates:gate5   # suíte offline (Fase 5)
    bun run --filter @polaris/db gates:all     # tudo

A suíte `gate5` roda, em sequência: `offline-devices`, `offline-lease`, `sync-log`, `bootstrap`, `sync-push`, `offline-product`, `offline-stock`, `offline-sale` e `offline-e2e`. Cada um termina com `"status": "passed"`.

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
| Telas leem do aparelho | Com o runtime pronto, clientes e produtos listam das coleções locais, cadastram sem rede com o selo "Aguardando envio", bloqueiam editar/arquivar/variantes/imagens sem rede ou sem confirmação do servidor, avisam cliente repetido só com dados do aparelho e, numa segunda visita sem rede, mostram o que ficou; ao voltar a rede o servidor confirma e as ações voltam. | `e2e/offline-screens.e2e.ts` (telas reais sobre o runtime real, [ADR 0045](../adr/0045-telas-lendo-do-aparelho.md)), `customers/local-customers.test.ts`, `catalog/local-products.test.ts` |
| Números e invariantes | Totais da venda conferidos em centavos contra um oráculo independente; razão × saldo; saldos nunca negativos; uma saída gravada por comando. | `offline-e2e` |

## Checklist manual em aparelho físico (adiado; bloqueia ligar a escrita offline)

Nada desta lista foi executado. Registre o resultado de cada item com a versão do navegador e do sistema, sem dados reais de clientes.

- [ ] **iPhone real (Safari, e instalado na tela inicial como PWA):** abrir o laboratório offline de persistência, o do outbox e o das coleções locais; confirmar que OPFS e IndexedDB funcionam, que `navigator.storage.persist()` responde e que o armazenamento não é descartado após dias sem uso (política do ITP do Safari para sites não instalados).
- [ ] **Android real (Chrome):** os mesmos laboratórios, e o ciclo completo: criar cliente, produto com estoque, entrada, venda e contagem sem rede; religar a rede; conferir o resultado no servidor.
- [ ] **Telas de clientes e produtos com a chave ligada (build de staging com `VITE_OFFLINE_RUNTIME_ENABLED=true`):** cadastrar um cliente e um produto em modo avião, ver o selo "Aguardando envio", fechar e reabrir o app ainda sem rede (os dois continuam na lista), religar a rede e conferir que o selo some e o servidor tem os dois; tentar editar um deles em modo avião (botão desabilitado, com a razão no cartão).
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
