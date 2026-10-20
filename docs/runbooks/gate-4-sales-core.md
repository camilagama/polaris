# Gate 4 — núcleo de vendas (Fase 4)

Gatilho: fechamento da Fase 4 (clientes e vendas online, PR36–PR47) e qualquer mudança posterior em venda, estoque de venda, cancelamento, devolução, atribuição de cliente ou datas da venda.

O Gate 4 prova seis propriedades: venda atômica, estoque correto, dinheiro correto, cancelamento correto, devoluções corretas e reconciliação de cliente que não altera a economia. Ele combina os gates por etapa (profundidade, cada mecanismo isolado) com um cenário ponta a ponta (composição, tudo junto, contra um oráculo independente).

## Execução padrão: PostgreSQL 18 local ou do CI

O Gate 4 roda como os demais gates de banco: num PostgreSQL 18 que não é o Neon. No pull request, quem roda é o job "PostgreSQL 18 gates" do CI (`bun run --filter @polaris/db gates:ci`); não há passo manual nem acesso a Neon. Para reproduzir ou depurar antes do push, rode o mesmo numa instância local.

**O que a suíte `ci` cobre e o que só roda em Neon.** A suíte `ci` inclui `inventory`, `customers`, `media-upload`, `tenant-context` e `rls`, que antes ficavam de fora pela trava de hostname. As propriedades de venda do Gate 4 (venda, cancelamento, devolução, vínculo de cliente, datas e o cenário ponta a ponta `gate4`) e o `customers` do executor rodam no CI. O que continua só em Neon está em [O que só roda em Neon](#o-que-só-roda-em-neon).

### Pré-requisitos

- PostgreSQL 18 em `localhost` (por exemplo, um container `postgres:18`, como o do CI), com o dono `neondb_owner` e um banco vazio e descartável (`polaris_gate`). Nunca aponte para um banco com dados que importem: as migrations e os gates escrevem no banco, e os gates de falha injetada criam gatilhos nele.
- Cliente `psql` e `docker` (ou outro PostgreSQL 18 em `localhost`). Não é preciso CLI Cloudflare ou Neon, nem credencial alguma além da senha do PostgreSQL local, que fica só nas variáveis do processo.
- O executor só aceita um host da lista de `packages/db/scripts/gate-hosts.ts`: um endpoint Neon direto em São Paulo, ou `localhost`/`127.0.0.1` com `CI=true`; qualquer outro é recusado antes de abrir conexão (teste em `gate-target.test.ts`). Fora do CI, o `CI=true` vai só no prefixo dos comandos do executor, como abaixo.
- Não rode dois gates ao mesmo tempo no mesmo banco: os gates de falha injetada criam gatilhos nas tabelas compartilhadas e contaminam a execução do outro.

### Passos

1. Subir o PostgreSQL 18 e preparar o ambiente do processo (valores iguais aos do job do CI; a senha abaixo é a do container descartável do CI, não um segredo):

       docker run -d --rm --name polaris-gate-pg -p 5432:5432 -e POSTGRES_USER=neondb_owner -e POSTGRES_PASSWORD=polaris-ci -e POSTGRES_DB=polaris_gate postgres:18
       until pg_isready -h localhost -U neondb_owner -d polaris_gate; do sleep 1; done
       export DATABASE_URL=postgresql://neondb_owner:polaris-ci@localhost:5432/polaris_gate
       export POLARIS_GATE_DATABASE_URL="$DATABASE_URL"
       export POLARIS_GATE_BRANCH=pr0-local-gate
       export POLARIS_GATE_DATABASE=polaris_gate

   `POLARIS_GATE_BRANCH` precisa casar `^pr\d+-[a-z0-9-]+-gate$`; fora do Neon é só um rótulo.
2. Criar a role que vive fora das migrations (no Neon ela vem da `production`; aqui não existe) e aplicar as migrations do zero:

       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE ROLE polaris_pr11_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS"
       bun run --filter @polaris/db db:migrate

3. Rodar o executor, que roda **em sequência** no mesmo banco, cria o login temporário que alguns gates exigem e o remove ao final:

       CI=true bun run --filter @polaris/db gates:ci   # o que o CI roda, incluindo os gates de venda e o gate4

   `gates:gate3` e `gates:all` incluem o `gate2-runtime`, só de Neon, e falham num PostgreSQL local (`gates:gate4` roda local). Para um subconjunto, escolha gates pelo nome: `CI=true bun scripts/run-gates.ts sale-return gate4` (a partir de `packages/db`). Cada gate termina com `"status": "passed"`; o executor imprime só o resumo (e a cauda redigida de um gate que falhar), nunca a URL.
4. Para repetir do zero, derrube o container (`docker stop polaris-gate-pg`) e suba outro; as migrations são sempre reaplicadas desde a 0000. Remova as variáveis do processo ao final (`unset DATABASE_URL POLARIS_GATE_DATABASE_URL POLARIS_GATE_BRANCH POLARIS_GATE_DATABASE`).

Gates avulsos continuam existindo (`poc:sales:verify`, `poc:sales:transaction:verify`, `poc:sales:customer-link:verify`, `poc:sales:cancellation:verify`, `poc:sales:return:verify`, `poc:sales:dates:verify`, `poc:gate4:verify`, `poc:review-hardening:verify`) e usam as variáveis `POLARIS_SALES_GATE_*`; o executor é o caminho recomendado.

## O que só roda em Neon

Dois itens, cada um por um motivo que o PostgreSQL local não resolve:

| Item | Por que só em Neon |
| --- | --- |
| `gate2-runtime` | Prova o onboarding e o RLS de Categories contra o Worker local com duas bindings Hyperdrive e papéis de login do Neon. Tem a trava de host de Neon própria e, num PostgreSQL local, falha numa verificação de papéis e privilégios (visto em 19/10/2026 com a trava de host afrouxada; a causa não foi investigada, fora do escopo do T-122a). |
| Caminho Worker, Hyperdrive e Neon (`poc:rls:verify` pelo Worker remoto) | A suíte `ci` roda o mesmo gate de RLS (`rls`), com a mesma rota e as mesmas transações, contra um servidor local que fala direto com o PostgreSQL. Isso prova a política, `FORCE RLS`, leitura e escrita entre tenants, rollback, contexto local à transação e o retry depois de matar o backend. Não prova o pool do Hyperdrive (reuso de backend entre tenants), o cache de SQL desligado nem a região: o relatório do `rls` local diz `not_applicable_local` nesses campos, e o gate com Worker remoto segue na prova de liberação. |

O `rls` só roda contra o PostgreSQL local (`localOnly` no executor): `gates:all` num Neon o deixa de fora, e pedi-lo pelo nome num Neon é erro.

## Corridas: quando o `gates:concurrency` é obrigatório

O job `PostgreSQL 18 gates` do CI roda `gates:ci` com **1 rodada** de cada corrida; corrida intermitente é justamente o que 1 rodada não pega. Por isso a suíte `gates:concurrency` (as corridas da [matriz de concorrência](../architecture/concurrency-matrix.md), **N = 3 rodadas**, o padrão da suíte) é obrigatória em dois momentos, sem job novo no CI:

- **Em todo PR que mexa numa proteção listada na matriz** (um lock, um índice único, a ordem de lock, um gatilho ou uma função que uma corrida da matriz prova): o autor roda `CI=true bun run --filter @polaris/db gates:concurrency` num banco novo e registra o resultado na seção "Verificação" do PR. Se o PR é de outra área (sem PostgreSQL local), a área db ou o Arrascaeta roda antes do merge e registra o resultado no PR; o CI sozinho (1 rodada) não cumpre a regra. Mudou a corrida ou criou uma proteção nova: a linha da matriz muda no mesmo PR.
- **Antes de cada prova de release** (item 4 do [checklist de release](./release-checklist.md#4-gates-de-banco-em-neon-descartável-block)): `gates:concurrency` com 3 rodadas, num PostgreSQL 18 descartável e novo, a partir do SHA candidato, além da suíte `all` em Neon.

Mais rodadas (`POLARIS_CONCURRENCY_REPEAT=10`, o máximo) servem para investigar uma corrida que falhou de vez em quando; não são exigência.

## Propriedade modelo × PostgreSQL (estoque e devolução)

O gate `stock-property` (`packages/db/scripts/verify-stock-property-gate.ts`, nas suítes `ci`, `gate4` e `all`) gera com fast-check sequências de comandos nomeados (recebimento, venda, baixa, contagem, devolução e cancelamento, o estorno da venda inteira) sobre duas variantes de uma organização nova a cada sequência. Cada comando passa pelas funções reais do repositório como o papel do runtime (`FORCE RLS` e os gatilhos deferidos do commit) e por um **modelo em memória** escrito no próprio gate. O modelo não importa o domínio: a média é aritmética própria em micro-reais, meio-para-cima em 6 casas, com as regras de [estoque](../business-rules/inventory.md#custo-médio) e da [reposição](../business-rules/inventory.md#reposição-por-cancelamento-ou-devolução).

**Gerador.** As quantidades são sorteadas em relação ao estado (de 1 até o que existe; o sorteio 0 leva tudo, para o saldo chegar a zero com frequência), então a maior parte dos comandos é válida. Um em oito pede de propósito mais do que há (`overdraw`), uma contagem em sete manda uma versão velha, que o saldo já deixou para trás (a anterior à atual; com o saldo na versão 0, que não tem anterior, a seguinte), e as contagens com valoração e os recebimentos sobre média desconhecida exercitam as recusas de custo; o modelo prevê o resultado de cada comando (aceito ou o código do erro). As linhas de uma devolução vão ao servidor na ordem sorteada, e o modelo repõe por posição, como o servidor. Oito sequências fixas (`examples`) rodam sempre antes das sorteadas:

- a venda de custo desconhecido que volta, por cancelamento e por devolução, a um saldo zero de média já conhecida. Esse caso pede uns seis comandos numa ordem só, e o sorteio não chegou nele em 400 sequências;
- a devolução de duas linhas da mesma variante enviadas fora da ordem de posição;
- as bordas de grandeza, que o sorteio não alcança (recebimentos de 1 a 6 unidades e custos de uma lista de seis valores): o recebimento até o teto exato de `MAX_INVENTORY_QUANTITY` (2.147.483.647), o seguinte acima do teto e um recebimento único acima dele, ambos recusados com `inventory_quantity_limit`; a venda do teto inteiro, devolvida em partes (uma delas pedindo mais do que resta) e cancelada de volta ao teto; o teto inteiro recebido, vendido e devolvido (e reposto) numa só linha, que prova o limite inclusivo de `isQuantity` em `sale-return.ts`; e custos de 18 dígitos inteiros (aceito, inclusive na média ponderada com 2 bilhões de unidades) e de 19 (recusado com `inventory_cost_limit`).

**Invariantes** (conferidos depois de cada comando, I1 e I6, e ao final, os demais):

| # | Invariante |
| --- | --- |
| I1 | Quantidade, custo médio e versão do saldo de cada variante são os do modelo. |
| I2 | O razão de cada variante, na ordem de `variant_sequence`, é o do modelo: tipo, delta e custo unitário de cada movimento. |
| I3 | A quantidade do saldo é a soma dos deltas do razão e nunca é negativa. |
| I4 | O disponível para devolver de cada item é o vendido menos o já devolvido. |
| I5 | Uma venda é cancelada ou tem devoluções, nunca as duas; o cancelamento é único. |
| I6 | Um comando recusado (estoque, versão, custo, disponível, venda cancelada ou com devoluções) falha com o código que o modelo prevê e não deixa rastro. |

**Custo e execução.** Medido no PostgreSQL 18.4 local em 20/10/2026, de 0,5 a 0,7 s por sequência:

| Quando | Sequências | Tempo |
| --- | --- | --- |
| Todo PR (`gates:ci`) | 20 sorteadas, o padrão, mais as 8 fixas | de 10 a 13 s |
| Execução longa | `POLARIS_PROPERTY_RUNS=500` (máximo 2000, o que cabe nos 30 min em que o executor para um gate) | cerca de 5 min |

A execução longa não tem job: nenhum workflow novo foi criado, e um agendamento semanal fica com quem altera `.github/workflows`. Ela é **obrigatória** em PR que mexa em estoque, venda, devolução, cancelamento ou custo médio, e o autor registra o resultado (a semente e o `passed`) em "Verificação" do PR: 20 sequências deixam passar uma quebra comum em cerca de uma execução em cinco (medido em 20/10/2026 com 5 sementes por quebra). Quem não pode subir o PostgreSQL (tarefa fora da área `db`) diz no PR que a execução longa ficou pendente e pede a quem roda gates de banco. Ela também é BLOCK no item 4 do [checklist de release](./release-checklist.md#4-gates-de-banco-em-neon-descartável-block). Rode à mão num banco descartável (como em [Passos](#passos)):

    CI=true POLARIS_PROPERTY_RUNS=500 bun scripts/run-gates.ts stock-property   # a partir de packages/db

**Semente e reprodução.** Cada execução sorteia uma semente nova e a imprime na primeira linha (`seed=...`) e na linha `note:` do executor, que a repete no JSON final (`results[].notes`) também quando o gate passa, então o CI explora sequências diferentes a cada PR e fica registrado quais já passaram. Na falha, as últimas linhas (as que o executor mostra) trazem a **sequência mínima** em comandos concretos até o comando que falhou, o motivo e, por último, o comando que reproduz a falha:

    CI=true POLARIS_PROPERTY_SEED=<semente> POLARIS_PROPERTY_PATH=<caminho> bun scripts/run-gates.ts stock-property

**Reexecutar o job não limpa a falha:** a semente muda e o defeito continua, só que numa sequência que talvez o sorteio não repita. O procedimento é abrir um item (issue com a etiqueta `bots`) com a linha `replay:` e investigar a falha, e não repetir o job até passar.

Uma falha ao preparar uma sequência (banco fora do ar, organização ou produto que não se cria) não é tratada como contraexemplo: o gate para sem encolher e mostra o erro. Uma queda no meio de uma sequência ainda aparece como resultado `sql:...` ou `error:...` de um comando e é encolhida como uma falha comum.

**Limites.** O gate não cobre:

- produto removido, plano Free (variantes não operacionais), replays e conflitos de `commandId`;
- corridas (a suíte `gates:concurrency` cobre);
- dinheiro: as vendas não têm perfil de pagamento nem ajustes, porque o gate olha estoque e devolução;
- o espaço de valores do sorteio: 2 variantes, vendas e devoluções de até 2 linhas, até 16 comandos, quantidades de 1 a 6 por recebimento e seis custos. O que depende de uma grandeza fora dele (o teto de quantidade, o limite de 18 dígitos de custo) só é visto pelos exemplos fixos, e uma sequência rara e longa também depende de exemplo fixo.

**Prova por quebra** (20/10/2026, local, descartada; semente 20261020):

| Quebra no código | Resultado |
| --- | --- |
| Devolução limitada ao vendido, e não ao disponível (`planSaleReturn`) | Com 60 sequências, falhou na 39ª. A mínima recebe 1, vende 1, devolve 1 e devolve 1 de novo: o banco recusou no commit (`sql:23514`) onde o modelo esperava `sale_return_exceeds_available`. |
| Reposição de custo desconhecido em saldo zero mantém a média antiga (o comportamento anterior à revisão do Gate 4) | Falhou no exemplo fixo (6 comandos): média `1.500000` onde o modelo diz desconhecida. Sem o exemplo fixo, 60, 150 e 400 sequências sorteadas não pegaram. O `review-hardening` cobre o mesmo caso com um cenário escrito à mão. |
| Média truncada em vez de meio-para-cima | Com 60 sequências, falhou na 7ª. A mínima recebe 1 a 0, 1 a 0 e 4 a 1: a média ficou `0.666666` onde o modelo diz `0.666667`. |
| Contagem que aceita versão velha (`!==` vira `<` em `inventory-repository.ts`) | Com 20 sequências, 5 sementes de 5 falharam (`I6`: o modelo espera `inventory_version_conflict`, o banco aceitou). Com a versão do futuro que o gate mandava antes, a quebra passava em 5 de 5. |
| Teto de quantidade que recusa o valor exato (`nextQuantity > MAX` vira `>=` em `projectInventoryQuantity`) | Com 20 sequências, 5 sementes de 5 falharam, no exemplo fixo do teto exato. O sorteio nunca chega lá. |
| Limite de custo deslocado (`whole.length > 18` vira `>= 18`, e vira `> 19`) | As duas falharam nos exemplos fixos de 18 e de 19 dígitos (o `>= 18` recusou o custo de 18 dígitos que devia ser aceito; o `> 19` aceitou, e o banco recusou com `sql:23514`, o de 19). |
| Teto de quantidade da devolução que recusa o valor exato (`<=` vira `<` em `isQuantity`, `sale-return.ts`) | Falhou no exemplo fixo do teto devolvido numa só linha (semente 706652766, 3 comandos): o modelo espera `ok` e o servidor respondeu `invalid_sale_return`. Antes desse exemplo a quebra escapava: nenhum exemplo devolvia o teto inteiro numa só linha. |

O próprio exemplo das linhas fora de ordem nasceu de um defeito do **modelo**, achado na revisão: o modelo repunha na ordem enviada, e o servidor repõe por posição. O exemplo falhou antes da correção do modelo e passa depois.

## Prova antes de liberação em Neon

O Neon serve só para a prova que o PostgreSQL local e o CI não dão: o provedor real (papéis, hostnames e o caminho Worker, Hyperdrive e Neon). Ela roda **antes de uma liberação** e, como o ADR 0025 já pedia, no fim de cada fase e quando mudam o executor (`run-gates.ts`), o suporte comum dos gates (`sales-gate-support.ts`) ou os privilégios de forma ampla ([ADR 0025](../adr/0025-estrategia-de-testes-de-banco.md), emendas da issue #115). Por pull request **não** se roda nada em Neon: o job do CI roda a suíte `ci`; o `gate2-runtime` e a prova de Hyperdrive ficam para esta prova. Um PR que mude o executor (`run-gates.ts`), o suporte comum (`sales-gate-support.ts`, `concurrency-support.ts`) ou privilégios de forma ampla **não** roda esta prova antes do merge: por decisão do Arrascaeta (POL-14, 18/10/2026), ninguém tem credencial Neon de teste no dev e não se cria branch-raiz. A mudança vira **pendência da próxima prova de release em Neon**, registrada no item 4 do [checklist de release](./release-checklist.md#4-gates-de-banco-em-neon-descartável-block), e essa prova a confere antes de promover. O fim de fase e a liberação rodam depois do merge, antes de fechar a fase ou de promover. Nas fases já fechadas (3 e 4), um PR que quebre o `gate2-runtime` ou o caminho Hyperdrive é pego na prova de liberação (item 4 do checklist, BLOCK): não escapa, só chega mais tarde.

### Regras da branch

- **Uma branch descartável, filha de `production`, sem `--schema-only`.** Uma branch `--schema-only` não herda a história da `production`: nasce como **raiz**, e as branches raiz contam no armazenamento do projeto (e no limite de branches raiz do plano). Segundo a decisão do responsável, foi esse o procedimento antigo (uma raiz por execução) que inflou o contador do projeto de gates, embora o banco real tenha poucos MB (a emenda do ADR 0025 cita a leitura de 17/10/2026 e deixa em aberto, por falta de confirmação no console, se o medidor que estourou foram as raízes ou o histórico de restauração). Uma branch filha compartilha as páginas do pai e só acrescenta o que o gate escreve; se o limite voltar a estourar mesmo assim, a primeira prova de liberação servirá de medida e a causa será reaberta.
- **Nome único por execução**, no padrão `^pr\d+-[a-z0-9-]+-gate$` (por exemplo, `pr900-release-gate`; se repetir o número, acrescente a data, como `pr900-release-20261018-gate`). Nunca reutilize uma branch de outra execução, nem uma expirada; nunca rode duas execuções na mesma branch.
- **Apagada ao final da própria execução**, com sucesso ou falha, e só a que você criou. Expiração de 24 h como rede de segurança, não como substituta.
- Um banco novo (`polaris_prNN_gate`) é criado dentro da branch e as migrations (0000 em diante) são reaplicadas nele do zero: a prova de "migrations do zero" continua valendo mesmo com a branch herdando o estado da `production`. O operador cria o banco novo e reaplica nele as migrations; o gate lê e escreve **só** nesse banco novo, nunca nos bancos herdados. A `production` aqui é a do **projeto Neon descartável dos gates**, que só tem dados sintéticos. **É proibido** fazer esta prova num projeto Neon com dados reais de clientes (o de produção do Polaris): a branch filha herdaria esses dados. Se o projeto dos gates um dia passar a ter dados reais, pare e peça decisão ao responsável.
- Siga a [política de perfis de CLI](./cli-profile-policy.md): Neon CLI com o perfil `junior-pessoal`. Não use o plugin ou conector Neon. Nenhuma connection string, senha ou token é impressa, gravada em arquivo ou colada em chat; a URL do gate vive só nas variáveis de ambiente do processo e é removida ao final.
- A suíte completa por fase é disparada por quem entrega o último PR da fase (ou pelo responsável) e fica registrada numa linha "Suíte completa em Neon" na seção da fase em `doc/status-implementacao.md`.

### Passos

1. Criar a branch filha e o banco (descarte a saída: o comando `neon branches create` imprime a connection string). **Sem `--schema-only`.** Antes, exporte `NEON_PROJECT_ID` com o ID do projeto Neon dos gates, lido fora do repositório (ver a [política de perfis de CLI](./cli-profile-policy.md#identificadores-pessoais-fora-do-versionamento)).

       neon branches create --name pr900-release-gate --parent production --expires-at <agora+24h, UTC, hora cheia> --project-id "$NEON_PROJECT_ID" --profile junior-pessoal > /dev/null
       neon databases create --name polaris_pr900_gate --owner-name neondb_owner --branch pr900-release-gate --project-id "$NEON_PROJECT_ID" --profile junior-pessoal > /dev/null

2. Em um processo que obtenha a URL direta (sem pooler) com `neon connection-string ... --database-name polaris_pr900_gate --role-name neondb_owner --profile junior-pessoal`, exporte somente neste processo `DATABASE_URL`, `POLARIS_GATE_DATABASE_URL`, `POLARIS_GATE_BRANCH` e `POLARIS_GATE_DATABASE`. Confirme que o host tem o formato `ep-…sa-east-1.aws.neon.tech`, sem `pooler`.
3. Aplicar as migrations do zero no banco novo (a role `polaris_pr11_runtime` já existe: vem da `production`; ver o checklist de go-live): `bun run --filter @polaris/db db:migrate`.
4. Rodar o executor sem `CI=true` (a trava de host exige o endpoint Neon): `bun run --filter @polaris/db gates:all` para a prova de liberação. Aqui rodam também os quatro gates que o CI não cobre.
5. Limpar o ambiente do processo (todas as variáveis acima) e apagar a branch própria, mesmo se um gate falhou: `neon branches delete pr900-release-gate --project-id "$NEON_PROJECT_ID" --profile junior-pessoal`. Confira com `neon branches list` que ela sumiu e registre o nome e a data na evidência (sem connection string).

## O que prova cada propriedade

| Propriedade | Gate por etapa (profundidade) | Cenário ponta a ponta (`poc:gate4:verify`) |
| --- | --- | --- |
| Venda atômica | `poc:sales:transaction:verify`: falha injetada em cada ponto da transação com rollback conjunto, corridas do mesmo `commandId`, gatilhos deferidos que recusam venda parcial. `poc:sales:verify`: agregado sem venda parcial. | Venda com a segunda linha sem estoque não deixa cabeçalho, item, pagamento, movimento, saldo nem auditoria; repetir uma venda confirmada não muda nada. |
| Estoque correto | Ordem de locks sem deadlock, saldo nunca negativo, custo médio, movimento por item no custo do snapshot. | Um movimento `sale` por item ao custo do snapshot, saldos 47 e 18, média intocada, e o razão explica todos os saldos depois de cada etapa. |
| Dinheiro correto | Biblioteca de dinheiro (PR39), ajustes (PR40), pagamentos (PR41), perfis (PR42): decimal exato, meio-para-cima uma vez por valor. | Subtotal, desconto, frete e total devido coincidem com um oráculo independente em centavos inteiros e com as linhas persistidas; o pagamento único é igual ao total. |
| Cancelamento correto | `poc:sales:cancellation:verify`: reposição ao custo do item, regra da média, corridas cancelamento × cancelamento e × venda, gatilho de completude. | Quantidade inteira volta ao estoque ao custo original, a venda e os movimentos originais não são editados, repetir o comando é replay, a venda cancelada mantém os totais e não aceita devolução. |
| Devoluções corretas | `poc:sales:return:verify`: `returned ≤ disponível`, `restocked ≤ returned`, sequência aleatória contra um modelo, exclusão mútua com o cancelamento, guardas do banco. | Devolvido e reposto são separados, só o reposto movimenta estoque, devolução acima do disponível é recusada, venda com devoluções não cancela, a venda nunca é editada. |
| Estoque e devolução sob sequências geradas | `stock-property`: sequências de recebimento, venda, baixa, contagem, devolução e cancelamento contra um modelo em memória ([seção própria](#propriedade-modelo--postgresql-estoque-e-devolução)). | (coberto pelo gate próprio) |
| Reconciliação de cliente não altera a economia | `poc:sales:customer-link:verify`: histórico versionado, concorrência, cliente arquivado. | Atribuir, reatribuir, conflito de versão e remover (inclusive em venda cancelada) mantêm vendas, itens, ajustes, pagamentos, movimentos e saldos idênticos byte a byte. |
| Endurecimentos da revisão do checkpoint | `poc:review-hardening:verify`: instantes `timestamptz` mesmo com fuso de sessão +14h, timeouts por transação, sequência e reconciliação razão × saldo, cancelamento com produto removido, regra da média na reposição, namespaces de commandId, datas de estoque, grants por coluna, limites, chave de mídia, roles auth × tenant, funções endurecidas. | (coberto pelo gate próprio) |
| Datas (PR47) | `poc:sales:dates:verify`: janela retroativa no calendário da organização e tolerância de futuro (valores em [tempo e datas](../business-rules/time-and-dates.md)), data do razão = data comercial, replay e conflito de `recorded_at`. | Venda de 10 dias atrás grava o movimento na sua data comercial. |

## Limites conhecidos

- Os gates não cobrem a interface no navegador: os modelos de visão têm testes unitários, mas não houve verificação ponta a ponta nem em 360 px nesta fase.
- Só existe o papel `owner`; a janela retroativa por papel e a capability de cada operação só foram exercidas para ele.
- O replay de uma venda **fora** da janela retroativa é provado envelhecendo a linha como dono da tabela (o runtime nunca consegue editá-la); o envelhecimento natural pelo calendário não é observável num gate.
- Não há reembolso nem valor monetário de devolução: a decisão do projeto é que o impacto em vendas líquidas pertence ao motor de métricas.

## Rollback ou forward-fix

O gate não altera recursos persistentes: ele roda só no PostgreSQL local ou do CI e, na prova de liberação, só na branch Neon descartável própria. Se um gate falhar, não prossiga para a próxima etapa; corrija na etapa dona do mecanismo, repita o gate falho e depois todos os anteriores. Escalonamento: responsável pelo projeto.
