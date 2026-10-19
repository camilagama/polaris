---
status: accepted
---

# Migrations compatíveis com a versão anterior do Worker (expand/contract)

> O número deste ADR (0096) é o próximo livre na `main` e nos PRs abertos no momento da escrita (o 0095 é o último na `main`); pode mudar se outro entrar antes.

## Contexto

O deploy aplica as migrations **antes** de trocar o Worker (o Worker novo sobre banco antigo falha nas funções novas; [checklist de release, item 3](../runbooks/release-checklist.md)). O rollback de produção (PR 136 do [plano](../../doc/plano-inicial.md), ainda sem runbook) volta só o Worker e os Static Assets e **nunca o schema**. Nas duas pontas, o Worker da versão anterior precisa continuar funcionando sobre o banco já migrado:

- durante o deploy, instâncias da versão anterior ainda atendem requisições depois que a migration terminou e antes de a troca se completar (e, no deploy gradual, por mais tempo);
- depois de um rollback, a versão anterior volta a rodar sobre um banco que já tem todas as migrations da versão revertida.

Uma migration que quebra a versão anterior não tem janela segura: o deploy derruba o que estava no ar, e o rollback, que é a saída de emergência, não conserta nada. O deploy em staging depende desta regra para ser seguro.

## Decisão

### A regra

**Toda migration nova precisa funcionar com o Worker da versão imediatamente anterior ainda no ar**, lendo e escrevendo como lia e escrevia antes dela. Vale para o código do Worker (`apps/web`, `apps/admin`, catálogo), para as funções e políticas do banco que ele chama e para o app no navegador que ainda fala com o servidor novo ([Gate 5](../runbooks/gate-5-offline.md#ordem-de-publicação)).

### O padrão expand/contract

Uma mudança que não é aditiva se faz em fases, cada uma num deploy próprio:

1. **Expand (migration A):** só adiciona. Coluna `NULL`able ou com `DEFAULT`, tabela, índice, função nova com nome novo, valor novo de enum. O Worker anterior ignora o que adicionou.
2. **Código novo (deploy do Worker B):** passa a escrever nos dois lugares (o antigo e o novo) e a ler do novo com fallback para o antigo, quando a leitura for possível.
3. **Backfill:** preenche o que as linhas antigas não têm, em lotes, fora da transação da migration quando a tabela for grande, e confere por consulta que não sobrou linha sem valor.
4. **Troca de leitura:** o código passa a ler só do novo. O antigo ainda é escrito, para que um rollback do Worker continue vendo dados corretos.
5. **Contract (migration C, depois):** remove o antigo (coluna, função, restrição) e aplica `NOT NULL`, só **depois que nenhuma versão no ar, nem a que um rollback restauraria, usa o objeto**. Na prática: pelo menos um deploy depois do passo 4, com a versão que parou de usar o objeto já em produção e fora da janela de rollback combinada para ela. O PR da migration C diz qual versão parou de usar e desde quando.

### Proibido no mesmo deploy em que o código deixa de usar o objeto

| Mudança | Por que quebra a versão anterior | Como fazer |
| --- | --- | --- |
| Renomear coluna, tabela, restrição ou função | A versão anterior procura o nome antigo (restrição renomeada também: o código mapeia erro por nome de restrição) | Adicionar o nome novo, escrever nos dois, remover o antigo na migration C |
| Apagar coluna ou tabela | `SELECT` e `INSERT` da versão anterior falham | Parar de usar, esperar, apagar na migration C |
| `NOT NULL` sem `DEFAULT` (`ADD COLUMN ... NOT NULL` ou `SET NOT NULL`) | O `INSERT` da versão anterior não manda a coluna e falha | Coluna `NULL`able, backfill, `SET NOT NULL` na migration C (ou `DEFAULT` desde o início) |
| Mudar o tipo de uma coluna | A versão anterior lê e escreve o tipo velho; a conversão reescreve a tabela com bloqueio | Coluna nova com o tipo novo, escrever nos dois, backfill, remover a antiga |
| Apagar ou mudar a assinatura de função usada pelo Worker anterior (inclui `SECURITY DEFINER`) | A chamada da versão anterior falha com `function does not exist` | Criar a função nova com outro nome (ou assinatura nova ao lado da antiga) e remover a antiga na migration C |

Também contam, e a checagem automática não as vê (nem `DROP TYPE`, `DROP VIEW` ou `DROP SCHEMA` de objeto que a versão anterior use): reduzir o que um papel de runtime pode ler ou executar (`REVOKE`, política RLS mais restritiva) em algo que a versão anterior usa; mudar o significado de um valor existente; `CHECK` ou `UNIQUE` novo que linhas escritas pela versão anterior violariam; e `CREATE OR REPLACE FUNCTION` que muda o comportamento ou o tipo de retorno. Adicionar valor a enum é aditivo, mas o Worker anterior pode não conhecer o valor ao lê-lo: o código deve tratar valor desconhecido.

### Exceções

- **Migrations já mescladas antes do go-live (até a 0077).** Não havia versão anterior em produção, e o replay do zero é o caminho. Não são checadas. O limite é a constante `LAST_GRANDFATHERED` em `scripts/verify-migration-compat.mjs`; não se sobe esse número para "passar" uma migration nova.
- **Migration que não pode ser compatível** (troca de tipo de uma tabela pequena em janela combinada, correção de dado que a versão anterior reintroduziria): exige **janela**, marcada com uma linha de comentário no próprio arquivo `.sql`, com o motivo:

  ```sql
  -- expand-contract: janela <por que não dá para expandir/contrair e como a janela é feita>
  ```

  O PR descreve a janela (quando, quanto tempo, quem executa, como o Worker é segurado ou o tráfego, pausado), o plano de volta e quem autorizou. A janela é decisão do responsável; a marcação só a torna explícita e revisável.
- **Migration C (contract)** é compatível por construção, porque nenhuma versão no ar usa o objeto. Ela também tem de ser marcada, para o motivo ficar registrado e o revisor conferir:

  ```sql
  -- expand-contract: contract <versão ou PR que parou de usar o objeto, e desde quando está em produção>
  ```

O marcador vale para o arquivo inteiro e exige texto depois do tipo (`contract` ou `janela`); marcador vazio não passa. O script também reprova um `.sql` que não se chame `NNNN_nome.sql`, para um número errado não escapar. A qualidade do motivo é conferida na revisão; o CI cobre o script pelo teste dele no job de testes (o workflow não ganhou passo próprio).

### Como checar

1. **Lista na descrição do PR de migration** (na seção Risco; a caixa do Checklist do template remete a ela e o item 3 do checklist de release a confere):
   - [ ] A migration funciona com o Worker da versão anterior (e com o do rollback combinado)?
   - [ ] Só adiciona (coluna `NULL`able ou com `DEFAULT`, tabela, índice, função nova)? Se não, qual é a fase de expand/contract e qual migration anterior fez o expand?
   - [ ] Nenhum `RENAME`, `DROP`, `SET NOT NULL`, mudança de tipo ou função apagada/alterada que o Worker anterior chame; ou o marcador `contract`/`janela` com o motivo?
   - [ ] `REVOKE`, política RLS, `CHECK` ou `UNIQUE` novos não quebram o que a versão anterior escreve ou lê?
   - [ ] Backfill, se houver: em lotes, com a consulta que prova que acabou.
2. **Script `scripts/verify-migration-compat.mjs`** (`bun run migrations:compat`, também na cadeia de `bun run check` e coberto pelo teste `verify-migration-compat.test.mjs`, que roda no job de testes do CI). Em toda migration depois da 0077, reprova `DROP COLUMN` (com ou sem a palavra `COLUMN`), `DROP TABLE`, `DROP FUNCTION`/`PROCEDURE`/`ROUTINE`, qualquer `RENAME` em `ALTER`, `SET NOT NULL`, `ALTER COLUMN ... TYPE` e `ADD COLUMN ... NOT NULL` sem `DEFAULT`, a menos que o arquivo tenha o marcador. É uma busca textual, não um parser: lê também o corpo de blocos `DO` e de funções (um `DROP COLUMN` num corpo de função é um falso positivo; o marcador resolve), mas não enxerga SQL dinâmico (`EXECUTE format(...)`) nem `CREATE OR REPLACE FUNCTION` que muda a assinatura; a lista do PR cobre esses casos. O teste exige que o próprio repositório passe.
3. **Gate de banco (futuro, opcional).** Um gate que sobe o schema da migration e roda os comandos do Worker anterior (a suíte de gates do commit anterior) provaria a compatibilidade de verdade. Fica fora deste ADR: custa um segundo checkout no CI e depende de o deploy contínuo existir.

### Relação com o rollback e o runbook de release

- O rollback do PR 136 volta só o Worker. Esta regra é o que o torna seguro: o banco migrado precisa servir a versão revertida. Nenhum rollback é "voltar a migration"; o conserto de uma migration ruim é uma migration nova (forward-fix).
- O item 3 do [checklist de release](../runbooks/release-checklist.md) ganha a exigência de classificar cada migration pendente como compatível, contract ou janela, e de bloquear quando a classificação faltar. O item 7 (critérios de rollback) passa a citar este ADR.
- A ordem do deploy não muda: migration, depois Worker. Esta regra só garante que ela é segura nos dois sentidos.

## Alternativas descartadas

- **Janela de manutenção a cada migration:** simples, mas custa disponibilidade e não resolve o rollback (a versão anterior continua incompatível com o banco).
- **Rollback que desfaz a migration (`down`):** o Drizzle não gera `down`; reverter o schema com dados novos perde dado ou falha, e o plano já diz que o rollback é só do Worker e do app, nunca de schema automático (PR 136).
- **Implantar Worker e migration juntos, em ordem inversa:** o Worker novo sobre banco antigo falha nas funções novas; a ordem atual (migration primeiro) é a segura para o aditivo.
- **Só a lista no PR, sem script:** depende de atenção; o script é barato e pega o erro comum. A lista continua para o que o script não vê.
- **Parser de SQL completo:** custo e dependência (aprovação de dependência nova) desproporcionais para uma busca textual que errar para mais só pede um marcador.

## Consequências

- Mudanças não aditivas levam pelo menos duas migrations e dois deploys. O custo é aceito: é o preço do rollback seguro.
- O revisor confere o marcador e a lista no PR; o marcador sem motivo real é achado "bloqueia".
- Quando o go-live acontecer, a exceção das migrations antigas deixa de crescer: toda migration nova entra na regra.
- O script pode reprovar um uso legítimo (por exemplo, `DROP TABLE` de uma tabela temporária da própria migration); nesse caso o marcador `janela` ou `contract` com o motivo resolve, e o motivo fica registrado.
